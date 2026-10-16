#!/usr/bin/env python3
"""GPU attribution must preserve process identity and counter discontinuities."""
import unittest

from mac_headroom import gpu_owner_interval, gpu_owners


def client(registry_id, pid, counter, entries=1):
    return {'registryId': registry_id, 'pid': pid, 'name': 'GPU process',
            'apiEntries': entries, 'accumulatedGPUTime': counter}


def sample(rows, time):
    return {'owners': rows, 'atUtc': str(time), 'monotonicNs': time}


class AttributionTests(unittest.TestCase):
    def test_selects_only_gpu_client_identity_and_counters(self):
        tree = [{'IORegistryEntryChildren': [
            {'IORegistryEntryID': 8, 'IOUserClientCreator': 'pid 20, GPU process',
             'AppUsage': [{'API': 'Metal', 'accumulatedGPUTime': 30},
                          {'API': 'Metal', 'accumulatedGPUTime': 12}],
             'UnrelatedPrivateProperty': 'never export'},
            {'IORegistryEntryID': 9, 'IOUserClientCreator': 'pid 21, GPU process',
             'AppUsage': [{'API': 'Metal'}]},
        ]}]
        self.assertEqual(gpu_owners(tree), [client(8, 20, 42, 2)])

    def test_sums_same_process_clients_without_confusing_cpu_time(self):
        before = sample([client(8, 20, 100), client(9, 20, 500), client(10, 21, 90)], 10)
        after = sample([client(8, 20, 110), client(9, 20, 540), client(10, 21, 90)], 20)
        result = gpu_owner_interval(before, after)
        self.assertEqual(result['status'], 'available')
        self.assertEqual(result['elapsedNs'], 10)
        self.assertEqual([(r['pid'], r['accumulatedGPUTimeDelta']) for r in result['owners']],
                         [(20, 50), (21, 0)])

    def test_reset_replacement_and_missing_clients_are_partial_not_zero(self):
        before = sample([client(1, 20, 100), client(2, 21, 200), client(3, 22, 300),
                         client(4, 23, 400), client(5, 24, 500)], 10)
        after = sample([client(1, 20, 5), client(2, 31, 250), client(3, 22, 400, 2),
                        client(5, 24, 550), client(6, 25, 600)], 20)
        result = gpu_owner_interval(before, after)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['unmatchedClients'], [1, 2, 3, 4, 6])
        self.assertEqual(result['owners'], [{'pid': 24, 'name': 'GPU process',
                                             'accumulatedGPUTimeDelta': 50}])
        self.assertEqual(gpu_owner_interval(sample([], 10), sample([], 20))['status'], 'partial')


if __name__ == '__main__':
    unittest.main()
