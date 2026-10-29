#!/usr/bin/env python3
"""Capture Mac resource intervals locally or through the existing private SSH config."""
import argparse
import inspect
import json
import math
from pathlib import Path
import plistlib
import subprocess

from wechatide import load_config, transport


def gpu_statistics(value):
    """Retain utilization counters only; never export the surrounding IORegistry."""
    rows = []
    if isinstance(value, dict):
        stats = value.get('PerformanceStatistics')
        if isinstance(stats, dict):
            selected = {key: number for key, number in stats.items()
                        if 'Utilization' in key
                        and any(part in key for part in ('Device', 'Renderer', 'Tiler'))
                        and isinstance(number, (int, float)) and not isinstance(number, bool)}
            if selected:
                rows.append(selected)
        for child in value.values():
            rows.extend(gpu_statistics(child))
    elif isinstance(value, list):
        for child in value:
            rows.extend(gpu_statistics(child))
    return rows


def gpu_owners(value):
    """Select GPU clients and counters, excluding unrelated registry properties."""
    rows = []
    if isinstance(value, dict):
        creator = value.get('IOUserClientCreator', '')
        usage = value.get('AppUsage')
        registry_id = value.get('IORegistryEntryID')
        if (isinstance(creator, str) and creator.startswith('pid ')
                and isinstance(usage, list) and isinstance(registry_id, int)):
            pid, separator, name = creator[4:].partition(', ')
            counters = [entry.get('accumulatedGPUTime') for entry in usage
                        if isinstance(entry, dict)]
            if (separator and pid.isdecimal() and len(counters) == len(usage)
                    and all(type(counter) is int and counter >= 0 for counter in counters)):
                rows.append({'registryId': registry_id, 'pid': int(pid), 'name': name,
                             'apiEntries': len(usage), 'accumulatedGPUTime': sum(counters)})
        for child in value.values():
            rows.extend(gpu_owners(child))
    elif isinstance(value, list):
        for child in value:
            rows.extend(gpu_owners(child))
    return rows


def gpu_owner_interval(before, after):
    """Compare only unchanged GPU clients; counter resets are not zero work."""
    previous = {row['registryId']: row for row in before.get('owners', [])}
    current = {row['registryId']: row for row in after.get('owners', [])}
    unavailable = []
    totals = {}
    for registry_id in sorted(previous.keys() | current.keys()):
        old, new = previous.get(registry_id), current.get(registry_id)
        if (old is None or new is None
                or (old['pid'], old['name'], old['apiEntries'])
                != (new['pid'], new['name'], new['apiEntries'])
                or new['accumulatedGPUTime'] < old['accumulatedGPUTime']):
            unavailable.append(registry_id)
            continue
        key = (new['pid'], new['name'])
        totals[key] = totals.get(key, 0) + new['accumulatedGPUTime'] - old['accumulatedGPUTime']
    return {'startedAtUtc': before['atUtc'], 'endedAtUtc': after['atUtc'],
            'elapsedNs': after['monotonicNs'] - before['monotonicNs'],
            'status': 'available' if previous and current and not unavailable else 'partial',
            'unmatchedClients': unavailable,
            'owners': [{'pid': pid, 'name': name, 'accumulatedGPUTimeDelta': delta}
                       for (pid, name), delta in sorted(totals.items(), key=lambda item: item[1], reverse=True)]}


def read_console():
    """Read only lock flags; discard account and other IORegistry properties."""
    try:
        result = subprocess.run(['ioreg', '-n', 'Root', '-d', '1', '-a'],
                                capture_output=True, timeout=5, check=False)
        if result.returncode:
            return {'exitCode': result.returncode, 'status': 'unavailable'}
        root = plistlib.loads(result.stdout)
        if isinstance(root, list) and len(root) == 1:
            root = root[0]
        sessions = [row for row in root.get('IOConsoleUsers', [])
                    if isinstance(row, dict) and row.get('kCGSSessionOnConsoleKey') is True]
        console_locked = root.get('IOConsoleLocked')
        screen_locked = sessions[0].get('CGSSessionScreenIsLocked') if len(sessions) == 1 else None
        if type(console_locked) is not bool or type(screen_locked) is not bool:
            return {'exitCode': 1, 'status': 'unavailable', 'error': 'console-lock-flags-unavailable'}
        return {'exitCode': 0, 'status': 'available',
                'consoleLocked': console_locked, 'screenLocked': screen_locked}
    except (OSError, ValueError, AttributeError, plistlib.InvalidFileException,
            subprocess.TimeoutExpired) as error:
        return {'exitCode': 1, 'status': 'unavailable', 'error': type(error).__name__}


def read_gpu(include_owners=False):
    failures = []
    for registry_class in ('AGXAccelerator', 'IOAccelerator'):
        try:
            result = subprocess.run(['ioreg', '-a', '-r', '-c', registry_class, '-l'],
                                    capture_output=True, timeout=5, check=False)
            if result.returncode:
                failures.append({'class': registry_class, 'exitCode': result.returncode})
                continue
            registry = plistlib.loads(result.stdout)
            statistics = gpu_statistics(registry)
            if statistics:
                return {'status': 'available', 'class': registry_class,
                        'statistics': statistics,
                        **({'owners': gpu_owners(registry)} if include_owners else {})}
            failures.append({'class': registry_class, 'error': 'utilization-unavailable'})
        except (OSError, ValueError, plistlib.InvalidFileException,
                subprocess.TimeoutExpired) as error:
            failures.append({'class': registry_class, 'error': type(error).__name__})
    return {'status': 'unavailable', 'statistics': [], 'attempts': failures}


COLLECT = ('import datetime,json,plistlib,subprocess,threading,time\n'
           + inspect.getsource(gpu_statistics) + '\n' + inspect.getsource(gpu_owners)
           + '\n' + inspect.getsource(gpu_owner_interval) + '\n' + inspect.getsource(read_console)
           + '\n' + inspect.getsource(read_gpu) + r'''
def output_text(value):
    if isinstance(value,bytes): return value.decode('utf-8','replace')
    return value or ''
def run(args):
    try:
        p=subprocess.run(args,capture_output=True,text=True,timeout=OBSERVATION_SECONDS+20)
        return {"exitCode":p.returncode,"stdout":p.stdout,"stderr":p.stderr}
    except subprocess.TimeoutExpired as e:
        return {"exitCode":124,"stdout":output_text(e.stdout),"stderr":output_text(e.stderr),
                "timedOut":True,"timeoutSeconds":OBSERVATION_SECONDS+20}
report={"requestedSeconds":OBSERVATION_SECONDS,"startedAtUtc":datetime.datetime.now(datetime.timezone.utc).isoformat(),"hardware":run(["sysctl","hw.logicalcpu","hw.physicalcpu","hw.memsize"]),"vmBefore":run(["vm_stat"])}
report["consoleBefore"]=read_console()
gpu_samples=[]
gpu_stop=threading.Event()
def sample_gpu():
    while not gpu_stop.is_set():
        started=datetime.datetime.now(datetime.timezone.utc).isoformat()
        monotonic=time.monotonic_ns()
        gpu_samples.append({"atUtc":started,"monotonicNs":monotonic,**read_gpu(INCLUDE_GPU_OWNERS),"endedAtUtc":datetime.datetime.now(datetime.timezone.utc).isoformat()})
        gpu_stop.wait(1)
gpu_thread=threading.Thread(target=sample_gpu)
gpu_thread.start()
try:
    report["intervalCpu"]=run(["top","-l",str(TOP_SAMPLES),"-s","5","-n","25","-o","cpu"])
finally:
    gpu_stop.set()
    gpu_thread.join()
report["gpu"]={"exitCode":0 if gpu_samples and all(row["status"]=="available" for row in gpu_samples) else 1,"samples":gpu_samples}
if INCLUDE_GPU_OWNERS:
    report["gpu"]["ownerIntervals"]=[gpu_owner_interval(a,b) for a,b in zip(gpu_samples,gpu_samples[1:])]
    if not any(interval["owners"] for interval in report["gpu"]["ownerIntervals"]):
        report["gpu"]["exitCode"]=1
        report["gpu"]["attributionError"]="no-comparable-gpu-clients"
report["memory"]=run(["memory_pressure","-Q"])
report["pressure"]=run(["sysctl","kern.memorystatus_vm_pressure_level"])
report["swap"]=run(["sysctl","vm.swapusage"])
report["thermal"]=run(["pmset","-g","therm"])
report["vmAfter"]=run(["vm_stat"])
report["processes"]=run(["ps","-axo","pid=,ppid=,etime=,%cpu=,rss=,comm="])
report["consoleAfter"]=read_console()
report["endedAtUtc"]=datetime.datetime.now(datetime.timezone.utc).isoformat()
print(json.dumps(report,indent=2))
''')


def collector_source(duration=15, include_owners=False):
    """Cover the requested window with five-second CPU and one-second GPU samples."""
    if isinstance(duration, bool) or not isinstance(duration, int) or not 5 <= duration <= 300:
        raise ValueError('duration must be an integer between 5 and 300 seconds')
    return (f'OBSERVATION_SECONDS={duration}\nTOP_SAMPLES={math.ceil(duration / 5) + 1}\n'
            f'INCLUDE_GPU_OWNERS={bool(include_owners)}\n' + COLLECT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, help='existing private machine JSON; omit on the Mac')
    parser.add_argument('--out', required=True, type=Path, help='new local JSON file')
    parser.add_argument('--duration', default=15, type=int,
                        help='observation seconds, 5–300; rounded up to five-second CPU intervals (default: 15)')
    parser.add_argument('--gpu-owners', action='store_true',
                        help='include IORegistry per-client GPU counter deltas for contention diagnosis')
    args = parser.parse_args()
    try:
        collector = collector_source(args.duration, args.gpu_owners)
    except ValueError as error:
        parser.error(str(error))
    config = load_config(args.config) if args.config else {}
    with args.out.open('x') as output:
        result = subprocess.run(transport(config, ['python3', '-']), input=collector,
                                capture_output=True, text=True, timeout=args.duration + 45, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or 'Mac resource collector failed')
        report = json.loads(result.stdout)
        json.dump(report, output, indent=2)
        output.write('\n')
    args.out.chmod(0o600)
    failed = [name for name, value in report.items()
              if isinstance(value, dict) and value.get('exitCode') != 0]
    print(json.dumps({'out': str(args.out.resolve()),
                      'startedAtUtc': report['startedAtUtc'],
                      'endedAtUtc': report['endedAtUtc'], 'failedObservations': failed}))
    return int(bool(failed))


if __name__ == '__main__':
    raise SystemExit(main())
