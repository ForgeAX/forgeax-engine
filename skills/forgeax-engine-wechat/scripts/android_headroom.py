#!/usr/bin/env python3
"""Read bounded Android CPU, memory and thermal samples without changing device state."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

from wechatide import load_config, transport


def cpu_ticks(source):
    """Linux guest ticks are already included in user/nice; never count them twice."""
    line = next((line for line in source.splitlines() if line.startswith('cpu ')), '')
    values = [int(value) for value in line.split()[1:9]]
    if len(values) < 4 or any(value < 0 for value in values):
        raise ValueError('Missing aggregate CPU counters')
    return {'total': sum(values), 'idle': values[3],
            'iowait': values[4] if len(values) > 4 else 0}


def process_ticks(source):
    # comm can contain spaces and parentheses; fields after the final ')' start at #3.
    end = source.rfind(')')
    if end < 0:
        raise ValueError('Missing process comm')
    values = source[end + 1:].split()
    return {'pid': int(source.split(' ', 1)[0]), 'startTicks': int(values[19]),
            'cpuTicks': int(values[11]) + int(values[12])}


def memory_kib(source):
    return {key: int(value) for key, value in re.findall(
        r'^(MemTotal|MemAvailable|SwapTotal|SwapFree|VmRSS|RssAnon|RssFile|VmSwap):\s+(\d+) kB$',
        source, re.MULTILINE)}


def interval(previous, current):
    result = {'fromMonotonic': previous['endMonotonic'],
              'toMonotonic': current['endMonotonic']}
    before, after = previous.get('cpu'), current.get('cpu')
    if before is None or after is None:
        return result | {'status': 'unavailable', 'reason': 'cpu-counters-unavailable'}
    total, idle = after['total'] - before['total'], after['idle'] - before['idle']
    waiting = after['iowait'] - before['iowait']
    if total <= 0 or idle < 0 or waiting < 0 or idle + waiting > total:
        return result | {'status': 'unavailable', 'reason': 'cpu-counters-regressed'}
    result.update(status='observed', totalTicks=total, idlePercent=idle * 100 / total,
                  ioWaitPercent=waiting * 100 / total)
    before, after = previous.get('process'), current.get('process')
    if before is None or after is None:
        result['processStatus'] = 'unavailable'
    elif (before['pid'], before['startTicks']) != (after['pid'], after['startTicks']):
        result['processStatus'] = 'identity-changed'
    elif after['cpuTicks'] < before['cpuTicks']:
        result['processStatus'] = 'counter-regressed'
    else:
        # Share of all logical CPUs, not the usual top per-core process percentage.
        result.update(processStatus='observed',
                      processMachineCpuPercent=(after['cpuTicks'] - before['cpuTicks']) * 100 / total)
    return result


def collect(config, adb, serial, pid, duration, spacing, timeout):
    started = time.monotonic()
    report = {'kind': 'forgeax-android-headroom/1', 'serial': serial, 'pid': pid,
              'startedAtUtc': datetime.now(timezone.utc).isoformat(),
              'hostMonotonicStart': started, 'durationSeconds': duration,
              'intervalSeconds': spacing, 'samples': [], 'intervals': [],
              'toolSource': {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                             for name in ('android_headroom.py', 'wechatide.py')},
              'qualification': 'system observations only; not a game FPS or isolated GPU measurement'}

    def read(arguments):
        at = time.monotonic()
        try:
            result = subprocess.run(transport(config, [adb, '-s', serial, *arguments]),
                                    capture_output=True, text=True, timeout=timeout, check=False)
            return {'startMonotonic': at, 'endMonotonic': time.monotonic(),
                    'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
        except subprocess.TimeoutExpired:
            return {'startMonotonic': at, 'endMonotonic': time.monotonic(), 'error': 'command-timeout'}
        except OSError as error:
            return {'startMonotonic': at, 'endMonotonic': time.monotonic(), 'error': str(error)}

    def parse(sample, source_key, target_key, parser):
        source = sample['raw'][source_key]
        try:
            if source.get('exitCode') != 0:
                raise ValueError('read-unavailable')
            sample[target_key] = parser(source['stdout'])
        except (ValueError, IndexError) as error:
            sample.setdefault('unavailable', {})[target_key] = str(error)

    next_sample = started
    try:
        while True:
            time.sleep(max(0, next_sample - time.monotonic()))
            sample = {'atUtc': datetime.now(timezone.utc).isoformat(),
                      'startMonotonic': time.monotonic(), 'raw': {}}
            state = read(['get-state'])
            if state.get('exitCode') != 0 or state.get('stdout', '').strip() != 'device':
                report['failure'] = {'code': 'device-unavailable', 'observation': state}
                break
            for key, arguments in {
                'cpu': ['shell', 'cat', '/proc/stat'],
                'process': ['shell', 'cat', f'/proc/{pid}/stat'],
                'processMemory': ['shell', 'cat', f'/proc/{pid}/status'],
                'systemMemory': ['shell', 'cat', '/proc/meminfo'],
                'battery': ['shell', 'dumpsys', 'battery'],
                'thermal': ['shell', 'dumpsys', 'thermalservice'],
            }.items():
                sample['raw'][key] = read(arguments)
            parse(sample, 'cpu', 'cpu', cpu_ticks)
            parse(sample, 'process', 'process', process_ticks)
            parse(sample, 'processMemory', 'processMemoryKiB', memory_kib)
            parse(sample, 'systemMemory', 'systemMemoryKiB', memory_kib)
            sample['endMonotonic'] = time.monotonic()
            report['samples'].append(sample)
            if len(report['samples']) > 1:
                report['intervals'].append(interval(report['samples'][-2], sample))
            if sample['endMonotonic'] >= started + duration:
                break
            # Never burst stale observations after slow ADB commands.
            next_sample = max(next_sample + spacing, sample['endMonotonic'])
    except KeyboardInterrupt:
        report['failure'] = {'code': 'interrupted'}
    report['finishedAtUtc'] = datetime.now(timezone.utc).isoformat()
    report['hostMonotonicEnd'] = time.monotonic()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--adb', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--pid', required=True, type=int, help='Observed game process; never inferred')
    parser.add_argument('--duration', type=float, default=50)
    parser.add_argument('--interval', type=float, default=5)
    parser.add_argument('--timeout', type=float, default=5)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if (not Path(args.adb).is_absolute() or args.pid <= 0
            or not 1 <= args.duration <= 300 or not 1 <= args.interval <= 30
            or not 0 < args.timeout <= 10):
        parser.error('Expected absolute adb, positive PID, duration 1–300, interval 1–30 and timeout (0,10]')
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    report = collect(load_config(args.config) if args.config else {}, args.adb, args.serial,
                     args.pid, args.duration, args.interval, args.timeout)
    path = args.out / 'report.json'
    path.write_text(json.dumps(report, indent=2) + '\n')
    path.chmod(0o600)
    print(json.dumps({'samples': len(report['samples']), 'failure': report.get('failure'),
                      'artifact': str(path.resolve())}))
    return int('failure' in report)


if __name__ == '__main__':
    raise SystemExit(main())
