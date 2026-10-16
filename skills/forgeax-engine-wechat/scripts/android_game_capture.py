#!/usr/bin/env python3
"""Capture an explicitly selected Android Mini Game foreground and its scoped logs."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess

from wechatide import ToolFailure, load_config, transport


GAME_ACTIVITY = re.compile(r'com\.tencent\.mm/(?:\.|com\.tencent\.mm\.)plugin\.appbrand\.ui\.AppBrandUI\d*')
ACTIVITY_RECORD = re.compile(r'ActivityRecord\{([0-9a-fA-F]+)\s+u(\d+)\s+(\S+)\s+t(\d+)\}')


def activity_identity(source, activity):
    """Resolve one resumed ActivityRecord and only its own Hist process (Android authority)."""
    if not isinstance(activity, str) or not GAME_ACTIVITY.fullmatch(activity):
        raise ToolFailure('Expected an observed WeChat Mini Game AppBrandUI component')
    record_pattern = ACTIVITY_RECORD
    resumed = set()
    for field in re.findall(r'^[ \t]*(?:topResumedActivity|mResumedActivity)\b(.*)$',
                            source, re.MULTILINE):
        value = re.fullmatch(r'\s*[:=]\s*(.*?)\s*', field)
        if value and value[1] == 'null':
            continue
        record = record_pattern.fullmatch(value[1]) if value else None
        if record is None:
            raise ToolFailure('Malformed resumed Android activity identity')
        resumed.add(record.groups())
    if len(resumed) != 1 or next(iter(resumed))[2] != activity:
        raise ToolFailure('Expected Mini Game activity is not the sole resumed foreground')
    selected = next(iter(resumed))
    pids, histories = [], 0
    lines = source.splitlines()
    for index, line in enumerate(lines):
        header = re.fullmatch(r'([ \t]*)\*\s+Hist\s+#\d+:\s*(.*)', line)
        record = record_pattern.fullmatch(header[2]) if header else None
        if record is None or record.groups() != selected:
            continue
        histories += 1
        indent = len(header[1])
        for child in lines[index + 1:]:
            if not child.strip():
                continue
            if (len(child) - len(child.lstrip()) <= indent
                    or re.match(r'\*\s+Hist\b', child.lstrip())):
                break
            app = re.fullmatch(r'([ \t]*)app\s*=\s*(.*)', child)
            if app is None or len(app[1]) != indent + 2:
                continue
            process = re.fullmatch(r'ProcessRecord\{[0-9a-fA-F]+\s+([1-9]\d*):[^\s{}]+\}', app[2])
            if process is None:
                raise ToolFailure('Malformed Mini Game activity process identity')
            pids.append(int(process[1]))
    if histories != 1 or len(pids) != 1:
        raise ToolFailure('Expected Mini Game activity has no unique process identity')
    return {'activityRecord': selected[0], 'userId': int(selected[1]),
            'activity': selected[2], 'taskId': int(selected[3]), 'pid': pids[0]}


def input_display(source):
    """Read the active default-display viewport, not natural-orientation wm size."""
    selected = []
    for record in re.findall(r'DisplayViewport\{([^{}]*)\}', source):
        fields = dict(re.findall(r'(?:^|,\s*)(\w+)=([^,}]*)', record))
        if fields.get('displayId') != '0':
            continue
        rectangle = re.search(r'\blogicalFrame=Rect\(0, 0 - (\d+), (\d+)\)', record)
        if (fields.get('valid') != 'true' or fields.get('isActive') != 'true'
                or fields.get('orientation') not in ('0', '1', '2', '3') or rectangle is None):
            raise ToolFailure('Default input display is inactive or its viewport is unsupported')
        width, height = map(int, rectangle.groups())
        if not 0 < width <= 65535 or not 0 < height <= 65535:
            raise ToolFailure('Invalid default input display extent')
        selected.append({'displayId': 0, 'rotation': int(fields['orientation']),
                         'width': width, 'height': height})
    if len(selected) != 1:
        raise ToolFailure('No unique active default input display viewport')
    return selected[0]


def input_target(run, activity):
    """Observe one focused/unlocked target; this snapshot is not an atomic input lease."""
    display = input_display(run(['shell', 'dumpsys', 'display']).decode('utf-8', 'replace'))
    windows = run(['shell', 'dumpsys', 'window']).decode('utf-8', 'replace')
    policy = run(['shell', 'dumpsys', 'window', 'policy']).decode('utf-8', 'replace')
    # Read the resumed activity/PID last, immediately before the caller's operation.
    activities = run(['shell', 'dumpsys', 'activity', 'activities']).decode('utf-8', 'replace')
    identity = activity_identity(activities, activity)
    lock_values = re.findall(r'\b(?:mKeyguardShowing|mShowingLockscreen|mDreamingLockscreen)\s*=\s*(true|false)\b',
                             activities + '\n' + windows)
    policy_values = re.findall(r'^\s*(?:showing|mIsShowing|inputRestricted|mInputRestricted)\s*=\s*(true|false)\b',
                               policy, re.MULTILINE)
    if ('true' in lock_values + policy_values
            or re.search(r'\bmAwake\s*=\s*false\b', activities)
            or 'interactiveState=INTERACTIVE_STATE_SLEEP' in policy):
        raise ToolFailure('Phone is locked, sleeping or input-restricted; no input sent')
    showing = re.findall(r'^\s*(?:showing|mIsShowing)\s*=\s*(true|false)\b', policy, re.MULTILINE)
    if not showing or any(value != 'false' for value in showing):
        raise ToolFailure('Cannot establish an unlocked phone from keyguard policy')

    def one_field(name):
        values = re.findall(r'^\s*' + name + r'\s*=\s*(.*?)\s*$', windows, re.MULTILINE)
        if len(values) != 1:
            raise ToolFailure('No unique Android window ' + name)
        return values[0]

    if one_field('mTopFocusedDisplayId') != str(display['displayId']):
        raise ToolFailure('The expected input display is not the focused display')
    focused = ACTIVITY_RECORD.fullmatch(one_field('mFocusedApp'))
    expected = (identity['activityRecord'], str(identity['userId']),
                identity['activity'], str(identity['taskId']))
    if focused is None or focused.groups() != expected:
        raise ToolFailure('Focused app is not the exact resumed Mini Game activity/task/user')
    window = re.fullmatch(r'Window\{[0-9a-fA-F]+\s+u(\d+)\s+(\S+)\}', one_field('mCurrentFocus'))

    def component(value):
        package, name = value.split('/', 1)
        return package + '/' + (package + name if name.startswith('.') else name)

    if (window is None or int(window[1]) != identity['userId'] or '/' not in window[2]
            or component(window[2]) != component(activity)):
        raise ToolFailure('Focused window is outside the intended Mini Game')
    return identity | display


def capture(config, adb, serial, activity, timeout, since=None, log_lines=500, for_input=False):
    def run(arguments):
        result = subprocess.run(transport(config, [adb, '-s', serial, *arguments]),
                                capture_output=True, timeout=timeout, check=False)
        if result.returncode:
            raise ToolFailure(f'adb {arguments[0]} failed ({result.returncode})')
        return result.stdout

    def guard():
        if for_input:
            return input_target(run, activity)
        return activity_identity(run(['shell', 'dumpsys', 'activity', 'activities']).decode('utf-8', 'replace'), activity)

    if run(['get-state']).strip() != b'device':
        raise ToolFailure('Selected Android device is not authorized and ready')
    identity = guard()
    png = run(['exec-out', 'screencap', '-p'])
    if len(png) < 24 or not png.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ToolFailure('ADB did not return a PNG screenshot')
    width, height = struct.unpack('!II', png[16:24])
    if not width or not height:
        raise ToolFailure('ADB returned an empty screenshot extent')
    if for_input and (width, height) != (identity['width'], identity['height']):
        raise ToolFailure('Screenshot extent does not match the current input display')
    if guard() != identity:
        raise ToolFailure('Mini Game foreground identity changed during screenshot capture')
    logs = None
    if since is not None:
        lines = run(['logcat', '-d', '-v', 'threadtime', '--pid', str(identity['pid']), '-T', since]).splitlines()
        logs = b'\n'.join(lines[-log_lines:]) + b'\n'
        if guard() != identity:
            raise ToolFailure('Mini Game foreground identity changed during log capture')
    return {
        **identity, 'serial': serial, 'width': width, 'height': height,
        'screenshotSha256': hashlib.sha256(png).hexdigest(),
        'logSince': since, 'logLineLimit': log_lines if logs is not None else None,
    }, png, logs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='Existing private machine JSON; omit for local ADB')
    parser.add_argument('--adb', required=True, help='Absolute ADB path on the connected machine')
    parser.add_argument('--serial', required=True, help='Intended phone from current discovery')
    parser.add_argument('--activity', required=True, help='Observed Mini Game resumed component')
    parser.add_argument('--manifest', required=True, type=Path, help='Selected immutable forgeax-dist.json')
    parser.add_argument('--out', required=True, type=Path, help='New private local artifact directory')
    parser.add_argument('--for-input', action='store_true', help='Require focused/unlocked game and retain exact display rotation for android_game_input.py')
    parser.add_argument('--since', help='Current run start in phone logcat time, MM-DD HH:MM:SS.mmm')
    parser.add_argument('--log-lines', type=int, default=500, help='Maximum retained current-process lines')
    parser.add_argument('--timeout', type=float, default=20, help='Per-command timeout in seconds')
    args = parser.parse_args()
    if not Path(args.adb).is_absolute() or not 0 < args.timeout <= 60:
        parser.error('--adb must be absolute and --timeout must be in (0, 60]')
    if not GAME_ACTIVITY.fullmatch(args.activity):
        parser.error('--activity must identify an observed WeChat Mini Game AppBrandUI')
    if not 1 <= args.log_lines <= 10000:
        parser.error('--log-lines must be between 1 and 10000')
    if args.since is not None and not re.fullmatch(r'\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}', args.since):
        parser.error('--since must use MM-DD HH:MM:SS.mmm from the phone clock')
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    try:
        manifest = args.manifest.read_bytes()
        selected = json.loads(manifest)
        if not isinstance(selected, dict) or selected.get('target') != 'wechat':
            raise ToolFailure('Selected manifest is not a WeChat distribution')
        config = load_config(args.config) if args.config else {}
        result, png, logs = capture(config, args.adb, args.serial, args.activity,
                                    args.timeout, args.since, args.log_lines, args.for_input)
        screenshot = args.out / 'screen.png'
        screenshot.write_bytes(png)
        screenshot.chmod(0o600)
        if logs is not None:
            log_path = args.out / 'game-process.log'
            log_path.write_bytes(logs)
            log_path.chmod(0o600)
        result.update({'state': 'captured', 'screenshot': str(screenshot.resolve()),
                       'selectedManifestSha256': hashlib.sha256(manifest).hexdigest()})
        code = 0
    except (OSError, ValueError, ToolFailure, subprocess.TimeoutExpired) as error:
        result, code = {'state': 'failed', 'error': str(error)}, 1
    result['observedAtUtc'] = datetime.now(timezone.utc).isoformat()
    artifact = args.out / 'result.json'
    artifact.write_text(json.dumps(result, indent=2) + '\n')
    artifact.chmod(0o600)
    print(json.dumps({key: value for key, value in result.items() if key != 'serial'} |
                     {'artifact': str(artifact.resolve())}, indent=2))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
