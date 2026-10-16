#!/usr/bin/env python3
"""Offline checks: no device, server, forwarding, download or input is executed."""
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import scrcpy_handshake as subject


class Connection:
    def __init__(self, first):
        self.first = first
        self.closed = False

    def settimeout(self, _timeout):
        pass

    def recv(self, size):
        assert size == 1
        return self.first

    def send(self, _data):
        raise AssertionError('handshake helper must never send input')

    sendall = send

    def close(self):
        self.closed = True


class Process:
    returncode = None

    def poll(self):
        return self.returncode

    def communicate(self, timeout):
        self.returncode = 0 if self.returncode is None else self.returncode
        return 'server log', ''

    def terminate(self):
        self.returncode = -15


class HandshakeTests(unittest.TestCase):
    def exercise(self, first=b'\x00', forward_failure=False, residual_jar=False,
                 process_lines='111 unrelated-process', execute=None):
        commands = []
        connection = Connection(first)
        process = Process()
        jar_present = residual_jar

        def run(argv, **_kwargs):
            nonlocal jar_present
            self.assertEqual(argv[:3], ['/adb', '-s', 'selected-device'])
            arguments = argv[3:]
            commands.append(arguments)
            status, stdout, stderr = 0, '', ''
            if arguments == ['get-state']:
                stdout = 'device\n'
            elif arguments[0] == 'push':
                pass
            elif arguments[:2] == ['forward', 'tcp:0']:
                status, stdout, stderr = (1, '', 'forward failed') if forward_failure else (0, '27183\n', '')
            elif arguments == ['forward', '--remove', 'tcp:27183']:
                pass
            elif arguments[:4] == ['shell', 'test', '!', '-e']:
                status = int(jar_present)
            elif arguments[:3] == ['shell', 'rm', '-f']:
                self.assertEqual(arguments[3], '/data/local/tmp/forgeax-scrcpy-00000001.jar')
                jar_present = False
            elif arguments == ['shell', 'ps', '-A', '-o', 'PID,ARGS']:
                stdout = process_lines
            else:
                self.fail(f'unexpected device command: {arguments}')
            return SimpleNamespace(returncode=status, stdout=stdout, stderr=stderr)

        with ExitStack() as stack:
            stack.enter_context(patch.object(subject, 'verified_server', return_value=Path('/cache/server')))
            stack.enter_context(patch.object(subject.secrets, 'randbelow', return_value=0))
            stack.enter_context(patch.object(subject.subprocess, 'run', side_effect=run))
            launch = stack.enter_context(patch.object(subject.subprocess, 'Popen', return_value=process))
            connect = stack.enter_context(patch.object(subject.socket, 'create_connection', return_value=connection))
            report = subject.control_session('/adb', 'selected-device', Path('/cache'), execute)
        return report, commands, connection, launch, connect

    def test_zero_handshake_closes_owned_resources_without_input(self):
        report, commands, connection, launch, _ = self.exercise()
        self.assertEqual(report['status'], 'handshake-only-passed')
        self.assertEqual(report['inputMessagesSent'], 0)
        self.assertTrue(connection.closed)
        self.assertIn(['forward', '--remove', 'tcp:27183'], commands)
        self.assertTrue(report['jarRemoved'])
        self.assertFalse(report['serverProcessRemains'])
        self.assertIn('video=false', launch.call_args.args[0])
        self.assertIn('clipboard_autosync=false', launch.call_args.args[0])

    def test_unexpected_handshake_still_cleans_exact_forward_and_process(self):
        report, commands, connection, _, _ = self.exercise(first=b'\x01')
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(connection.closed)
        self.assertTrue(report['serverTerminationRequired'])
        self.assertIn(['forward', '--remove', 'tcp:27183'], commands)

    def test_failed_forward_removes_only_its_partial_jar_without_starting_server(self):
        report, commands, _, launch, connect = self.exercise(forward_failure=True, residual_jar=True)
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(report['jarRemoved'])
        self.assertIn(['shell', 'rm', '-f', '/data/local/tmp/forgeax-scrcpy-00000001.jar'], commands)
        launch.assert_not_called()
        connect.assert_not_called()

    def test_remaining_matching_server_cannot_pass_but_other_sessions_can(self):
        report, *_ = self.exercise(process_lines='12 com.genymobile.scrcpy.Server scid=00000001')
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(report['serverProcessRemains'])
        report, *_ = self.exercise(process_lines='12 com.genymobile.scrcpy.Server scid=00000002')
        self.assertEqual(report['status'], 'handshake-only-passed')

    def test_corrupt_cached_server_fails_before_any_device_or_network_operation(self):
        with TemporaryDirectory() as directory:
            cache = Path(directory)
            (cache / f'scrcpy-server-v{subject.VERSION}').write_bytes(b'corrupt')
            with patch.object(subject.subprocess, 'run') as run, patch.object(subject.urllib.request, 'urlopen') as network:
                report = subject.handshake('/adb', 'selected-device', cache)
            self.assertEqual(report['status'], 'failed')
            self.assertIn('SHA256', report['error'])
            run.assert_not_called()
            network.assert_not_called()

    def test_control_consumer_uses_same_connection_owner_and_cleanup(self):
        def execute(connection):
            self.assertFalse(connection.closed)
            return {'state': 'dispatched', 'qualification': 'fixture only'}
        report, commands, connection, _, _ = self.exercise(execute=execute)
        self.assertEqual(report['status'], 'control-session-closed')
        self.assertEqual(report['execution']['state'], 'dispatched')
        self.assertNotIn('inputMessagesSent', report)
        self.assertTrue(connection.closed)
        self.assertEqual(commands.count(['forward', '--remove', 'tcp:27183']), 1)

    def test_control_consumer_failure_still_closes_owned_resources(self):
        def execute(_connection):
            raise RuntimeError('consumer failed after its release finally')
        report, commands, connection, _, _ = self.exercise(execute=execute)
        self.assertEqual(report['status'], 'failed')
        self.assertIn('consumer failed', report['error'])
        self.assertTrue(connection.closed)
        self.assertTrue(report['jarRemoved'])
        self.assertFalse(report['serverProcessRemains'])
        self.assertEqual(commands.count(['forward', '--remove', 'tcp:27183']), 1)


if __name__ == '__main__':
    unittest.main()
