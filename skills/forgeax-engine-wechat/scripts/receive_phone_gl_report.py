#!/usr/bin/env python3
"""Receive one source-bound phone diagnostic over an explicitly prepared ADB reverse."""
import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
import os
from pathlib import Path
import re
import socket
import threading
import time

from diagnose_phone_startup import validate_report_url

MAX_BYTES = 24 * 1024 * 1024
SOURCE_LIMIT = 2 * 1024 * 1024
TOTAL_SOURCE_LIMIT = 16 * 1024 * 1024
REPORT_KINDS = ('forgeax-phone-gl-link', 'forgeax-phone-startup')
STARTUP_MAX_BYTES = 2 * 1024 * 1024


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def require_hash(value):
    if not isinstance(value, str) or re.fullmatch('[0-9a-f]{64}', value) is None:
        raise ValueError('expected a lowercase SHA-256 digest')
    return value


def validate_report(body, expected_hash, source, kind='forgeax-phone-gl-link'):
    require_hash(expected_hash)
    if not hmac.compare_digest(sha256(body), expected_hash):
        raise ValueError('report SHA-256 mismatch')
    report = json.loads(body.decode('utf-8'))
    checkpoint = (kind == 'forgeax-phone-startup' and isinstance(report, dict)
                  and report.get('kind') == 'forgeax-phone-startup-checkpoint')
    if kind not in REPORT_KINDS or not isinstance(report, dict) or (not checkpoint and report.get('kind') != kind):
        raise ValueError('unexpected report kind')
    if report.get('source') != source:
        raise ValueError('report publication identity mismatch')
    if not checkpoint and (not isinstance(report.get('reason'), str) or not isinstance(report.get('finishedAt'), (int, float))):
        raise ValueError('report has not terminated')
    if kind == 'forgeax-phone-startup':
        if not isinstance(report.get('runId'), str) or re.fullmatch('[a-f0-9]{32}', report['runId']) is None:
            raise ValueError('invalid startup run identity')
        if len(body) > STARTUP_MAX_BYTES:
            raise ValueError('startup report size limit exceeded')
        if checkpoint:
            if (type(report.get('sequence')) is not int or not 1 <= report['sequence'] <= 32
                    or type(report.get('at')) not in (int, float) or not math.isfinite(report['at'])
                    or 'finishedAt' in report or 'reason' in report):
                raise ValueError('invalid nonterminal checkpoint')
        elif report['reason'] not in ('startup-failed', 'scene-presented', 'host-stopped', 'host-hidden',
                                    'inspection-unavailable', 'inspection-failed', 'deadline',
                                    'generation-changed', 'scene-left-ready',
                                    'invalid-frame-counters', 'frame-counters-regressed',
                                    'wx.onError', 'wx.onUnhandledRejection', 'package-entry-control'):
            raise ValueError('unexpected startup terminal reason')
        if not isinstance(report.get('observation'), dict) or 'renderer' not in report['observation']:
            raise ValueError('missing startup observation')
        if report.get('reason') == 'package-entry-control' and (
                report.get('packageControl') not in ('entry', 'data', 'empty')
                or report['observation']['renderer'].get('phase') != 'package-entry-control'):
            raise ValueError('missing explicit package control evidence')
        if not isinstance(report.get('transitions'), list) or len(report['transitions']) > 64:
            raise ValueError('invalid startup transitions')
        serialization = report.get('serialization')
        if not isinstance(serialization, dict) or not isinstance(serialization.get('issues'), list):
            raise ValueError('missing startup serialization bounds')
        frames = report.get('sceneFrames')
        if frames is not None:
            if (not isinstance(frames, dict) or type(frames.get('minimum')) is not int
                    or not 1 <= frames['minimum'] <= 36000 or type(frames.get('observed')) is not int
                    or frames['observed'] < 0 or type(frames.get('passed')) is not bool
                    or frames['passed'] != (not checkpoint and report['reason'] == 'scene-presented')):
                raise ValueError('invalid scene-frame acceptance')
            if frames['passed']:
                renderer = report['observation']['renderer']
                current_frame = renderer.get('frame') if isinstance(renderer, dict) else None
                completion = renderer.get('lastCompletion') if isinstance(renderer, dict) else None
                fields = ('generation', 'deviceGeneration', 'completedStart', 'presentedStart',
                          'completedEnd', 'presentedEnd')
                if (any(type(frames.get(field)) is not int or frames[field] < 0 for field in fields)
                        or frames['generation'] < 1 or frames['observed'] < frames['minimum']
                        or frames['observed'] != frames['presentedEnd'] - frames['presentedStart']
                        or frames['completedEnd'] - frames['completedStart'] < frames['observed']
                        or frames['completedStart'] < frames['presentedStart']
                        or not isinstance(renderer, dict) or renderer.get('phase') != 'ready'
                        or renderer.get('state') != 'alive' or renderer.get('generation') != frames['generation']
                        or renderer.get('completed') != frames['completedEnd']
                        or renderer.get('presented') != frames['presentedEnd']
                        or not isinstance(current_frame, dict) or not isinstance(completion, dict)
                        or current_frame.get('deviceGeneration') != frames['deviceGeneration']
                        or completion.get('deviceGeneration') != frames['deviceGeneration']
                        or completion.get('presentation') != 'ready'):
                    raise ValueError('scene-frame acceptance disagrees with its Host receipts')
        return report
    if not isinstance(report.get('records'), list) or not isinstance(report.get('sources'), list):
        raise ValueError('missing complete records or sources')
    retained, total = {}, 0
    for row in report['sources']:
        if not isinstance(row, dict) or not isinstance(row.get('text'), str):
            raise ValueError('invalid shader source')
        data = row['text'].encode('utf-8')
        if row.get('bytes') != len(data) or row.get('sha256') != sha256(data):
            raise ValueError('shader source bytes or SHA-256 mismatch')
        total += len(data)
        if len(data) > SOURCE_LIMIT or total > TOTAL_SOURCE_LIMIT:
            raise ValueError('shader source size limit exceeded')
        if row['sha256'] in retained:
            raise ValueError('duplicate shader source')
        retained[row['sha256']] = row['bytes']
    for record in report['records']:
        if not isinstance(record, dict):
            raise ValueError('invalid report record')
        if record.get('phase') != 'link' or not isinstance(record.get('shaders'), list):
            continue
        for shader in record['shaders']:
            ref = shader.get('source', {})
            if ref.get('availability') == 'available' and (
                    ref.get('sha256') not in retained or retained[ref['sha256']] != ref.get('bytes')):
                raise ValueError('shader reference has no matching complete source')
    return report


def private_write(path, body):
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(body)


def receive_report(port, path, out, source, deadline=180, ready=None, kind='forgeax-phone-gl-link'):
    validate_report_url(f'http://127.0.0.1:{port}{path}')
    require_hash(source['manifestSha256'])
    require_hash(source['entrySha256'])
    if kind not in REPORT_KINDS:
        raise ValueError('unexpected report kind')
    max_bytes = STARTUP_MAX_BYTES if kind == 'forgeax-phone-startup' else MAX_BYTES
    if not 1 <= deadline <= 600:
        raise ValueError('--deadline must be between 1 and 600 seconds')
    out = Path(out).resolve()
    out.mkdir(mode=0o700)  # New directory only; never overwrite another capture.
    stop_at = time.monotonic() + deadline
    result = None
    active_connection = None
    run_id = None
    checkpoints = 0
    last_sequence = 0
    checkpoint_digests = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def setup(self):
            nonlocal active_connection
            active_connection = self.request
            self.request.settimeout(max(0.01, min(10, stop_at - time.monotonic())))
            super().setup()

        def finish(self):
            nonlocal active_connection
            try:
                super().finish()
            finally:
                active_connection = None

        def reply(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            nonlocal result, run_id, checkpoints, last_sequence
            if self.path != path:
                self.reply(404, {'status': 'rejected', 'reason': 'unexpected-path'})
                return
            try:
                headers = {}
                for key in ['Content-Length', 'Content-Type', 'X-Forgeax-Report-Bytes', 'X-Forgeax-Report-Sha256']:
                    values = self.headers.get_all(key, [])
                    if len(values) != 1:
                        raise ValueError(f'requires exactly one {key} header')
                    headers[key] = values[0]
                if self.headers.get('Transfer-Encoding') or headers['Content-Type'].split(';')[0] != 'application/json':
                    raise ValueError('requires a fixed-length JSON body')
                length = headers['Content-Length']
                if not length.isascii() or not length.isdigit() or not 0 < int(length) <= max_bytes:
                    raise ValueError('report size limit exceeded')
                length = int(length)
                if headers['X-Forgeax-Report-Bytes'] != str(length):
                    raise ValueError('report byte header mismatch')
                body = self.rfile.read(length)
                if len(body) != length or time.monotonic() >= stop_at:
                    raise ValueError('incomplete body or expired deadline')
                report = validate_report(body, headers['X-Forgeax-Report-Sha256'], source, kind)
                if kind == 'forgeax-phone-startup':
                    if run_id is not None and report['runId'] != run_id:
                        raise ValueError('startup run identity changed')
                    run_id = report['runId']
                if report['kind'] == 'forgeax-phone-startup-checkpoint':
                    sequence = report['sequence']
                    actual_digest = sha256(body)
                    if sequence in checkpoint_digests and checkpoint_digests[sequence] != actual_digest:
                        raise ValueError('checkpoint sequence changed bytes')
                    if sequence not in checkpoint_digests:
                        private_write(out / f'checkpoint-{sequence:02d}.json', body)
                        checkpoint_digests[sequence] = actual_digest
                        last_sequence = max(last_sequence, sequence)
                        checkpoints += 1
                    self.reply(200, {'status': 'saved', 'bytes': len(body), 'sha256': sha256(body),
                                     'source': source, 'kind': report['kind'], 'runId': run_id,
                                     'sequence': sequence})
                    return
                private_write(out / 'report.json', body)
                result = {'status': 'saved', 'bytes': len(body), 'sha256': sha256(body),
                          'source': source, 'kind': kind}
                if kind == 'forgeax-phone-gl-link':
                    result['sources'] = len(report['sources'])
                else:
                    result.update(runId=run_id, checkpoints=checkpoints)
                self.reply(200, result)
            except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
                if result is None:
                    result = {'status': 'rejected', 'reason': str(error)}
                try:
                    self.reply(400, result)
                except OSError:
                    pass  # Preserve a saved report even if the sender disconnected.

    def expire():
        connection = active_connection
        if connection is not None:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    watchdog = threading.Timer(deadline, expire)
    watchdog.daemon = True
    try:
        with HTTPServer(('127.0.0.1', port), Handler) as server:
            watchdog.start()
            if ready:
                ready({'status': 'listening', 'url': f'http://127.0.0.1:{port}{path}',
                       'directory': str(out), 'kind': kind, 'maxBytes': max_bytes, 'deadlineSeconds': deadline})
            while result is None and time.monotonic() < stop_at:
                server.timeout = min(1, max(0.01, stop_at - time.monotonic()))
                server.handle_request()
        result = result or ({'status': 'incomplete', 'reason': 'no-terminal-report',
                             'checkpoints': checkpoints, 'lastSequence': last_sequence, 'runId': run_id}
                            if checkpoints else {'status': 'timeout', 'reason': 'deadline'})
    except OSError as error:
        result = {'status': 'failed', 'reason': str(error)}
    finally:
        watchdog.cancel()
    private_write(out / 'result.json', (json.dumps(result, indent=2) + '\n').encode())
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--path', required=True, help='exact private URL path, using letters, digits, underscore, dash or slash')
    parser.add_argument('--out', type=Path, required=True, help='new private evidence directory')
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--entry-sha256', required=True)
    parser.add_argument('--kind', choices=REPORT_KINDS, default='forgeax-phone-gl-link', help='explicit expected report kind; never inferred from incoming bytes')
    parser.add_argument('--deadline', type=float, default=180, help='bounded receive deadline in seconds, maximum 600')
    args = parser.parse_args()
    try:
        result = receive_report(args.port, args.path, args.out,
                                {'manifestSha256': args.manifest_sha256, 'entrySha256': args.entry_sha256},
                                args.deadline, lambda value: print(json.dumps(value), flush=True), args.kind)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(json.dumps(result), flush=True)
    return 0 if result['status'] == 'saved' else 1


if __name__ == '__main__':
    raise SystemExit(main())
