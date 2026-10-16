import unittest
from android_headroom import cpu_ticks, interval, memory_kib, process_ticks


class HeadroomTests(unittest.TestCase):
    def test_guest_is_not_counted_twice(self):
        self.assertEqual(cpu_ticks('cpu  10 5 20 50 7 2 3 4 9 1\n'),
                         {'total': 101, 'idle': 50, 'iowait': 7})

    def test_process_identity_and_ticks_survive_spaces_in_comm(self):
        values = ['S'] + ['0'] * 19
        values[11], values[12], values[19] = '11', '7', '12345'
        self.assertEqual(process_ticks('34 (a name ) here) ' + ' '.join(values)),
                         {'pid': 34, 'startTicks': 12345, 'cpuTicks': 18})

    def test_machine_cpu_share_and_reused_pid(self):
        old = {'endMonotonic': 1, 'cpu': {'total': 100, 'idle': 30, 'iowait': 2},
               'process': {'pid': 7, 'startTicks': 123, 'cpuTicks': 10}}
        new = {'endMonotonic': 6, 'cpu': {'total': 200, 'idle': 100, 'iowait': 7},
               'process': {'pid': 7, 'startTicks': 123, 'cpuTicks': 20}}
        result = interval(old, new)
        self.assertEqual((result['idlePercent'], result['ioWaitPercent'],
                          result['processMachineCpuPercent']), (70, 5, 10))
        new['process']['startTicks'] = 456
        result = interval(old, new)
        self.assertEqual(result['processStatus'], 'identity-changed')
        self.assertNotIn('processMachineCpuPercent', result)
        new['cpu']['total'] = 90
        self.assertEqual(interval(old, new)['reason'], 'cpu-counters-regressed')

    def test_memory_units_are_preserved(self):
        self.assertEqual(memory_kib('VmRSS:\t128 kB\nVmSwap: 64 kB\nThreads: 20\n'),
                         {'VmRSS': 128, 'VmSwap': 64})


if __name__ == '__main__':
    unittest.main()
