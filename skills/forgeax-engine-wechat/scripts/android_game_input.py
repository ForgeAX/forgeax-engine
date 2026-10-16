#!/usr/bin/env python3
"""Send one guarded Android game tap, swipe or editing key; never retry input."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

from android_game_capture import GAME_ACTIVITY, input_target
from wechatide import ToolFailure, load_config, transport


EDITING_KEYS = ('DEL', 'FORWARD_DEL', 'MOVE_HOME', 'MOVE_END', 'DPAD_LEFT', 'DPAD_RIGHT', 'ENTER')
TARGET_FIELDS = ('activityRecord', 'userId', 'activity', 'taskId', 'pid',
                 'displayId', 'rotation', 'width', 'height')


def action_arguments(action, width, height):
    kind = action.get('kind')
    if kind == 'keyevent':
        if set(action) != {'kind', 'key'} or action['key'] not in EDITING_KEYS:
            raise ToolFailure('Only one named editing key is supported')
        return ['keyboard', '-d', '0', 'keyevent', 'KEYCODE_' + action['key']]
    fields = ('x', 'y') if kind == 'tap' else ('x', 'y', 'endX', 'endY')
    allowed = {'kind', *fields} | ({'durationMs'} if kind == 'swipe' else set())
    if kind not in ('tap', 'swipe') or set(action) != allowed:
        raise ToolFailure('Expected one tap, swipe or editing keyevent')
    for field in fields:
        extent = width if field in ('x', 'endX') else height
        if type(action[field]) is not int or not 0 <= action[field] < extent:
            raise ToolFailure('Input coordinate outside the captured display: ' + field)
    arguments = ['touchscreen', '-d', '0', kind, *(str(action[field]) for field in fields)]
    if kind == 'swipe':
        if type(action['durationMs']) is not int or not 1 <= action['durationMs'] <= 5000:
            raise ToolFailure('Swipe duration must be between 1 and 5000 milliseconds')
        arguments.append(str(action['durationMs']))
    return arguments


def validate_capture_target(captured, serial):
    """Shared exact prepared capture identity; performs no device operations."""
    if not isinstance(serial, str) or not re.fullmatch(r'[\w.:-]{1,128}', serial):
        raise ToolFailure('An explicit Android serial from discovery is required')
    if (not isinstance(captured, dict) or captured.get('state') != 'captured'
            or captured.get('serial') != serial):
        raise ToolFailure('Capture belongs to a different phone or is not a successful capture; recapture with --for-input')
    if (not isinstance(captured.get('activity'), str)
            or not GAME_ACTIVITY.fullmatch(captured['activity'])
            or not isinstance(captured.get('activityRecord'), str)
            or not re.fullmatch(r'[0-9a-fA-F]+', captured['activityRecord'])):
        raise ToolFailure('Capture has no exact Mini Game activity identity')
    for field, minimum, maximum in [('userId', 0, 2**31 - 1), ('taskId', 0, 2**31 - 1),
                                    ('pid', 1, 2**31 - 1), ('displayId', 0, 0),
                                    ('rotation', 0, 3), ('width', 1, 65535), ('height', 1, 65535)]:
        value = captured.get(field)
        if type(value) is not int or not minimum <= value <= maximum:
            raise ToolFailure('Capture lacks a supported input ' + field + '; recapture with --for-input')
    for field in ('screenshotSha256', 'selectedManifestSha256'):
        if not isinstance(captured.get(field), str) or not re.fullmatch(r'[0-9a-f]{64}', captured[field]):
            raise ToolFailure('Capture has no valid ' + field)
    return {field: captured[field] for field in TARGET_FIELDS}


def perform_input(config, adb, serial, captured, action, timeout=20):
    """One bounded action receipt. A native command ACK is not a game/keyboard pass."""
    receipt = {'state': 'blocked', 'action': action, 'attempted': False,
               'observedAtUtc': datetime.now(timezone.utc).isoformat()}
    stage = 'preflight'
    try:
        if not Path(adb).is_absolute() or not 0 < timeout <= 60:
            raise ToolFailure('ADB path must be absolute; timeout must be in (0, 60]')
        expected = validate_capture_target(captured, serial)
        arguments = action_arguments(action, captured['width'], captured['height'])
        receipt.update({'serial': serial, 'captureTarget': expected,
                        'screenshotSha256': captured.get('screenshotSha256'),
                        'selectedManifestSha256': captured.get('selectedManifestSha256')})

        def read(arguments):
            result = subprocess.run(transport(config, [adb, '-s', serial, *arguments]),
                                    capture_output=True, timeout=timeout, check=False)
            if result.returncode:
                raise ToolFailure(f'ADB preflight {arguments[0]} failed ({result.returncode})')
            if len(result.stdout) > 8 * 1024 * 1024:
                raise ToolFailure('ADB preflight output exceeds 8 MiB')
            return result.stdout

        if read(['get-state']).strip() != b'device':
            raise ToolFailure('Selected Android device is not authorized and ready')
        current = input_target(read, captured['activity'])
        receipt['before'] = current
        if current != expected:
            changed = [field for field in TARGET_FIELDS if current[field] != expected[field]]
            raise ToolFailure('Captured target changed: ' + ', '.join(changed) + '; recapture before input')
        stage = 'input'
        receipt['attempted'] = True
        receipt['dispatchedAtUtc'] = datetime.now(timezone.utc).isoformat()
        result = subprocess.run(transport(config, [adb, '-s', serial, 'shell', 'input', *arguments]),
                                capture_output=True, timeout=timeout, check=False)
        receipt['nativeInput'] = {
            'exitCode': result.returncode,
            'stdout': result.stdout[:1024].decode('utf-8', 'replace'),
            'stderr': result.stderr[:1024].decode('utf-8', 'replace'),
            'outputTruncated': len(result.stdout) > 1024 or len(result.stderr) > 1024,
        }
        output = receipt['nativeInput']['stdout'] + '\n' + receipt['nativeInput']['stderr']
        if (result.returncode or receipt['nativeInput']['outputTruncated']
                or re.search(r'(?im)^\s*(?:Error\b|Exception\b|SecurityException\b|java\.lang\.\w*Exception\b|usage:)', output)):
            raise ToolFailure(f'Native input exited {result.returncode}; inspect the phone before another action')
        receipt['state'] = 'dispatched'
        receipt['qualification'] = 'Native command completed only; inspect the resulting game and capture again after layout changes.'
        return receipt, 0
    except (OSError, ValueError, ToolFailure, subprocess.TimeoutExpired) as error:
        receipt['state'] = 'failed' if receipt['attempted'] else 'blocked'
        receipt['error'] = {'stage': stage, 'type': type(error).__name__,
                            'message': ('Command timed out; its remote outcome is unknown' if isinstance(error, subprocess.TimeoutExpired)
                                        else str(error)[:1024])}
        receipt['mayHaveExecuted'] = receipt['attempted']
        receipt['retryAutomatically'] = False
        return receipt, 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='Existing private machine JSON; omit for local ADB')
    parser.add_argument('--adb', required=True, help='Absolute ADB path on the connected machine')
    parser.add_argument('--serial', required=True, help='Intended phone from discovery; retained privately')
    parser.add_argument('--capture-result', required=True, type=Path,
                        help='Reviewed android_game_capture.py --for-input result.json')
    parser.add_argument('--out', required=True, type=Path, help='New private local action receipt directory')
    parser.add_argument('--timeout', type=float, default=20, help='Per-command seconds, (0, 60]')
    actions = parser.add_subparsers(dest='action', required=True)
    for kind in ('tap', 'swipe'):
        sub = actions.add_parser(kind)
        sub.add_argument('x', type=int)
        sub.add_argument('y', type=int)
        if kind == 'swipe':
            sub.add_argument('end_x', type=int)
            sub.add_argument('end_y', type=int)
            sub.add_argument('--duration-ms', type=int, default=500)
    actions.add_parser('keyevent').add_argument('key', choices=EDITING_KEYS)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    action = {'kind': args.action}
    if args.action == 'keyevent':
        action['key'] = args.key
    else:
        action.update({'x': args.x, 'y': args.y})
        if args.action == 'swipe':
            action.update({'endX': args.end_x, 'endY': args.end_y, 'durationMs': args.duration_ms})
    try:
        data = args.capture_result.read_bytes()
        if len(data) > 65536:
            raise ToolFailure('Capture result exceeds 64 KiB')
        config = load_config(args.config) if args.config else {}
        receipt, code = perform_input(config, args.adb, args.serial, json.loads(data), action, args.timeout)
        receipt['captureResultSha256'] = hashlib.sha256(data).hexdigest()
    except (OSError, ValueError, ToolFailure) as error:
        receipt, code = {'state': 'blocked', 'attempted': False,
                         'error': {'stage': 'capture-result', 'message': str(error)[:1024]}}, 1
    path = args.out / 'result.json'
    path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)
    print(json.dumps({'state': receipt['state'], 'attempted': receipt['attempted'],
                      'artifact': str(path.resolve())}))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
