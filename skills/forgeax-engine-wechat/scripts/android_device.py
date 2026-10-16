#!/usr/bin/env python3
"""Read Android USB authorization and device/WeChat versions, locally or over SSH."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess

from wechatide import ToolFailure, load_config, transport


def discover(config, adb, serial, timeout):
    def run(arguments, selected=None):
        argv = [adb, *(['-s', selected] if selected else []), *arguments]
        result = subprocess.run(transport(config, argv), capture_output=True,
                                text=True, timeout=timeout, check=False)
        if result.returncode:
            raise ToolFailure(f'adb {arguments[0]} failed ({result.returncode}): {result.stderr.strip()}')
        return result.stdout.strip()

    version = run(['version'])
    devices = []
    for line in run(['devices', '-l']).splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 2:
            devices.append({'serial': fields[0], 'state': fields[1],
                            'details': ' '.join(fields[2:])})
    result = {'adbVersion': version, 'devices': devices}
    selected = [device for device in devices if serial is None or device['serial'] == serial]
    if not selected:
        return result | {'state': 'device-not-found'}, 1
    if len(selected) != 1:
        return result | {'state': 'multiple-devices'}, 1
    device = selected[0]
    if device['state'] == 'unauthorized':
        return result | {'state': 'authorization-required'}, 3
    if device['state'] != 'device':
        return result | {'state': device['state']}, 1
    identity = device['serial']
    properties = {
        'manufacturer': 'ro.product.manufacturer', 'model': 'ro.product.model',
        'device': 'ro.product.device', 'androidRelease': 'ro.build.version.release',
        'androidApi': 'ro.build.version.sdk', 'abi': 'ro.product.cpu.abi',
    }
    result['device'] = {name: run(['shell', 'getprop', prop], identity)
                        for name, prop in properties.items()}
    package = run(['shell', 'dumpsys', 'package', 'com.tencent.mm'], identity)
    result['wechat'] = [line.strip() for line in package.splitlines()
                        if re.match(r'\s*(versionCode|versionName)=', line)]
    result['display'] = run(['shell', 'wm', 'size'], identity)
    result['density'] = run(['shell', 'wm', 'density'], identity)
    result['state'] = 'ready' if result['wechat'] else 'wechat-not-installed'
    return result, 0 if result['wechat'] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='Existing private wechatide machine JSON; omit for local ADB')
    parser.add_argument('--adb', required=True, help='Absolute ADB path on the connected machine')
    parser.add_argument('--serial', help='Explicit device serial when more than one phone is connected')
    parser.add_argument('--out', required=True, type=Path, help='New private local artifact directory')
    parser.add_argument('--timeout', type=float, default=30, help='Per-command timeout in seconds')
    args = parser.parse_args()
    if not Path(args.adb).is_absolute() or args.timeout <= 0:
        parser.error('--adb must be absolute and --timeout must be positive')
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    try:
        config = load_config(args.config) if args.config else {}
        result, code = discover(config, args.adb, args.serial, args.timeout)
    except (OSError, ValueError, ToolFailure, subprocess.TimeoutExpired) as error:
        result, code = {'state': 'failed', 'error': str(error)}, 1
    result['observedAtUtc'] = datetime.now(timezone.utc).isoformat()
    artifact = args.out / 'result.json'
    artifact.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    artifact.chmod(0o600)
    summary = {key: value for key, value in result.items() if key not in ('devices', 'adbVersion')}
    summary['deviceStates'] = [device['state'] for device in result.get('devices', [])]
    summary['artifact'] = str(artifact.resolve())
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
