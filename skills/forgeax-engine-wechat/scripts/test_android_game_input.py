#!/usr/bin/env python3
"""Offline input guards only: never connect to a phone or send native input."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from android_game_input import main, perform_input
from test_android_game_capture import ACTIVITY, FOREGROUND, POLICY, WINDOWS, activities, display


CAPTURE = {'state': 'captured', 'serial': 'selected-phone', 'activityRecord': 'abcd',
           'userId': 0, 'activity': ACTIVITY, 'taskId': 350, 'pid': 314,
           'displayId': 0, 'rotation': 1, 'width': 3200, 'height': 1440,
           'screenshotSha256': 'a' * 64, 'selectedManifestSha256': 'b' * 64}
TAP = {'kind': 'tap', 'x': 3199, 'y': 1439}


def responses(values):
    return patch('android_game_input.subprocess.run', side_effect=[
        value if isinstance(value, (BaseException, subprocess.CompletedProcess))
        else subprocess.CompletedProcess([], 0, value, b'') for value in values])


def preflight(viewport=None, windows=WINDOWS, policy=POLICY, activity=FOREGROUND):
    return [b'device', display() if viewport is None else viewport, windows, policy, activity]


def action(captured=CAPTURE, selected=TAP):
    return perform_input({}, '/adb', 'selected-phone', captured, selected)


class InputTests(unittest.TestCase):
    def assert_blocked(self, values, captured=CAPTURE, selected=TAP):
        with responses(values) as run:
            result, code = action(captured, selected)
        self.assertEqual(code, 1)
        self.assertEqual(result['state'], 'blocked')
        self.assertFalse(result['attempted'])
        self.assertFalse(any('input' in call.args[0] for call in run.call_args_list))
        return result

    def test_taps_once_after_all_guards_and_preserves_exact_private_identity(self):
        with responses([*preflight(), b'']) as run:
            result, code = action()
        self.assertEqual(code, 0)
        self.assertEqual(result['state'], 'dispatched')
        self.assertEqual(result['serial'], 'selected-phone')
        self.assertEqual(result['before']['pid'], 314)
        self.assertEqual(run.call_count, 6)
        self.assertEqual(run.call_args.args[0], ['/adb', '-s', 'selected-phone', 'shell', 'input',
                                               'touchscreen', '-d', '0', 'tap', '3199', '1439'])

    def test_one_swipe_or_editing_key_is_not_a_batch_or_text_injection(self):
        for selected, tail in [
            ({'kind': 'swipe', 'x': 0, 'y': 0, 'endX': 300, 'endY': 150, 'durationMs': 800},
             ['touchscreen', '-d', '0', 'swipe', '0', '0', '300', '150', '800']),
            ({'kind': 'keyevent', 'key': 'DEL'}, ['keyboard', '-d', '0', 'keyevent', 'KEYCODE_DEL']),
        ]:
            with self.subTest(selected=selected), responses([*preflight(), b'']) as run:
                result, code = action(selected=selected)
            self.assertEqual(code, 0)
            self.assertEqual(result['state'], 'dispatched')
            self.assertEqual(run.call_args.args[0][4:], ['input', *tail])
            self.assertEqual(sum('input' in call.args[0] for call in run.call_args_list), 1)

    def test_rejects_other_app_or_more_than_one_resumed_activity(self):
        other = b'topResumedActivity=ActivityRecord{face u0 com.example/.Mail t7}\n'
        self.assert_blocked(preflight(activity=other))
        self.assert_blocked(preflight(activity=FOREGROUND + other))
        extra = f'mResumedActivity=ActivityRecord{{feed u0 {ACTIVITY} t351}}\n'.encode()
        self.assert_blocked(preflight(activity=FOREGROUND + extra))

    def test_rejects_each_changed_activity_identity_field(self):
        for changed in [activities(record='bcde'), activities(task=351), activities(user=1), activities(pid=315)]:
            with self.subTest(changed=changed):
                self.assert_blocked(preflight(activity=changed))

    def test_rejects_focused_window_app_task_user_and_display_mismatch(self):
        for changed in [
            WINDOWS.replace(b'Window{bead u0 com.tencent.mm/com.tencent.mm.plugin.appbrand.ui.AppBrandUI1}',
                            b'Window{bead u0 com.example/.Mail}'),
            WINDOWS.replace(b'Window{bead u0', b'Window{bead u1'),
            WINDOWS.replace(b'ActivityRecord{abcd', b'ActivityRecord{bcde'),
            WINDOWS.replace(b't350}', b't351}'),
            WINDOWS.replace(b'mTopFocusedDisplayId=0', b'mTopFocusedDisplayId=1'),
            WINDOWS + b'mCurrentFocus=null\n', b'',
        ]:
            with self.subTest(changed=changed):
                self.assert_blocked(preflight(windows=changed))

    def test_rejects_locked_asleep_restricted_and_unknown_policy(self):
        for changed in [POLICY.replace(b'showing=false', b'showing=true'),
                        POLICY.replace(b'mIsShowing=false', b'mIsShowing=true'),
                        POLICY.replace(b'inputRestricted=false', b'inputRestricted=true'),
                        POLICY + b'interactiveState=INTERACTIVE_STATE_SLEEP\n', b'']:
            with self.subTest(changed=changed):
                self.assert_blocked(preflight(policy=changed))
        self.assert_blocked(preflight(activity=FOREGROUND + b'mKeyguardShowing=true\n'))
        self.assert_blocked(preflight(activity=FOREGROUND + b'mAwake=false\n'))
        self.assert_blocked(preflight(windows=WINDOWS.replace(b'mDreamingLockscreen=false', b'mDreamingLockscreen=true')))

    def test_rejects_rotation_even_when_width_height_match(self):
        self.assert_blocked(preflight(viewport=display(rotation=3)))
        self.assert_blocked(preflight(viewport=display(width=1440, height=3200)))
        for changed in [b'', display() + display(), display().replace(b'isActive=true', b'isActive=false'),
                        display().replace(b'orientation=1', b'orientation=unknown')]:
            with self.subTest(changed=changed):
                self.assert_blocked([b'device', changed])

    def test_rejects_stale_capture_phone_and_unprepared_display_before_adb(self):
        for changed in [CAPTURE | {'serial': 'another-phone'}, CAPTURE | {'state': 'failed'},
                        {k: v for k, v in CAPTURE.items() if k != 'rotation'},
                        CAPTURE | {'width': True}, CAPTURE | {'pid': 0}, CAPTURE | {'displayId': 1}]:
            with self.subTest(changed=changed):
                self.assert_blocked([], captured=changed)

    def test_rejects_coordinate_edges_nonintegers_and_duration_before_adb(self):
        for changed in [TAP | {'x': -1}, TAP | {'x': 3200}, TAP | {'y': 1440}, TAP | {'x': 1.5},
                        TAP | {'x': True},
                        {'kind': 'swipe', 'x': 0, 'y': 0, 'endX': 3200, 'endY': 0, 'durationMs': 1},
                        {'kind': 'swipe', 'x': 0, 'y': 0, 'endX': 1, 'endY': 0, 'durationMs': 0},
                        {'kind': 'swipe', 'x': 0, 'y': 0, 'endX': 1, 'endY': 0, 'durationMs': 5001}]:
            with self.subTest(changed=changed):
                self.assert_blocked([], selected=changed)

    def test_rejects_text_arbitrary_keycode_and_shell_arguments(self):
        for changed in [{'kind': 'text', 'text': '3.5'}, {'kind': 'keyevent', 'key': 'HOME'},
                        {'kind': 'keyevent', 'key': 'DEL; am start com.example'},
                        TAP | {'extra': 'sh -c command'}]:
            with self.subTest(changed=changed):
                self.assert_blocked([], selected=changed)

    def test_input_failure_or_timeout_is_bounded_recorded_and_never_retried(self):
        for failure in [subprocess.CompletedProcess([], 7, b'output' * 5000, b'failure' * 5000),
                        subprocess.CompletedProcess([], 0, b'', b'Error: input injection denied'),
                        subprocess.TimeoutExpired(['redacted'], 20)]:
            with self.subTest(failure=failure), responses([*preflight(), failure]) as run:
                result, code = action()
            self.assertEqual(code, 1)
            self.assertEqual(result['state'], 'failed')
            self.assertTrue(result['attempted'])
            self.assertTrue(result['mayHaveExecuted'])
            self.assertFalse(result['retryAutomatically'])
            self.assertEqual(result['error']['stage'], 'input')
            self.assertEqual(run.call_count, 6)
            self.assertLess(len(json.dumps(result)), 6000)

    def test_unavailable_adb_is_a_preflight_failure_without_input(self):
        self.assert_blocked([b'unauthorized'])
        self.assert_blocked([subprocess.CompletedProcess([], 1, b'', b'offline')])
        self.assert_blocked([subprocess.TimeoutExpired(['redacted'], 20)])

    def test_cli_writes_private_receipt_and_redacts_serial_from_stdout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            previous = root / 'capture.json'
            previous.write_text(json.dumps(CAPTURE))
            out = root / 'action'
            argv = ['android_game_input.py', '--adb', '/adb', '--serial', 'selected-phone',
                    '--capture-result', str(previous), '--out', str(out), 'tap', '10', '20']
            printed = io.StringIO()
            with patch('sys.argv', argv), responses([*preflight(), b'']), contextlib.redirect_stdout(printed):
                self.assertEqual(main(), 0)
            receipt = json.loads((out / 'result.json').read_text())
            self.assertEqual(receipt['serial'], 'selected-phone')
            self.assertNotIn('selected-phone', printed.getvalue())
            self.assertEqual(out.stat().st_mode & 0o777, 0o700)
            self.assertEqual((out / 'result.json').stat().st_mode & 0o777, 0o600)
            self.assertIn('captureResultSha256', receipt)


if __name__ == '__main__':
    unittest.main()
