#!/usr/bin/env python3
"""Read-only Darwin admission evidence; no GPU lease, setup, or source build."""
import argparse
import ctypes
import datetime
import json
import os
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--key', required=True)
parser.add_argument('--head', required=True)
parser.add_argument('--diff-sha256', required=True)
args = parser.parse_args()
report = {'verdict': 'blocked', 'key': args.key, 'head': args.head,
          'diffSha256': args.diff_sha256, 'samples': [],
          'thresholds': {'durationSeconds': 60, 'cpuPercent': 20, 'load1': 3,
                         'memoryPressure': 'normal', 'swapGrowthBytes': 0},
          'scope': 'actual OS observation, not a failure-causality claim'}
lib = None
host = None
try:
    if os.uname().sysname != 'Darwin':
        raise RuntimeError('this frozen measurement target is Darwin; no synthetic admission fallback')
    lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    lib.mach_host_self.restype = ctypes.c_uint32
    lib.host_processor_info.argtypes = [ctypes.c_uint32, ctypes.c_int,
                                       ctypes.POINTER(ctypes.c_uint32),
                                       ctypes.POINTER(ctypes.POINTER(ctypes.c_int)),
                                       ctypes.POINTER(ctypes.c_uint32)]
    lib.host_processor_info.restype = ctypes.c_int
    lib.vm_deallocate.argtypes = [ctypes.c_uint32, ctypes.c_uint64, ctypes.c_uint64]
    lib.vm_deallocate.restype = ctypes.c_int
    lib.mach_port_deallocate.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    task = ctypes.c_uint32.in_dll(lib, 'mach_task_self_').value
    host = lib.mach_host_self()

    def cpu_ticks():
        cpus = ctypes.c_uint32()
        count = ctypes.c_uint32()
        info = ctypes.POINTER(ctypes.c_int)()
        status = lib.host_processor_info(host, 2, ctypes.byref(cpus), ctypes.byref(info), ctypes.byref(count))
        if status != 0:
            raise RuntimeError(f'host_processor_info failed: {status}')
        try:
            if count.value != cpus.value * 4 or cpus.value == 0:
                raise RuntimeError(f'unexpected CPU load ABI: cpus={cpus.value}, values={count.value}')
            values = [info[index] & 0xffffffff for index in range(count.value)]
            return cpus.value, values
        finally:
            status = lib.vm_deallocate(task, ctypes.cast(info, ctypes.c_void_p).value, count.value * ctypes.sizeof(ctypes.c_int))
            if status != 0:
                raise RuntimeError(f'CPU observation deallocation failed: {status}')

    class SwapUsage(ctypes.Structure):
        _fields_ = [('total', ctypes.c_uint64), ('available', ctypes.c_uint64),
                    ('used', ctypes.c_uint64), ('pageSize', ctypes.c_uint32),
                    ('encrypted', ctypes.c_int32)]

    lib.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p,
                                ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p,
                                ctypes.c_size_t]
    lib.sysctlbyname.restype = ctypes.c_int

    def memory():
        raw = subprocess.check_output(['sysctl', '-n', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage'], text=True, timeout=10)
        level = int(raw.strip().splitlines()[0])
        swap = SwapUsage()
        length = ctypes.c_size_t(ctypes.sizeof(swap))
        status = lib.sysctlbyname(b'vm.swapusage', ctypes.byref(swap), ctypes.byref(length), None, 0)
        if status != 0:
            raise OSError(ctypes.get_errno(), 'sysctlbyname vm.swapusage failed')
        if length.value != ctypes.sizeof(swap) or length.value != 32:
            raise RuntimeError(f'unexpected swapusage ABI size: {length.value}')
        return {'raw': raw, 'memoryPressureLevel': level,
                'memoryPressure': 'normal' if level == 1 else 'not-normal',
                'swapBytes': swap.used,
                'swapUsage': {'totalBytes': swap.total, 'availableBytes': swap.available,
                              'usedBytes': swap.used, 'pageSize': swap.pageSize,
                              'encrypted': bool(swap.encrypted)},
                'swapMeasurement': 'sysctlbyname xsw_usage exact integer bytes; CLI text is retained separately'}

    initial = memory()
    report['initialMemory'] = initial
    report['initialSwapBytes'] = initial['swapBytes']
    cpus, previous = cpu_ticks()
    report['cpuCount'] = cpus
    start = previous_at = time.monotonic()
    for index in range(60):
        time.sleep(1)
        current_cpus, current = cpu_ticks()
        now = time.monotonic()
        if current_cpus != cpus:
            raise RuntimeError('CPU roster changed during the admission window')
        delta = [(value - before) & 0xffffffff for value, before in zip(current, previous)]
        total = sum(delta)
        if total == 0:
            raise RuntimeError('CPU observation has no tick progress')
        idle = sum(delta[2::4])
        row = {'index': index, 'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'intervalSeconds': now - previous_at, 'cpuPercent': 100 * (total - idle) / total,
               'load1': os.getloadavg()[0], 'cpuTicks': current, 'cpuTickDelta': delta, **memory()}
        report['samples'].append(row)
        previous, previous_at = current, now
    report['durationSeconds'] = time.monotonic() - start
    report['verdict'] = 'admitted' if (
        initial['memoryPressure'] == 'normal' and report['durationSeconds'] >= 60 and
        all(row['cpuPercent'] <= 20 and row['load1'] <= 3 and row['memoryPressure'] == 'normal' and
            row['swapBytes'] <= (initial['swapBytes'] if index == 0 else report['samples'][index - 1]['swapBytes'])
            for index, row in enumerate(report['samples']))) else 'blocked'
    report['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
except Exception as error:
    report['error'] = repr(error)
finally:
    if lib is not None and host is not None:
        lib.mach_port_deallocate(task, host)
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
raise SystemExit(0 if report['verdict'] == 'admitted' else 2)
