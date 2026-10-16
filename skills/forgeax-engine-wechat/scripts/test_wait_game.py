#!/usr/bin/env python3
"""Offline tests for ordinary-game observation and artifact admission."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import sys
sys.dont_write_bytecode = True
from unittest.mock import patch

from wait_game import observe, read_state, screenshot_available, state_outcome
from wechatide import ToolFailure


def envelope(state):
    return {'ok': True, 'result': {'success': True, 'result': state}}


def ready(presented=60):
    return {'phase': 'ready', 'generation': 1, 'completed': presented + 25, 'presented': presented}


class WaitGameTests(unittest.TestCase):
    def test_requires_the_completed_evaluation_envelope_and_actual_game_state(self):
        self.assertEqual(read_state(envelope(ready())), ready())
        self.assertEqual(read_state(envelope({'phase': 'waiting-for-game'})), {'phase': 'waiting-for-game'})
        for response in [None, [], {'ok': True}, {'ok': False, 'result': {'success': True}},
                         {'ok': True, 'result': {'success': False}},
                         {'ok': True, 'result': {'success': True, 'status': 'pending'}},
                         envelope(None), envelope({}), envelope({'phase': 3})]:
            with self.subTest(response=response), self.assertRaises(ToolFailure):
                read_state(response)

    def test_ui_completions_failed_phases_and_non_null_errors_cannot_pass(self):
        self.assertEqual(state_outcome(ready()), 'ready')
        self.assertEqual(state_outcome(ready(59)), 'waiting')
        self.assertEqual(state_outcome({'phase': 'preparing', 'completed': 200, 'presented': 0}), 'waiting')
        self.assertEqual(state_outcome({'phase': 'waiting-for-game'}), 'waiting')
        self.assertEqual(state_outcome(ready() | {'phase': 'failed'}), 'failed')
        for field in ['startupError', 'lastError']:
            self.assertEqual(state_outcome(ready() | {field: {}}), 'failed')
            self.assertEqual(state_outcome(ready() | {field: None}), 'ready')
        for state in [ready() | {'completed': 59}, ready() | {'presented': -1},
                      ready() | {'presented': '60'}, ready() | {'presented': True},
                      ready() | {'completed': 85.0}, {'phase': 'ready'}]:
            with self.subTest(state=state), self.assertRaises(ToolFailure):
                state_outcome(state)

    def test_screenshot_needs_an_actual_local_copy_and_successful_envelope(self):
        with tempfile.TemporaryDirectory() as root:
            image = Path(root) / 'simulator.jpg'
            image.write_bytes(b'image')
            response = {'ok': True, 'result': {'success': True, 'artifact': str(image)}}
            self.assertTrue(screenshot_available(response, 0))
            for status in [1, 3]:
                self.assertFalse(screenshot_available(response, status))
            self.assertFalse(screenshot_available(None, 0))
            self.assertFalse(screenshot_available({'ok': True, 'result': {'success': True, 'path': '/remote.jpg'}}, 0))
            image.unlink()
            self.assertFalse(screenshot_available(response, 0))

    def run_observation(self, states, *, timeout=10, screenshot_ok=True):
        calls, clock = [], [0.0]
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / 'evidence'
            def invoke(_config, arguments, directory, limit):
                calls.append((arguments, limit))
                directory.mkdir()
                if arguments[0] == 'simulator_screenshot':
                    image = directory / 'simulator.jpg'
                    if screenshot_ok:
                        image.write_bytes(b'image')
                    return {'ok': True, 'result': {'success': True, 'artifact': str(image)}}, 0
                clock[0] += 1
                return states.pop(0)
            with patch('wait_game.invoke', side_effect=invoke), \
                    patch('wait_game.time.monotonic', side_effect=lambda: clock[0]), \
                    patch('wait_game.time.sleep', side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)), \
                    contextlib.redirect_stdout(io.StringIO()):
                result = observe({}, '/absolute/game', out, timeout)
            self.assertEqual(json.loads((out / 'summary.json').read_text()), result)
            self.assertEqual(out.stat().st_mode & 0o777, 0o700)
            self.assertEqual((out / 'summary.json').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                observe({}, '/absolute/game', out, timeout)
            return result, calls

    def test_waits_for_scene_readiness_then_pairs_the_official_image(self):
        result, calls = self.run_observation([(envelope(ready(59)), 0), (envelope(ready()), 0)])
        self.assertTrue(result['readyFramesPassed'])
        self.assertEqual([call[0][0] for call in calls], ['automation_evaluate', 'automation_evaluate', 'simulator_screenshot'])
        self.assertEqual(result['state']['presented'], 60)

    def test_tool_pending_and_failure_stop_without_borrowing_earlier_state(self):
        for status in [1, 3]:
            response = {'ok': True, 'result': {'status': 'pending', 'taskId': 'some-task'}}
            result, calls = self.run_observation([(envelope(ready(59)), 0), (response, status)])
            self.assertFalse(result['readyFramesPassed'])
            self.assertEqual(result['failure'], {'kind': 'tool', 'status': status, 'response': response})
            self.assertEqual(len(calls), 3)

    def test_timeout_malformed_state_and_missing_image_retain_failure(self):
        result, _ = self.run_observation([(envelope(ready(59)), 0)], timeout=2)
        self.assertEqual(result['failure']['kind'], 'timeout')
        result, _ = self.run_observation([(envelope({}), 0)])
        self.assertEqual(result['failure']['kind'], 'observation')
        result, _ = self.run_observation([(envelope(ready()), 0)], screenshot_ok=False)
        self.assertEqual(result['failure']['kind'], 'screenshot')
        self.assertFalse(result['readyFramesPassed'])


if __name__ == '__main__':
    unittest.main()
