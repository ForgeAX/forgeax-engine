#!/usr/bin/env python3
"""Run the official WeChat AI CLI locally or over SSH; retain structured results."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time


class ToolFailure(Exception):
    pass


def load_config(path):
    config = json.loads(Path(path).read_text())
    if not isinstance(config, dict) or set(config) - {'cli', 'client', 'ssh', 'port', 'identity'}:
        raise ToolFailure('machine config supports cli, client, ssh, port, identity only; no tokens')
    return config


def command(config, arguments):
    cli = config.get('cli')
    if not isinstance(cli, str) or not cli.startswith('/'):
        raise ToolFailure('config.cli must be an absolute path to the official wechatide executable')
    return transport(config, [cli, '-c', config.get('client', 'Codex'), *arguments])


def transport(config, argv):
    if not config.get('ssh'):
        return argv
    host = config['ssh']
    if not isinstance(host, str) or not re.fullmatch(r'[\w.@:-]+', host) or host.startswith('-'):
        raise ToolFailure('config.ssh must be an SSH alias or user@host')
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
           '-o', 'StrictHostKeyChecking=yes']
    if config.get('identity'):
        ssh += ['-o', 'IdentitiesOnly=yes', '-i', os.path.expanduser(config['identity'])]
    if config.get('port'):
        port = int(config['port'])
        if not 1 <= port <= 65535:
            raise ToolFailure('config.port must be between 1 and 65535')
        ssh += ['-p', str(port)]
    return [*ssh, host, shlex.join(argv)]


def parse_response(source):
    # The CLI may print diagnostic lines before its one JSON envelope.
    decoder = json.JSONDecoder()
    for match in re.finditer(r'(?m)^\s*\{', source):
        try:
            value, end = decoder.raw_decode(source[match.start():].lstrip())
            if isinstance(value, dict) and ('ok' in value or 'success' in value):
                return value
        except json.JSONDecodeError:
            continue
    raise ToolFailure('official CLI returned no complete JSON result (console output may be truncated); narrow the query or use direct --help for help text')


def outcome(value):
    """Do not mistake transport success for tool success."""
    if isinstance(value, list):
        states = [outcome(item) for item in value]
    elif isinstance(value, dict):
        if value.get('ok') is False or value.get('success') is False or value.get('isError') is True:
            return 1
        if value.get('status') in ('failed', 'error', 'cancelled', 'canceled', 'rejected', 'expired'):
            return 1
        states = [outcome(item) for key, item in value.items()
                  if key in ('result', 'structuredContent', 'content')]
        if value.get('type') == 'text':
            try:
                states.append(outcome(json.loads(value['text'])))
            except (ValueError, KeyError, TypeError):
                pass
        if value.get('status') == 'pending':
            states.append(3)
    else:
        states = []
    return 1 if 1 in states else 3 if 3 in states else 0


def extract_images(value, directory):
    count = 0
    def walk(item):
        nonlocal count
        if isinstance(item, list):
            return [walk(child) for child in item]
        if not isinstance(item, dict):
            return item
        if item.get('type') == 'image' and isinstance(item.get('data'), str):
            mime = item.get('mimeType')
            extension = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}.get(mime)
            if extension is None:
                raise ToolFailure(f'unsupported image MIME type: {mime}')
            data = base64.b64decode(item['data'], validate=True)
            if len(data) > 32 * 1024 * 1024:
                raise ToolFailure('image exceeds 32 MiB artifact limit')
            count += 1
            target = directory / f'image-{count}{extension}'
            target.write_bytes(data)
            target.chmod(0o600)
            return {key: walk(child) for key, child in item.items() if key != 'data'} | {
                'artifact': str(target.resolve()), 'bytes': len(data)}
        return {key: walk(child) for key, child in item.items()}
    return walk(value)


def fetch_screenshot(config, response, directory, timeout):
    result = response.get('result')
    if not isinstance(result, dict) or result.get('success') is not True:
        return
    remote_path = result.get('path')
    if not isinstance(remote_path, str) or not remote_path.startswith('/'):
        return
    if config.get('ssh'):
        copied = subprocess.run(transport(config, ['cat', remote_path]), capture_output=True,
                                timeout=timeout, check=False)
        if copied.returncode:
            raise ToolFailure('screenshot copy failed: ' + copied.stderr.decode(errors='replace'))
        data = copied.stdout
    else:
        data = Path(remote_path).read_bytes()
    if len(data) > 32 * 1024 * 1024:
        raise ToolFailure('screenshot exceeds 32 MiB artifact limit')
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        extension = '.png'
    elif data.startswith(b'\xff\xd8\xff'):
        extension = '.jpg'
    else:
        raise ToolFailure('returned screenshot is not a PNG or JPEG image')
    target = directory / ('simulator' + extension)
    target.write_bytes(data)
    target.chmod(0o600)
    result['artifact'] = str(target.resolve())
    result['bytes'] = len(data)


def emit_result(directory, envelope):
    target = directory / 'result.json'
    target.write_text(json.dumps(envelope, ensure_ascii=False, indent=2) + '\n')
    target.chmod(0o600)
    print(json.dumps(envelope, ensure_ascii=False, indent=2), flush=True)


def invoke(config, arguments, directory, timeout):
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    try:
        result = subprocess.run(command(config, arguments), capture_output=True,
                                text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        # TimeoutExpired may retain bytes even when run(text=True). Preserve those
        # exact private bytes, without printing partial payloads or command arguments.
        for name, source in [('stdout.txt', error.stdout), ('stderr.txt', error.stderr)]:
            target = directory / name
            target.write_bytes(source if isinstance(source, bytes) else (source or '').encode())
            target.chmod(0o600)
        response = {'ok': False, 'tool': arguments[0], 'error': {
            'code': 'process-timeout',
            'message': 'Official CLI process exceeded the configured timeout.',
        }}
        emit_result(directory, {'processExitCode': None, 'response': response,
                                'timedOut': True, 'timeoutSeconds': timeout})
        return response, 1
    # stderr is normally a call trace; never print binary/base64 payloads to the model.
    (directory / 'stderr.txt').write_text(result.stderr)
    (directory / 'stderr.txt').chmod(0o600)
    try:
        response = parse_response(result.stdout)
    except ToolFailure:
        (directory / 'stdout.txt').write_text(result.stdout)
        (directory / 'stdout.txt').chmod(0o600)
        raise
    response = extract_images(response, directory)
    copy_error = None
    if arguments[0] == 'simulator_screenshot' and result.returncode == 0:
        try:
            fetch_screenshot(config, response, directory, timeout)
        except (ToolFailure, OSError, subprocess.TimeoutExpired) as error:
            copy_error = str(error)
    envelope = {'processExitCode': result.returncode, 'response': response}
    if copy_error is not None:
        envelope['artifactError'] = copy_error
    emit_result(directory, envelope)
    return response, 1 if result.returncode or copy_error is not None else outcome(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path, help='private machine JSON; see tooling.md')
    parser.add_argument('--out', required=True, type=Path, help='new artifact directory, never overwritten')
    parser.add_argument('--timeout', type=int, default=60)
    sub = parser.add_subparsers(dest='mode', required=True)
    call = sub.add_parser('call', help='pass a registered tool and its flags to the official CLI')
    call.add_argument('tool')
    call.add_argument('arguments', nargs=argparse.REMAINDER)
    poll = sub.add_parser('poll', help='bounded polling of official login/auth tasks only')
    poll.add_argument('task_id')
    poll.add_argument('--attempts', type=int, default=10, choices=range(1, 11))
    args = parser.parse_args()
    config = load_config(args.config)
    if not 1 <= args.timeout <= 300:
        raise ToolFailure('timeout must be between 1 and 300 seconds')
    if args.mode == 'call':
        if not re.fullmatch(r'[a-z][a-z0-9_]*', args.tool):
            raise ToolFailure('tool must be a registered official tool name; consult installed help')
        if any('token' in arg.lower() for arg in args.arguments if arg.startswith('--')):
            raise ToolFailure('use the official CLI credential configuration; do not pass tokens here')
        _, status = invoke(config, [args.tool, *args.arguments], args.out, args.timeout)
        return status
    if not args.task_id.startswith(('login_', 'auth_')):
        raise ToolFailure('only login/auth tasks are actively polled; retain other pendingTask IDs')
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    for attempt in range(args.attempts):
        if attempt:
            time.sleep(10)
        _, status = invoke(config, ['polling_task_result', '--task-id', args.task_id],
                           args.out / f'poll-{attempt + 1:02}', args.timeout)
        if status != 3:
            return status
    return 3


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ToolFailure, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'success': False, 'error': str(error)}), file=sys.stderr)
        sys.exit(1)
