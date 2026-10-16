#!/usr/bin/env python3
"""Offline checks only: no Android connection or device actions."""
import struct
import subprocess
import unittest
from unittest.mock import patch

from android_game_capture import capture
from wechatide import ToolFailure


ACTIVITY = 'com.tencent.mm/.plugin.appbrand.ui.AppBrandUI1'


def activities(record='abcd', task=350, pid=314, user=0, selected_process=True):
    # Sanitized shape of the real activities dump. The same component is present
    # in an older task too; only the exact resumed record owns the capture PID.
    process = f'      app=ProcessRecord{{1234 {pid}:com.tencent.mm:appbrand1/u0a319}}\n' if selected_process else ''
    return (f'  topResumedActivity=ActivityRecord{{{record} u{user} {ACTIVITY} t{task}}}\n'
            f'    * Hist  #1: ActivityRecord{{feed u0 {ACTIVITY} t333}}\n'
            '      app=ProcessRecord{9999 999:com.tencent.mm:appbrand1/u0a319}\n'
            f'    * Hist  #0: ActivityRecord{{{record} u{user} {ACTIVITY} t{task}}}\n'
            + process +
            '    * Hist  #0: ActivityRecord{beef u0 com.example/.Unrelated t222}\n'
            '      app=ProcessRecord{5678 555:com.example/u0a1}\n').encode()


FOREGROUND = activities()
PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + struct.pack('!II', 3200, 1440)


def display(rotation=1, width=3200, height=1440):
    # Sanitized Android 16 dumpsys display viewport; wm size stays 1440x3200.
    return (f'mViewports=[DisplayViewport{{type=INTERNAL, valid=true, isActive=true, '
            f'displayId=0, uniqueId=local:fixture, orientation={rotation}, '
            f'logicalFrame=Rect(0, 0 - {width}, {height}), '
            'physicalFrame=Rect(0, 0 - 1440, 3200), deviceWidth=1440, deviceHeight=3200}]').encode()


WINDOWS = (f'  mCurrentFocus=Window{{bead u0 com.tencent.mm/com.tencent.mm.plugin.appbrand.ui.AppBrandUI1}}\n'
           f'  mFocusedApp=ActivityRecord{{abcd u0 {ACTIVITY} t350}}\n'
           '  mTopFocusedDisplayId=0\n  mDreamingLockscreen=false\n').encode()
POLICY = b'  KeyguardServiceDelegate\n    showing=false\n    inputRestricted=false\n    mIsShowing=false\n'


class CaptureTests(unittest.TestCase):
    def responses(self, values):
        return patch('android_game_capture.subprocess.run', side_effect=[
            subprocess.CompletedProcess([], 0, value, b'') for value in values])

    def test_rejects_other_foreground_before_screenshot(self):
        with self.responses([b'device', b'topResumedActivity=ActivityRecord{abcd u0 com.example/.Launcher t1}']) as run:
            with self.assertRaises(ToolFailure):
                capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
        self.assertEqual(run.call_count, 2)
        self.assertTrue(all('screencap' not in call.args[0] for call in run.call_args_list))

    def test_captures_landscape_extent_and_only_selected_process_logs(self):
        with self.responses([b'device', FOREGROUND, PNG, FOREGROUND,
                             b'first\nsecond\nthird\n', FOREGROUND]) as run:
            result, image, logs = capture({}, '/adb', 'selected-phone', ACTIVITY, 10,
                                          '10-11 12:00:00.000', 2)
        self.assertEqual((result['width'], result['height']), (3200, 1440))
        self.assertEqual(image, PNG)
        self.assertEqual(logs, b'second\nthird\n')
        self.assertEqual((result['activityRecord'], result['taskId'], result['pid']), ('abcd', 350, 314))
        self.assertEqual(result['userId'], 0)
        self.assertEqual(run.call_args_list[-2].args[0], [
            '/adb', '-s', 'selected-phone', 'logcat', '-d', '-v', 'threadtime',
            '--pid', '314', '-T', '10-11 12:00:00.000'])
        self.assertTrue(all('top' not in call.args[0] for call in run.call_args_list))

    def test_discards_capture_if_foreground_changes(self):
        with self.responses([b'device', FOREGROUND, PNG, b'']):
            with self.assertRaises(ToolFailure):
                capture({}, '/adb', 'selected-phone', ACTIVITY, 10)

    def test_does_not_read_logs_without_run_start(self):
        with self.responses([b'device', FOREGROUND, PNG, FOREGROUND]) as run:
            _, _, logs = capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
        self.assertIsNone(logs)
        self.assertTrue(all('logcat' not in call.args[0] for call in run.call_args_list))

    def test_does_not_borrow_pid_from_another_task_or_history(self):
        with self.responses([b'device', activities(selected_process=False)]) as run:
            with self.assertRaises(ToolFailure):
                capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
        self.assertEqual(run.call_count, 2)

    def test_rejects_multiple_resumed_tasks_of_same_component(self):
        source = FOREGROUND + f'mResumedActivity: ActivityRecord{{feed u0 {ACTIVITY} t333}}\n'.encode()
        with self.responses([b'device', source]) as run:
            with self.assertRaises(ToolFailure):
                capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
        self.assertEqual(run.call_count, 2)

    def test_discards_capture_if_same_component_changes_record_user_task_or_pid(self):
        for changed in [activities(record='bcde'), activities(user=1), activities(task=351), activities(pid=315)]:
            with self.subTest(changed=changed), self.responses([b'device', FOREGROUND, PNG, changed]):
                with self.assertRaises(ToolFailure):
                    capture({}, '/adb', 'selected-phone', ACTIVITY, 10)

    def test_discards_screenshot_and_logs_if_pid_changes_during_logs(self):
        with self.responses([b'device', FOREGROUND, PNG, FOREGROUND,
                             b'captured process log\n', activities(pid=315)]) as run:
            with self.assertRaises(ToolFailure):
                capture({}, '/adb', 'selected-phone', ACTIVITY, 10, '10-11 12:00:00.000')
        self.assertEqual(run.call_count, 6)

    def test_rejects_conflicting_processes_for_selected_record(self):
        source = FOREGROUND.replace(b'      app=ProcessRecord{1234',
                                    b'      app=ProcessRecord{5678 315:com.tencent.mm:appbrand1/u0a319}\n      app=ProcessRecord{1234')
        with self.responses([b'device', source]) as run:
            with self.assertRaises(ToolFailure):
                capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
        self.assertEqual(run.call_count, 2)

    def test_allows_duplicate_resumed_identity_and_explicit_null(self):
        source = (FOREGROUND + f'mResumedActivity: ActivityRecord{{abcd u0 {ACTIVITY} t350}}\n'.encode()
                  + b'  mResumedActivity=null\n')
        with self.responses([b'device', source, PNG, source]):
            result, _, _ = capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
        self.assertEqual(result['pid'], 314)

    def test_rejects_malformed_resumed_values_even_with_valid_foreground(self):
        for field in [b'mResumedActivity=ActivityRecord{broken}', b'mResumedActivity=unknown',
                      b'mResumedActivity missing-separator']:
            with self.subTest(field=field), self.responses([b'device', FOREGROUND + field]) as run:
                with self.assertRaises(ToolFailure):
                    capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
            self.assertEqual(run.call_count, 2)

    def test_requires_exact_history_record_user_and_task(self):
        header = f'    * Hist  #0: ActivityRecord{{abcd u0 {ACTIVITY} t350}}'.encode()
        for changed in [header.replace(b'abcd', b'bcde'), header.replace(b'u0', b'u1'),
                        header.replace(b't350', b't351')]:
            with self.subTest(changed=changed), self.responses([b'device', FOREGROUND.replace(header, changed)]) as run:
                with self.assertRaises(ToolFailure):
                    capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
            self.assertEqual(run.call_count, 2)

    def test_rejects_duplicate_selected_history(self):
        source = FOREGROUND + FOREGROUND
        with self.responses([b'device', source]) as run:
            with self.assertRaises(ToolFailure):
                capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
        self.assertEqual(run.call_count, 2)

    def test_does_not_read_process_outside_selected_history(self):
        source = FOREGROUND.replace(b'      app=ProcessRecord{1234',
                                    b'    outside-history:\n      app=ProcessRecord{1234')
        with self.responses([b'device', source]) as run:
            with self.assertRaises(ToolFailure):
                capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
        self.assertEqual(run.call_count, 2)

    def test_rejects_malformed_selected_process(self):
        for process in [b'null', b'ProcessRecord{1234 invalid}', b'ProcessRecord{1234 0:game/user}']:
            source = FOREGROUND.replace(b'ProcessRecord{1234 314:com.tencent.mm:appbrand1/u0a319}', process)
            with self.subTest(process=process), self.responses([b'device', source]) as run:
                with self.assertRaises(ToolFailure):
                    capture({}, '/adb', 'selected-phone', ACTIVITY, 10)
            self.assertEqual(run.call_count, 2)

    def test_input_capture_binds_serial_display_rotation_and_screenshot_extent(self):
        target = [display(), WINDOWS, POLICY, FOREGROUND]
        with self.responses([b'device', *target, PNG, *target]) as run:
            result, _, _ = capture({}, '/adb', 'selected-phone', ACTIVITY, 10, for_input=True)
        self.assertEqual((result['serial'], result['displayId'], result['rotation']), ('selected-phone', 0, 1))
        self.assertEqual((result['width'], result['height']), (3200, 1440))
        self.assertFalse(any('input' in call.args[0] for call in run.call_args_list))

    def test_input_capture_discards_rotated_or_mismatched_screenshot(self):
        target = [display(), WINDOWS, POLICY, FOREGROUND]
        for after in [[display(rotation=3), WINDOWS, POLICY, FOREGROUND],
                      [display(width=1440, height=3200), WINDOWS, POLICY, FOREGROUND]]:
            with self.subTest(after=after), self.responses([b'device', *target, PNG, *after]):
                with self.assertRaises(ToolFailure):
                    capture({}, '/adb', 'selected-phone', ACTIVITY, 10, for_input=True)
        with self.responses([b'device', display(width=1440, height=3200), WINDOWS, POLICY, FOREGROUND, PNG]):
            with self.assertRaisesRegex(ToolFailure, 'Screenshot extent'):
                capture({}, '/adb', 'selected-phone', ACTIVITY, 10, for_input=True)

    def test_input_capture_rejects_lock_before_screenshot(self):
        with self.responses([b'device', display(), WINDOWS, POLICY.replace(b'showing=false', b'showing=true'), FOREGROUND]) as run:
            with self.assertRaisesRegex(ToolFailure, 'locked'):
                capture({}, '/adb', 'selected-phone', ACTIVITY, 10, for_input=True)
        self.assertFalse(any('screencap' in call.args[0] for call in run.call_args_list))


if __name__ == '__main__':
    unittest.main()
