#!/usr/bin/env python3
"""Offline native touch protocol, timeline, guard and release tests; no ADB/server."""
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import android_game_multitouch as subject
from android_game_input import TARGET_FIELDS
from test_android_game_input import CAPTURE
from wechatide import ToolFailure


def contact(pointer, x=100, y=200):
    return {'id': pointer, 'role': subject.ROLES[pointer], 'x': x, 'y': y}


def timeline():
    return {'schemaVersion': 'forgeax-gameplay-input/1',
            'coordinateSpace': {'width': 3200, 'height': 1440, 'unit': 'device-px'},
            'durationMs': 100,
            'phases': [{'name': name, 'startMs': i * 25, 'endMs': (i + 1) * 25}
                       for i, name in enumerate(('walk', 'run', 'jump', 'run-jump'))],
            'events': [
                {'atMs': 0, 'contacts': [contact(1), contact(2)]},
                {'atMs': 25, 'contacts': [contact(1, 110), contact(2, 120), contact(3)]},
                {'atMs': 50, 'contacts': [contact(1, 130), contact(2, 140)]},
                {'atMs': 75, 'contacts': [contact(1), contact(2), contact(3), contact(4)]},
                {'atMs': 100, 'contacts': []},
            ]}


class ClockEvent:
    def __init__(self):
        self.now = 1000.0
        self.cancelled = False

    def set(self):
        self.cancelled = True

    def is_set(self):
        return self.cancelled

    def wait(self, seconds):
        self.now += max(seconds, .000001)
        return self.cancelled


class Connection:
    def __init__(self, fail_at=None):
        self.messages = []
        self.fail_at = fail_at

    def settimeout(self, timeout):
        self.timeout = timeout

    def sendall(self, packet):
        if len(self.messages) == self.fail_at:
            self.messages.append(packet[:7])  # An unknown partial transport write.
            raise BrokenPipeError('fixture socket lost')
        self.messages.append(packet)


def decoded(messages):
    return [struct.unpack('>BBQiiHHHII', packet) for packet in messages]


def prepared():
    manifest = b'{"target":"wechat","project":"ordinary-game-fixture"}'
    screenshot = b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + struct.pack('!II', 3200, 1440)
    captured = CAPTURE | {'selectedManifestSha256': hashlib.sha256(manifest).hexdigest(),
                          'screenshotSha256': hashlib.sha256(screenshot).hexdigest()}
    return captured, manifest, screenshot


class ProtocolTests(unittest.TestCase):
    def run_schedule(self, connection=None, check=None, cancel=None):
        connection = connection or Connection()
        cancel = cancel or ClockEvent()
        with patch.object(subject.time, 'monotonic', side_effect=lambda: cancel.now):
            result = subject.dispatch_timeline(connection, timeline(), check or (lambda: None), cancel)
        return result, connection

    def test_socketpair_receives_exact_big_endian_native_messages(self):
        client, server = socket.socketpair()
        self.addCleanup(client.close)
        self.addCleanup(server.close)
        result, _ = self.run_schedule(connection=client)
        server.settimeout(.5)
        size = result['dispatchedMessages'] * 32
        payload = b''
        while len(payload) < size:
            payload += server.recv(size - len(payload))
        events = decoded([payload[i:i + 32] for i in range(0, size, 32)])
        self.assertEqual(events[0], (2, 0, 1, 100, 200, 3200, 1440, 65535, 0, 0))
        self.assertEqual(events[-1], (2, 1, 4, 100, 200, 3200, 1440, 0, 0, 0))
        self.assertEqual(result['state'], 'dispatched')
        self.assertEqual(result['releaseStatus'], 'up-messages-dispatched')

    def test_release_run_preserves_move_and_each_contact_has_independent_lifetime(self):
        result, connection = self.run_schedule()
        active = set()
        maximum = 0
        run_released_while_moving = False
        for _, action, pointer, *_ in decoded(connection.messages):
            if action == 0:
                self.assertNotIn(pointer, active)
                active.add(pointer)
            elif action == 1:
                self.assertIn(pointer, active)
                active.remove(pointer)
                if pointer == 3 and 1 in active:
                    run_released_while_moving = True
            else:
                self.assertIn(pointer, active)
            maximum = max(maximum, len(active))
        self.assertEqual(maximum, 4)
        self.assertTrue(run_released_while_moving)
        self.assertEqual(active, set())
        self.assertEqual(result['eventsDispatched'], 5)
        self.assertEqual(result['unreleasedPointerIds'], [])
        self.assertEqual(result['sendCostMs']['count'], result['attemptedMessages'])

    def test_cancel_stops_new_actions_and_releases_each_held_pointer(self):
        event = ClockEvent()
        connection = Connection()

        def check():
            if len(connection.messages) >= 2:
                event.set()
                raise subject.StopInput('cancelled')

        result, _ = self.run_schedule(connection, check, event)
        self.assertEqual(result['state'], 'cancelled')
        self.assertEqual([(x[1], x[2]) for x in decoded(connection.messages)],
                         [(0, 1), (0, 2), (1, 1), (1, 2)])
        self.assertEqual(result['cleanupUpMessages'], 2)
        self.assertEqual(result['releaseStatus'], 'up-messages-dispatched')

    def test_guard_failure_and_rotation_change_release_all_before_return(self):
        for reason in ['guard-failed: rotation', 'guard-failed: foreground changed', 'guard-stale']:
            connection = Connection()

            def check():
                if len(connection.messages) >= 2:
                    raise subject.StopInput(reason)

            result, _ = self.run_schedule(connection, check)
            self.assertEqual(result['state'], 'stopped')
            self.assertEqual(result['reason'], reason)
            self.assertEqual(result['cleanupUpMessages'], 2)

    def test_partial_write_does_not_corrupt_stream_with_more_packets_or_claim_release(self):
        result, connection = self.run_schedule(Connection(fail_at=1))
        self.assertEqual(result['state'], 'failed')
        self.assertEqual(result['releaseStatus'], 'unknown')
        self.assertEqual(result['unreleasedPointerIds'], [1, 2])
        self.assertEqual(result['attemptedMessages'], 2)
        self.assertEqual(len(connection.messages), 2)
        self.assertEqual(len(connection.messages[-1]), 7)

    def test_release_transport_failure_is_unknown_and_never_retried(self):
        connection = Connection(fail_at=2)

        def check():
            if len(connection.messages) >= 2:
                raise subject.StopInput('cancelled')

        result, _ = self.run_schedule(connection, check)
        self.assertEqual(result['state'], 'failed')
        self.assertEqual(result['releaseStatus'], 'unknown')
        self.assertEqual(result['unreleasedPointerIds'], [1, 2])
        self.assertEqual(len(connection.messages), 3)

    def test_deadline_overrun_does_not_burst_delayed_actions(self):
        cancel, connection = ClockEvent(), Connection()

        def check():
            if len(connection.messages) == 2:
                cancel.now += .2

        result, _ = self.run_schedule(connection, check, cancel)
        self.assertEqual(result['reason'], 'dispatch-deadline-missed')
        self.assertEqual(result['eventsDispatched'], 1)
        self.assertEqual(result['cleanupUpMessages'], 2)

    def test_external_future_start_waits_without_sending_and_retains_origin(self):
        event, connection = ClockEvent(), Connection()
        sent_at = []
        original = connection.sendall
        connection.sendall = lambda packet: (sent_at.append(event.now), original(packet))
        with patch.object(subject.time, 'monotonic', side_effect=lambda: event.now):
            result = subject.dispatch_timeline(connection, timeline(), lambda: None, event,
                                               start_monotonic=1002)
        self.assertGreaterEqual(min(sent_at), 1002)
        self.assertEqual(result['startedMonotonicMs'], 1002000)
        self.assertEqual(result['state'], 'dispatched')
        with patch.object(subject.time, 'monotonic', return_value=1000):
            for invalid in (999.999, 1011, float('nan')):
                with self.assertRaises(ToolFailure):
                    subject.dispatch_timeline(Connection(), timeline(), lambda: None, event,
                                              start_monotonic=invalid)


class BindingTests(unittest.TestCase):
    def test_shared_javascript_generator_passes_native_validation_and_protocol_replay(self):
        module = (Path(__file__).resolve().parent / 'fixtures/gameplay-benchmark/timeline.mjs').as_uri()
        source = 'import {createGameplayTimeline} from ' + json.dumps(module) + ';\n' + """
const geometry = {
  move: {x: 20, y: 1100, width: 240, height: 240},
  look: {x: 700, y: 300, width: 1200, height: 500},
  run: {x: 2700, y: 1100, width: 160, height: 160},
  jump: {x: 2920, y: 1100, width: 160, height: 160},
};
console.log(JSON.stringify(createGameplayTimeline({geometry,
  coordinateSpace: {width: 3200, height: 1440, unit: 'device-px'}, phaseMs: 1000})));
"""
        response = subprocess.run(['node', '--input-type=module', '-e', source],
                                  capture_output=True, check=True, timeout=10)
        shared = json.loads(response.stdout)
        subject.validate_timeline(shared, 3200, 1440)
        clock, connection = ClockEvent(), Connection()
        with patch.object(subject.time, 'monotonic', side_effect=lambda: clock.now):
            result = subject.dispatch_timeline(connection, shared, lambda: None, clock)
        self.assertEqual(result['state'], 'dispatched')
        self.assertEqual(result['eventsDispatched'], len(shared['events']))
        self.assertEqual(result['releaseStatus'], 'up-messages-dispatched')

    def test_exact_manifest_screenshot_and_display_bound_to_prepared_capture(self):
        captured, manifest, screenshot = prepared()
        self.assertEqual(subject.verify_inputs('selected-phone', captured, manifest, screenshot, timeline()),
                         {field: captured[field] for field in TARGET_FIELDS})
        for args in [('another-phone', captured, manifest, screenshot, timeline()),
                     ('selected-phone', captured, manifest + b' ', screenshot, timeline()),
                     ('selected-phone', captured, manifest, screenshot + b' ', timeline()),
                     ('selected-phone', captured | {'rotation': 4}, manifest, screenshot, timeline())]:
            with self.subTest(args=args), self.assertRaises(ToolFailure):
                subject.verify_inputs(*args)

    def test_rejects_invalid_native_schedule_before_any_device_operation(self):
        invalid = []
        for key, value in [('unit', 'css-px'), ('width', 3199), ('height', True)]:
            item = timeline()
            item['coordinateSpace'][key] = value
            invalid.append(item)
        for mutation in [
            lambda t: t['events'][0]['contacts'].append(contact(1)),
            lambda t: t['events'][0]['contacts'].append({'id': 5, 'role': 'jump', 'x': 1, 'y': 1}),
            lambda t: t['events'][0]['contacts'][0].update(role='look'),
            lambda t: t['events'][0]['contacts'][0].update(x=3200),
            lambda t: t['events'][0]['contacts'][0].update(y=-1),
            lambda t: t['events'][0]['contacts'][0].update(x=1.5),
            lambda t: t['events'][0]['contacts'][0].update(id=True),
            lambda t: t['events'][1].update(atMs=0),
            lambda t: t['events'][-1].update(contacts=[contact(1)]),
            lambda t: t.update(durationMs=120001),
            lambda t: t.update(durationMs=float('nan')),
            lambda t: t['phases'][1].update(startMs=24),
        ]:
            item = timeline()
            mutation(item)
            invalid.append(item)
        captured, manifest, screenshot = prepared()
        with patch.object(subject, 'control_session') as owner, patch.object(subject.subprocess, 'run') as adb:
            for item in invalid:
                with self.subTest(item=item):
                    result, code = subject.perform_timeline('/adb', 'selected-phone', Path('/cache'),
                        captured, manifest, screenshot, item, threading.Event())
                    self.assertEqual(code, 1)
                    self.assertEqual(result['state'], 'blocked')
                    self.assertFalse(result['attempted'])
            owner.assert_not_called()
            adb.assert_not_called()

    def test_preflight_target_change_does_not_start_scrcpy_session(self):
        captured, manifest, screenshot = prepared()
        expected = {field: captured[field] for field in TARGET_FIELDS}
        with patch.object(subject, 'control_session') as owner, patch.object(subject, 'input_target', return_value=expected | {'pid': 999}):
            result, code = subject.perform_timeline('/adb', 'selected-phone', Path('/cache'),
                captured, manifest, screenshot, timeline(), threading.Event())
        self.assertEqual(code, 1)
        self.assertFalse(result['attempted'])
        self.assertIn('pid', result['guard']['failure'])
        owner.assert_not_called()

    def test_guard_read_cost_is_separate_from_socket_dispatch_and_thread_is_closed(self):
        captured, manifest, screenshot = prepared()
        expected = {field: captured[field] for field in TARGET_FIELDS}
        connection = Connection()

        def session(_adb, _serial, _cache, execute):
            return {'status': 'control-session-closed', 'execution': execute(connection)}

        with patch.object(subject, 'control_session', side_effect=session), patch.object(subject, 'input_target', return_value=expected):
            result, code = subject.perform_timeline('/adb', 'selected-phone', Path('/cache'),
                captured, manifest, screenshot, timeline(), threading.Event())
        self.assertEqual(code, 0)
        self.assertEqual(result['guard']['costMs']['count'], 2)
        self.assertTrue(result['guard']['stopped'])
        self.assertGreater(result['session']['execution']['sendCostMs']['count'], 2)

    def test_cli_private_receipt_hashes_inputs_and_stdout_redacts_serial(self):
        captured, manifest, screenshot = prepared()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, data in [('capture.json', json.dumps(captured).encode()), ('screen.png', screenshot),
                               ('forgeax-dist.json', manifest), ('timeline.json', json.dumps(timeline()).encode())]:
                (root / name).write_bytes(data)
            out = root / 'out'
            args = ['android_game_multitouch.py', '--adb', '/adb', '--serial', 'selected-phone',
                    '--cache', str(root / 'cache'), '--capture-result', str(root / 'capture.json'),
                    '--screenshot', str(root / 'screen.png'), '--manifest', str(root / 'forgeax-dist.json'),
                    '--timeline', str(root / 'timeline.json'), '--out', str(out)]
            printed = io.StringIO()
            with patch('sys.argv', args), patch.object(subject, 'perform_timeline', return_value=(
                    {'state': 'dispatched', 'attempted': True, 'serial': 'selected-phone'}, 0)), contextlib.redirect_stdout(printed):
                self.assertEqual(subject.main(), 0)
            result = json.loads((out / 'result.json').read_text())
            self.assertIn('timelineSha256', result)
            self.assertIn('captureResultSha256', result)
            self.assertNotIn('selected-phone', printed.getvalue())
            self.assertEqual(out.stat().st_mode & 0o777, 0o700)
            self.assertEqual((out / 'result.json').stat().st_mode & 0o777, 0o600)


class GuardTests(unittest.TestCase):
    def test_all_identity_and_rotation_changes_stop_the_guard(self):
        expected = {field: CAPTURE[field] for field in TARGET_FIELDS}
        for field in TARGET_FIELDS:
            current = copy.deepcopy(expected)
            current[field] = 'changed' if isinstance(current[field], str) else current[field] + 1
            guard = subject.TargetGuard(lambda: current, expected, threading.Event())
            guard.sample()
            with self.subTest(field=field), self.assertRaisesRegex(subject.StopInput, field):
                guard.check()

    def test_staleness_uses_start_of_sample_and_cancellation_is_bounded(self):
        clock = ClockEvent()

        def observe():
            clock.now += 3
            return {'pid': 1}

        guard = subject.TargetGuard(observe, {'pid': 1}, clock)
        with patch.object(subject.time, 'monotonic', side_effect=lambda: clock.now):
            guard.sample()
            with self.assertRaisesRegex(subject.StopInput, 'guard-stale'):
                guard.check()
            clock.set()
            with self.assertRaisesRegex(subject.StopInput, 'cancelled'):
                guard.check()
        self.assertEqual(guard.receipt()['costMs']['max'], 3000)

    def test_background_slow_guard_does_not_block_dispatch_thread_and_stops_cleanly(self):
        main_thread = threading.get_ident()
        samples = []
        blocked = threading.Event()
        finish = threading.Event()

        def observe():
            samples.append(threading.get_ident())
            if len(samples) > 1:
                blocked.set()
                finish.wait(1)
            return {'pid': 1}

        guard = subject.TargetGuard(observe, {'pid': 1}, threading.Event(), period_ms=1, max_age_ms=20)
        guard.start()
        try:
            self.assertTrue(blocked.wait(.5))
            # check() reads the completed guard snapshot, never calls observe/ADB.
            guard.check()
            self.assertNotEqual(samples[1], main_thread)
            time.sleep(.025)
            with self.assertRaisesRegex(subject.StopInput, 'guard-stale'):
                guard.check()
        finally:
            finish.set()
            guard.close(1)
        self.assertTrue(guard.receipt()['stopped'])


if __name__ == '__main__':
    unittest.main()
