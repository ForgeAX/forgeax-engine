#!/usr/bin/env python3
"""Copy an already saved simulator report through bounded official evaluations.

Requires the exact path, byte length and SHA-256 from its saved-artifact receipt.
Never starts a capture, changes debug state or connects to a phone.
"""
import argparse
import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import time
import uuid

from wechatide import ToolFailure, invoke, load_config


CHUNK_BYTES = 32768  # Base64 plus envelope stays below the observed 64 KiB CLI limit.
MAX_BYTES = 24 * 1024 * 1024


def source(operation, key, **arguments):
    data = json.dumps(dict(operation=operation, key=key, **arguments), ensure_ascii=True)
    return '''function () {
      const a = ARGS;
      const g = GameGlobal.__gameContextWindow;
      if (!g) throw new Error('Game realm unavailable');
      if (a.operation === 'open') {
        if (Object.prototype.hasOwnProperty.call(g, a.key)) throw new Error('Recovery key already owned');
        const root = g.wx.env.USER_DATA_PATH + '/';
        if (!a.path.startsWith(root) || a.path.slice(root.length).split('/').includes('..'))
          throw new Error('Report must be in this game user-data directory');
        const bytes = g.wx.getFileSystemManager().readFileSync(a.path);
        if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]' || bytes.byteLength !== a.bytes)
          throw new Error('Saved report length/type differs from its receipt');
        g[a.key] = Object.freeze({owner:a.key, bytes});
        return {operation:a.operation, bytes:bytes.byteLength};
      }
      if (a.operation === 'close') {
        if (Object.prototype.hasOwnProperty.call(g, a.key) && g[a.key]?.owner !== a.key)
          return {operation:a.operation, released:false, conflict:true};
        delete g[a.key];
        return {operation:a.operation, released:!Object.prototype.hasOwnProperty.call(g, a.key)};
      }
      const holder = g[a.key];
      if (holder?.owner !== a.key) throw new Error('Recovery snapshot unavailable; runtime may have changed');
      const bytes = holder.bytes;
      if (a.operation !== 'read' || a.offset < 0 || a.length < 1 || a.offset + a.length > bytes.byteLength)
        throw new Error('Invalid recovery byte range');
      // Mini Games need not expose wx.arrayBufferToBase64 or browser btoa.
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const raw = new Uint8Array(bytes, a.offset, a.length);
      let encoded = '';
      for (let i = 0; i < raw.length; i += 3) {
        const value = (raw[i] << 16) | ((raw[i + 1] || 0) << 8) | (raw[i + 2] || 0);
        encoded += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63]
          + (i + 1 < raw.length ? alphabet[(value >>> 6) & 63] : '=')
          + (i + 2 < raw.length ? alphabet[value & 63] : '=');
      }
      return {operation:a.operation, offset:a.offset, length:a.length, base64:encoded};
    }'''.replace('ARGS', data)


def recover(evaluate, path, expected_bytes, expected_sha256, out, *, chunk_bytes=CHUNK_BYTES):
    if (type(expected_bytes) is not int or not 1 <= expected_bytes <= MAX_BYTES
            or not re.fullmatch(r'[0-9a-f]{64}', expected_sha256)
            or not 1 <= chunk_bytes <= CHUNK_BYTES):
        raise ValueError('Expected size, SHA-256 or bounded chunk size is invalid')
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    key = '__forgeaxSavedReport_' + uuid.uuid4().hex
    result = {'schemaVersion': 'forgeax-simulator-report-recovery/1', 'success': False,
              'expectedBytes': expected_bytes, 'expectedSha256': expected_sha256,
              'chunks': 0, 'snapshotReleased': False, 'cleanFpsEvidence': False}
    partial = out / 'report.partial'
    opened = False
    try:
        opened = True
        reply = evaluate(source('open', key, path=path, bytes=expected_bytes), out / 'open')
        if reply != {'operation': 'open', 'bytes': expected_bytes}:
            raise ValueError('Unexpected snapshot receipt')
        digest = hashlib.sha256()
        with partial.open('xb') as stream:
            partial.chmod(0o600)
            for offset in range(0, expected_bytes, chunk_bytes):
                length = min(chunk_bytes, expected_bytes - offset)
                reply = evaluate(source('read', key, offset=offset, length=length),
                                 out / f'chunk-{result["chunks"]:04}')
                if (reply.get('operation') != 'read' or reply.get('offset') != offset
                        or reply.get('length') != length):
                    raise ValueError('Report chunk range differs from request')
                raw = base64.b64decode(reply['base64'], validate=True)
                if len(raw) != length:
                    raise ValueError('Decoded report chunk has the wrong length')
                stream.write(raw)
                digest.update(raw)
                result['chunks'] += 1
        result['actualSha256'] = digest.hexdigest()
        if result['actualSha256'] != expected_sha256:
            raise ValueError('Recovered report SHA-256 differs from saved-artifact receipt')
        report = json.loads(partial.read_bytes())
        if not isinstance(report, dict):
            raise ValueError('Saved report is not a JSON object')
        result['reportStatus'] = report.get('status')
        result['reportFailure'] = report.get('failure')
        result['reportFile'] = 'recovered-report.json'
        partial.rename(out / result['reportFile'])
        result['success'] = True  # Byte recovery only; preserve the report's own failure.
    except (ToolFailure, OSError, ValueError, KeyError, TypeError) as error:
        result['failure'] = str(error)
    finally:
        if opened:
            try:
                reply = evaluate(source('close', key), out / 'close', cleanup=True)
                result['snapshotReleased'] = reply == {'operation': 'close', 'released': True}
                if not result['snapshotReleased']:
                    result['cleanupFailure'] = 'Unexpected snapshot release receipt'
            except (ToolFailure, OSError, ValueError, KeyError, TypeError) as error:
                result['cleanupFailure'] = str(error)
            if not result['snapshotReleased']:
                result['success'] = False
        receipt = out / 'result.json'
        receipt.write_text(json.dumps(result, ensure_ascii=True, indent=2) + '\n')
        receipt.chmod(0o600)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--project', required=True)
    parser.add_argument('--file', required=True)
    parser.add_argument('--bytes', required=True, type=int)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--deadline', type=int, default=600)
    args = parser.parse_args()
    if not Path(args.project).is_absolute() or not 30 <= args.deadline <= 1800:
        parser.error('Use an absolute simulator project and a 30..1800 second deadline')
    config = load_config(args.config)
    deadline = time.monotonic() + args.deadline

    def evaluate(fn, directory, cleanup=False):
        remaining = 20 if cleanup else min(30, deadline - time.monotonic())
        if remaining <= 0:
            raise ToolFailure('Report recovery deadline expired')
        with contextlib.redirect_stdout(io.StringIO()):
            response, status = invoke(config, ['automation_evaluate', '--project', args.project,
                                              '--fn-source', fn], directory, remaining)
        envelope = response.get('result', {})
        if status or response.get('ok') is not True or envelope.get('success') is not True:
            raise ToolFailure('Official evaluation failed or is pending; inspect retained tool receipt')
        value = envelope.get('result')
        if not isinstance(value, dict):
            raise ToolFailure('Official evaluation returned no structured recovery result')
        return value

    result = recover(evaluate, args.file, args.bytes, args.sha256, args.out)
    print(json.dumps(result, ensure_ascii=True), flush=True)
    return 0 if result['success'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ToolFailure, OSError, ValueError) as error:
        print(json.dumps({'success': False, 'failure': str(error)}), file=sys.stderr)
        sys.exit(1)
