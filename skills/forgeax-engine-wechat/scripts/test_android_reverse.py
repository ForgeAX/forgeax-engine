"""Offline reverse-ownership checks; no device connection."""
import unittest
from android_reverse import ensure_reverse


class ReverseOwnership(unittest.TestCase):
    def check(self, inventory):
        calls = []
        def run(arguments):
            nonlocal inventory
            calls.append(arguments)
            if arguments[:2] == ['reverse', '--no-rebind']:
                inventory += f'UsbFfs {arguments[2]} {arguments[3]}\n'
            return inventory if arguments == ['reverse', '--list'] else ''
        return calls, run

    def test_retains_matching_mapping_without_mutation(self):
        calls, run = self.check('UsbFfs tcp:19143 tcp:19143\n')
        self.assertEqual(ensure_reverse(run, 19143), 'retained')
        self.assertEqual(calls, [['reverse', '--list']])

    def test_restores_only_missing_selected_port(self):
        calls, run = self.check('UsbFfs tcp:19144 tcp:19144\n')
        self.assertEqual(ensure_reverse(run, 19143), 'restored')
        self.assertEqual(calls[1], ['reverse', '--no-rebind', 'tcp:19143', 'tcp:19143'])
        self.assertEqual(calls[-1], ['reverse', '--list'])

    def test_rejects_foreign_mapping(self):
        calls, run = self.check('UsbFfs tcp:19143 tcp:20000\n')
        with self.assertRaises(ValueError):
            ensure_reverse(run, 19143)
        self.assertEqual(len(calls), 1)

    def test_does_not_report_a_lost_install_as_restored(self):
        calls = []
        def run(arguments):
            calls.append(arguments)
            return ''
        with self.assertRaisesRegex(ValueError, 'not established'):
            ensure_reverse(run, 19143)
        self.assertEqual(calls[-1], ['reverse', '--list'])

    def test_rejects_malformed_or_ambiguous_inventory(self):
        for inventory in ['tcp:19143 tcp:19143',
                          'UsbFfs tcp:19143 tcp:19143\nUsbFfs tcp:19143 tcp:19143']:
            calls, run = self.check(inventory)
            with self.assertRaises(ValueError):
                ensure_reverse(run, 19143)
            self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
