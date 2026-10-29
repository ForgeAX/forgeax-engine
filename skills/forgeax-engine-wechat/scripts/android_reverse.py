#!/usr/bin/env python3
"""Maintain one explicitly owned ADB reverse during a bounded preview launch."""
import argparse
import json
from pathlib import Path
import subprocess
import time


def selected_mapping(inventory, endpoint):
    rows = [line.split() for line in inventory.splitlines() if line.strip()]
    if any(len(row) != 3 for row in rows):
        raise ValueError('Malformed ADB reverse inventory')
    matches = [row for row in rows if row[1] == endpoint]
    if len(matches) > 1 or any(row[2] != endpoint for row in matches):
        raise ValueError('Selected reverse port belongs to a different mapping')
    return bool(matches)


def ensure_reverse(run, port):
    endpoint = f'tcp:{port}'
    if selected_mapping(run(['reverse', '--list']), endpoint):
        return 'retained'
    run(['reverse', '--no-rebind', endpoint, endpoint])
    if not selected_mapping(run(['reverse', '--list']), endpoint):
        raise ValueError('Selected reverse mapping was not established')
    return 'restored'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--duration', type=int, default=60)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if not Path(args.adb).is_absolute() or not 1 <= args.port <= 65535 or not 1 <= args.duration <= 600:
        parser.error('absolute ADB path, port 1..65535 and duration 1..600 required')
    args.out.mkdir(mode=0o700)
    report = {'port': args.port, 'serial': args.serial, 'startedAt': time.time(), 'events': []}
    failure = None

    def run(arguments):
        return subprocess.run([args.adb, '-s', args.serial, *arguments], check=True,
                              capture_output=True, text=True, timeout=5).stdout

    end = time.monotonic() + args.duration
    try:
        while True:
            try:
                status = ensure_reverse(run, args.port)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                # Observe the selected transport returning; never reconnect it or
                # select another device. Only the explicitly requested port is restored.
                status = 'transport-unavailable'
                report['events'].append({'at': time.time(), 'status': status,
                                         'error': str(error)[:300]})
            else:
                if status == 'restored' or not report['events']:
                    event = {'at': time.time(), 'status': status}
                    report['events'].append(event)
                    print(json.dumps(event), flush=True)
            if time.monotonic() >= end:
                if status == 'transport-unavailable':
                    raise ValueError('Selected transport unavailable at deadline')
                break
            time.sleep(min(1, max(0, end - time.monotonic())))
    except KeyboardInterrupt:
        failure = 'cancelled'
    except (ValueError, OSError) as error:
        failure = str(error)
    finally:
        report.update(finishedAt=time.time(), success=failure is None, failure=failure,
                      cleanup='Caller removes only this port after collection')
        (args.out / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    return 0 if failure is None else 1


if __name__ == '__main__':
    raise SystemExit(main())
