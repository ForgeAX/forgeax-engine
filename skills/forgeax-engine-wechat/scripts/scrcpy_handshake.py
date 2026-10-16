#!/usr/bin/env python3
"""Qualify an official scrcpy control connection and clean it up without sending input.

Run on the machine that owns ADB (the Mac for the configured remote phone).
This downloads a pinned server, pushes a temporary JAR and starts app_process.
It does not install an APK, open a window, or send any control message.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import secrets
import socket
import subprocess
import time
import urllib.request

VERSION = '5.0.1'
SERVER_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536'
SERVER_URL = f'https://github.com/Genymobile/scrcpy/releases/download/v{VERSION}/scrcpy-server-v{VERSION}'
OPTIONS = [
    'tunnel_forward=true', 'video=false', 'audio=false', 'control=true',
    'display_id=0', 'send_device_meta=false', 'send_dummy_byte=true',
    'clipboard_autosync=false', 'power_on=false', 'power_off_on_close=false',
    'stay_awake=false', 'show_touches=false', 'keep_active=false', 'cleanup=true',
]


def verified_server(cache):
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = cache / f'scrcpy-server-v{VERSION}'
    if server.exists():
        payload = server.read_bytes()
    else:
        with urllib.request.urlopen(SERVER_URL, timeout=30) as response:
            payload = response.read()
    if hashlib.sha256(payload).hexdigest() != SERVER_SHA256:
        raise ValueError('scrcpy server SHA256 does not match the pinned official release')
    if not server.exists():
        with server.open('xb') as output:
            output.write(payload)
        server.chmod(0o600)
    return server


def control_session(adb, serial, cache, execute=None):
    """Own exactly one control connection; execute must release its contacts before returning.

    Passing no callback retains the no-input handshake probe. This is the single
    server/forward/JAR owner for both the probe and a continuous input consumer.
    """
    scid = f'{secrets.randbelow(0x7ffffffe) + 1:08x}'
    jar = f'/data/local/tmp/forgeax-scrcpy-{scid}.jar'
    report = {'version': VERSION, 'serverSha256': SERVER_SHA256, 'scid': scid,
              'status': 'failed'}
    if execute is None:
        report['inputMessagesSent'] = 0
    port = process = connection = None
    pushed = False

    def run(arguments, check=True):
        result = subprocess.run([adb, '-s', serial, *arguments], capture_output=True,
                                text=True, timeout=25, check=False)
        if check and result.returncode:
            raise RuntimeError(f'adb {arguments[0]} failed: {result.stderr.strip()}')
        return result

    def cleanup(label, operation):
        try:
            operation()
        except Exception as error:
            report.setdefault('cleanupErrors', []).append({'step': label, 'error': str(error)})

    try:
        server = verified_server(cache)
        report['authorized'] = run(['get-state']).stdout.strip() == 'device'
        if not report['authorized']:
            raise RuntimeError('the explicitly selected device is not ready')
        pushed = True  # A failed push may leave a partial file owned by this session.
        run(['push', str(server), jar])
        port = int(run(['forward', 'tcp:0', f'localabstract:scrcpy_{scid}']).stdout.strip())
        process = subprocess.Popen(
            [adb, '-s', serial, 'shell', f'CLASSPATH={jar}', 'app_process', '/',
             'com.genymobile.scrcpy.Server', VERSION, f'scid={scid}', *OPTIONS],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and process.poll() is None:
            candidate = None
            try:
                candidate = socket.create_connection(('127.0.0.1', port), timeout=1)
                candidate.settimeout(2)
                first = candidate.recv(1)
                if first == b'\x00':
                    connection = candidate
                    candidate = None
                    break
                if first:
                    raise ValueError('unexpected scrcpy control handshake byte')
            except OSError:
                pass  # The ADB forward may precede the server listener.
            finally:
                if candidate is not None:
                    candidate.close()
            time.sleep(0.2)
        if connection is None:
            raise RuntimeError('no scrcpy control handshake before the deadline')
        report['handshake'] = '00'
        if execute is not None:
            report['execution'] = execute(connection)
        connection.close()
        connection = None
        stdout, stderr = process.communicate(timeout=15)
        report.update(serverExitCode=process.returncode, serverStdout=stdout, serverStderr=stderr)
        if process.returncode:
            raise RuntimeError(f'scrcpy server exited with {process.returncode}')
    except Exception as error:
        report['error'] = str(error)
    finally:
        if connection is not None:
            cleanup('close-control', connection.close)
        if process is not None and process.poll() is None:
            def stop_client():
                process.terminate()
                try:
                    stdout, stderr = process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()  # Only this session's local ADB child.
                    stdout, stderr = process.communicate(timeout=5)
                report.update(serverExitCode=process.returncode, serverStdout=stdout,
                              serverStderr=stderr, serverTerminationRequired=True)
            cleanup('stop-owned-adb-client', stop_client)
        if port is not None:
            def remove_forward():
                run(['forward', '--remove', f'tcp:{port}'])
                report['forwardRemoved'] = True
            cleanup('remove-session-forward', remove_forward)
        if pushed:
            def remove_jar():
                absent = run(['shell', 'test', '!', '-e', jar], check=False).returncode == 0
                if not absent:
                    run(['shell', 'rm', '-f', jar])
                report['jarRemoved'] = run(['shell', 'test', '!', '-e', jar], check=False).returncode == 0
            cleanup('remove-session-jar', remove_jar)
        if process is not None:
            def check_process():
                lines = run(['shell', 'ps', '-A', '-o', 'PID,ARGS']).stdout.splitlines()
                report['serverProcessRemains'] = any(
                    'com.genymobile.scrcpy.Server' in line and f'scid={scid}' in line
                    for line in lines
                )
            cleanup('check-session-process', check_process)
    if ('error' not in report and not report.get('cleanupErrors')
            and report.get('handshake') == '00' and report.get('serverExitCode') == 0
            and report.get('forwardRemoved') and report.get('jarRemoved')
            and report.get('serverProcessRemains') is False):
        report['status'] = 'handshake-only-passed' if execute is None else 'control-session-closed'
    return report


def handshake(adb, serial, cache):
    return control_session(adb, serial, cache)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', required=True, help='Absolute ADB path on this machine')
    parser.add_argument('--serial', required=True, help='Explicit already-authorized phone serial')
    parser.add_argument('--cache', type=Path, required=True, help='Absolute private server-cache directory')
    parser.add_argument('--out', type=Path, required=True, help='New absolute private artifact directory')
    args = parser.parse_args()
    if not all(path.is_absolute() for path in (Path(args.adb), args.cache, args.out)):
        parser.error('--adb, --cache and --out must be absolute paths on the ADB machine')
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    result = handshake(args.adb, args.serial, args.cache)
    result['observedAtUtc'] = datetime.now(timezone.utc).isoformat()
    artifact = args.out / 'result.json'
    artifact.write_text(json.dumps(result, indent=2) + '\n')
    artifact.chmod(0o600)
    summary = {key: value for key, value in result.items() if key not in ('serverStdout', 'serverStderr')}
    print(json.dumps(summary | {'artifact': str(artifact)}, indent=2))
    return 0 if result['status'] == 'handshake-only-passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
