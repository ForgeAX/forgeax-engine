#!/usr/bin/env python3
"""Export one diagnostic game RHI tape through bounded official automation calls."""
import argparse
import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from wechatide import ToolFailure, invoke, load_config, outcome, transport

CHUNK_BYTES = 16 * 1024
WINDOW_BYTES = 1024 * 1024
OPERATION = (Path(__file__).resolve().parents[1] / 'fixtures/rhi-capture/export.js').read_text()
NATIVE_SOURCE = (Path(__file__).resolve().parents[1] / 'fixtures/rhi-capture/native.py').read_text()


def remaining(deadline, operation='capture/export'):
    value = deadline - time.monotonic()
    if value <= 0:
        raise ToolFailure(f'{operation} deadline exceeded')
    return value


def metadata_identity(metadata):
    size, digest, generation = (metadata.get(key) for key in ('byteLength', 'digest', 'generation'))
    if (type(size) is not int or size < 1 or type(generation) is not int or generation < 0
            or not isinstance(digest, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest)):
        raise ToolFailure('capture returned invalid length/digest/generation')
    return {'byteLength': size, 'digest': digest, 'generation': generation}


def publish(partial, target):
    # Exclusive publication never overwrites evidence created during transfer.
    os.link(partial, target)
    partial.unlink()


def function_source(request):
    return 'function () { const operate = ' + OPERATION + '; return operate(' + json.dumps(request) + '); }'


def evaluation(response):
    result = response.get('result') if isinstance(response, dict) else None
    if (not isinstance(response, dict) or response.get('ok') is not True or outcome(response)
            or not isinstance(result, dict) or result.get('success') is not True
            or not isinstance(result.get('result'), dict)):
        raise ToolFailure('official evaluation failed or has no structured game result')
    value = result['result']
    if value.get('phase') == 'failed':
        raise ToolFailure(json.dumps(value, ensure_ascii=False))
    return value


def copy_chunks(call, metadata, target, chunk_bytes=CHUNK_BYTES):
    """Write only contiguous bounded chunks and publish only a whole digest-checked tape."""
    identity = metadata_identity(metadata)
    size, digest = identity['byteLength'], identity['digest']
    offset, checksum = 0, hashlib.sha256()
    partial = target.with_suffix(target.suffix + '.partial')
    with partial.open('xb') as output:
        partial.chmod(0o600)
        while offset < size:
            chunk = call({'operation': 'chunk', 'offset': offset})
            if chunk.get('phase') != 'chunk' or chunk.get('offset') != offset:
                raise ToolFailure('capture returned a stale or out-of-order chunk')
            try:
                data = base64.b64decode(chunk.get('data', ''), validate=True)
            except (ValueError, TypeError) as error:
                raise ToolFailure('capture chunk is not valid base64') from error
            if (not 0 < len(data) <= min(chunk_bytes, size - offset)
                    or chunk.get('byteLength') != len(data)):
                raise ToolFailure('capture chunk length exceeds its bounded window')
            output.write(data)
            checksum.update(data)
            offset += len(data)
            print(json.dumps({'phase': 'exporting', 'bytes': offset, 'total': size}), flush=True)
        complete = call({'operation': 'chunk', 'offset': offset})
        if (complete.get('phase') != 'complete' or complete.get('offset') != offset
                or any(complete.get(key) != metadata.get(key) for key in ('generation', 'byteLength', 'digest'))):
            raise ToolFailure('capture completion identity does not match the exported bytes')
    if 'sha256:' + checksum.hexdigest() != digest:
        raise ToolFailure('capture whole-file SHA-256 mismatch; partial evidence retained')
    publish(partial, target)
    return {'path': str(target.resolve()), 'byteLength': size, 'digest': digest,
            'generation': metadata.get('generation')}


def read_native_window(config, native_root, metadata, native_path, directory, deadline):
    """Retry transport of this same stable window only; no capture or ACK here."""
    directory.mkdir(mode=0o700)
    failure = None
    for attempt in range(1, 4):
        remaining(deadline)
        window = directory / f'copy-{attempt}.partial'
        receipt_path = directory / f'copy-{attempt}.stderr.json'
        request = {'root': str(native_root), 'uniqueName': metadata['uniqueName'],
                   'length': metadata['length'], 'path': native_path}
        try:
            with window.open('xb') as output, receipt_path.open('xb') as errors:
                os.fchmod(output.fileno(), 0o600)
                os.fchmod(errors.fileno(), 0o600)
                copied = subprocess.run(transport(config, ['python3', '-I', '-c', NATIVE_SOURCE,
                    json.dumps(request)]), stdout=output, stderr=errors,
                    timeout=min(60, remaining(deadline)), check=False)
            remaining(deadline)
            if copied.returncode:
                raise ToolFailure('native window transport failed; see retained host receipt')
            receipt = json.loads(receipt_path.read_text())
            if (not isinstance(receipt, dict) or receipt.get('ok') is not True
                    or receipt.get('length') != metadata['length']
                    or not isinstance(receipt.get('identity'), dict)
                    or receipt['identity'].get('size') != metadata['length']
                    or not isinstance(receipt.get('path'), str)
                    or Path(receipt['path']).name != metadata['uniqueName']
                    or (native_path is not None and receipt['path'] != native_path)):
                raise ToolFailure('native window returned invalid copy identity')
            checksum = hashlib.sha256()
            with window.open('rb') as stream:
                for data in iter(lambda: stream.read(256 * 1024), b''):
                    remaining(deadline)
                    checksum.update(data)
            if (window.stat().st_size != metadata['length']
                    or 'sha256:' + checksum.hexdigest() != receipt.get('digest')):
                raise ToolFailure('native window length or SHA-256 mismatch')
            remaining(deadline)
            return window, receipt
        except (ToolFailure, OSError, ValueError, subprocess.TimeoutExpired) as error:
            failure = error
            if attempt < 3:
                time.sleep(min(0.2, remaining(deadline)))
    raise ToolFailure(f'native window copy failed after bounded retries: {failure}')


def copy_native_windows(config, call, metadata, run_id, native_root, target, directory, deadline):
    identity = metadata_identity(metadata)
    offset, windows, checksum, native_path = 0, 0, hashlib.sha256(), None
    partial = target.with_suffix(target.suffix + '.partial')
    with partial.open('xb') as output:
        os.fchmod(output.fileno(), 0o600)
        while offset < identity['byteLength']:
            remaining(deadline)
            name = f'forgeax-rhi-{run_id}.rhitape'
            if (metadata.get('phase') != 'native-window' or metadata.get('offset') != offset
                    or type(metadata.get('length')) is not int
                    or metadata['length'] != min(WINDOW_BYTES, identity['byteLength'] - offset)
                    or metadata.get('uniqueName') != name
                    or not isinstance(metadata.get('virtualPath'), str)
                    or not metadata['virtualPath'].endswith('/' + name)
                    or any(metadata.get(key) != value for key, value in identity.items())):
                raise ToolFailure('native window identity is stale, out of order or exceeds its bound')
            window, receipt = read_native_window(config, native_root, metadata, native_path,
                directory / f'window-{windows:05}', deadline)
            native_path = receipt['path']
            with window.open('rb') as stream:
                for data in iter(lambda: stream.read(256 * 1024), b''):
                    remaining(deadline)
                    output.write(data)
                    checksum.update(data)
            output.flush()
            os.fsync(output.fileno())
            remaining(deadline)
            # Only durable, independently verified local bytes authorize unlink.
            next_metadata = call({'operation': 'ack', 'generation': identity['generation'],
                                  'offset': offset, 'length': metadata['length']})
            offset += metadata['length']
            windows += 1
            window.unlink()
            while next_metadata.get('phase') == 'writing':
                time.sleep(min(0.2, remaining(deadline)))
                next_metadata = call({'operation': 'status'})
            metadata = next_metadata
            print(json.dumps({'phase': 'exporting', 'bytes': offset,
                              'total': identity['byteLength'], 'windows': windows}), flush=True)
        if (metadata.get('phase') != 'complete' or metadata.get('offset') != offset
                or any(metadata.get(key) != value for key, value in identity.items())):
            raise ToolFailure('capture completion identity does not match the exported bytes')
    remaining(deadline)
    if 'sha256:' + checksum.hexdigest() != identity['digest']:
        raise ToolFailure('capture whole-file SHA-256 mismatch; partial evidence retained')
    remaining(deadline)
    publish(partial, target)
    return {'path': str(target.resolve()), **identity, 'nativeWindows': windows,
            'maxNativeWindowBytes': WINDOW_BYTES}


def capture(config, project, directory, timeout=600, max_bytes=256 * 1024 * 1024,
            native_file=False, seed_max_resource_bytes=None, native_root=None):
    if not Path(project).is_absolute():
        raise ToolFailure('project must be an absolute path on the DevTools machine')
    if not 1 <= timeout <= 1800 or not 1 <= max_bytes <= 2 * 1024 * 1024 * 1024:
        raise ToolFailure('timeout must be 1..1800 seconds and max-bytes 1..2 GiB')
    if seed_max_resource_bytes is not None and not 0 <= seed_max_resource_bytes <= 2 * 1024 * 1024 * 1024:
        raise ToolFailure('seed-max-resource-bytes must be 0..2 GiB')
    if native_file != (native_root is not None):
        raise ToolFailure('--native-file and --native-root must be supplied together')
    if native_root is not None and (not Path(native_root).is_absolute() or Path(native_root) == Path('/')):
        raise ToolFailure('native-root must name an explicit absolute host sandbox subtree')
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    run_id, sequence = uuid.uuid4().hex, 0
    deadline = time.monotonic() + timeout

    def call(request):
        nonlocal sequence
        failure = None
        operation = 'release' if request['operation'] == 'release' else 'capture/export'
        operation_deadline = time.monotonic() + 30 if operation == 'release' else deadline
        # Retry status/release/current chunk or ACK, never start a second capture.
        attempts = 1 if request['operation'] == 'start' else 3
        for attempt in range(attempts):
            budget = min(30, remaining(operation_deadline, operation))
            sequence += 1
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    response, status = invoke(config, ['automation_evaluate', '--project', project,
                        '--fn-source', function_source({**request, 'id': run_id})],
                        directory / f'call-{sequence:05}', budget)
                if status:
                    raise ToolFailure('official automation call failed; retained call evidence')
                return evaluation(response)
            except (ToolFailure, OSError, ValueError) as error:
                failure = error
                if attempt + 1 < attempts:
                    time.sleep(min(0.2, remaining(operation_deadline, operation)))
        raise failure

    result = {'success': False, 'project': project, 'diagnosticOnly': True, 'runId': run_id}
    if seed_max_resource_bytes is not None:
        result['seedMaxResourceBytes'] = seed_max_resource_bytes
    try:
        started = call({'operation': 'start', 'chunkBytes': CHUNK_BYTES,
            'snapshotTimeoutMs': min(120000, int(timeout * 1000)),
            'timeoutMs': int((timeout + 30) * 1000), 'maxBytes': max_bytes, 'nativeFile': native_file,
            **({'seedMaxResourceBytes': seed_max_resource_bytes} if seed_max_resource_bytes is not None else {})})
        if started.get('phase') != 'capturing':
            raise ToolFailure('capture did not arm')
        while True:
            metadata = call({'operation': 'status'})
            if metadata.get('phase') in ('ready', 'native-window'):
                break
            if metadata.get('phase') not in ('capturing', 'writing'):
                raise ToolFailure('capture was released before export')
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        print(json.dumps(metadata, ensure_ascii=False), flush=True)
        if metadata.get('generation') != started.get('generation'):
            raise ToolFailure('capture generation changed before export')
        size = metadata.get('byteLength')
        if type(size) is not int or not 1 <= size <= max_bytes:
            raise ToolFailure('capture exceeded its byte budget')
        if native_file:
            result['artifact'] = copy_native_windows(config, call, metadata, run_id, native_root,
                directory / 'frame.rhitape', directory, deadline)
            result['copiedAndVerified'] = True
        else:
            result['artifact'] = copy_chunks(call, metadata, directory / 'frame.rhitape')
        remaining(deadline)
        result['success'] = True
    except (ToolFailure, OSError, ValueError) as error:
        result['error'] = str(error)
    finally:
        try:
            released = call({'operation': 'release'})
            if released.get('phase') != 'released':
                raise ToolFailure('export state was not released')
            result['released'] = True
        except (ToolFailure, OSError, ValueError) as error:
            result['released'] = False
            result['releaseError'] = str(error)
            result['success'] = False
        (directory / 'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        (directory / 'summary.json').chmod(0o600)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--project', required=True)
    parser.add_argument('--out', required=True, type=Path, help='new local evidence directory')
    parser.add_argument('--timeout', type=float, default=600, help='capture/export deadline, seconds')
    parser.add_argument('--max-bytes', type=int, default=256 * 1024 * 1024)
    parser.add_argument('--native-file', action='store_true',
                        help='copy/verify/ACK the same artifact through at most one 1 MiB native window')
    parser.add_argument('--native-root', type=Path,
                        help='explicit sandbox subtree on the DevTools host; required with --native-file')
    parser.add_argument('--seed-max-resource-bytes', type=int,
                        help='omit larger historical resource seeds; 0 requests structural evidence, not pixel qualification')
    args = parser.parse_args()
    return 0 if capture(load_config(args.config), args.project, args.out, args.timeout, args.max_bytes,
                       args.native_file, args.seed_max_resource_bytes, args.native_root)['success'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ToolFailure, OSError, ValueError) as error:
        print(json.dumps({'success': False, 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
