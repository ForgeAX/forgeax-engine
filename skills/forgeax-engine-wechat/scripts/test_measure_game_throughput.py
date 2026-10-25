#!/usr/bin/env python3
"""Offline orchestration tests; these do not qualify a simulator or frame budget."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import measure_game_throughput as measurement


def headroom():
    at = datetime.now(timezone.utc).isoformat()
    def success(stdout):
        return {'exitCode': 0, 'stdout': stdout}
    return {
        'endedAtUtc': at,
        'consoleBefore': {'exitCode': 0, 'consoleLocked': False, 'screenLocked': False},
        'consoleAfter': {'exitCode': 0, 'consoleLocked': False, 'screenLocked': False},
        'intervalCpu': success('CPU usage: 20% idle\nCPU usage: 80% idle\nCPU usage: 85% idle'),
        'gpu': {'exitCode': 0, 'samples': [{'atUtc': at, 'endedAtUtc': at, 'status': 'available',
            'statistics': [{'Device Utilization %': 10}]}]},
        'memory': success('System-wide memory free percentage: 60%'),
        'pressure': success('kern.memorystatus_vm_pressure_level: 1'),
        'thermal': success('Note: No thermal warning level has been recorded\n'
                           'Note: No performance warning level has been recorded\n'
                           'Note: No CPU power status has been recorded'),
        'vmBefore': success('Swapins: 200.\nSwapouts: 300.\nPageouts: 400.'),
        'vmAfter': success('Swapins: 200.\nSwapouts: 300.\nPageouts: 400.'),
    }


def snapshot(clock=10000, completed=100):
    return {'utcMs': 1_800_000_000_000 + clock, 'clockOriginMs': 1_800_000_000_000,
            'observedAtMs': clock, 'observationCostMs': 0.1,
            'canvas': {'width': 2532, 'height': 1170}, 'canvasCount': 1,
            'display': {'width': 844, 'height': 390, 'pixelRatio': 3},
            'capabilities': {'rhiCapture': False, 'profiler': False},
            'renderer': {'generation': 1, 'phase': 'ready', 'completed': completed, 'presented': completed},
            'player': {'position': [0, 1, 0], 'camera': {'yaw': 0, 'pointerLocked': False},
                       'grounded': True, 'controls': {'horizontal': 0, 'vertical': 0, 'run': False}}, 'vase': {'generation': 1}}


class HeadroomTests(unittest.TestCase):
    def test_console_lock_is_retained_without_substituting_for_actual_frame_progress(self):
        for observation in ('consoleBefore', 'consoleAfter'):
            for flag in ('consoleLocked', 'screenLocked'):
                source = headroom()
                source[observation][flag] = True
                with self.subTest(observation=observation, flag=flag):
                    result = measurement.qualify_headroom(source)
                    self.assertTrue(result['qualified'])
                    stage = 'before' if observation == 'consoleBefore' else 'after'
                    self.assertTrue(result['facts']['console'][stage][flag])

    def test_missing_console_observation_is_unavailable(self):
        source = headroom()
        del source['consoleBefore']
        with self.assertRaisesRegex(measurement.ToolFailure, 'headroom-observation-unavailable'):
            measurement.qualify_headroom(source)

    def test_excludes_first_cpu_sample_and_uses_paging_deltas(self):
        qualified = measurement.qualify_headroom(headroom())
        self.assertTrue(qualified['qualified'])
        self.assertEqual(qualified['facts']['cpuIdlePercent'], [80, 85])
        self.assertEqual(qualified['facts']['pagingDelta'], {'Swapins': 0, 'Swapouts': 0, 'Pageouts': 0})

    def test_rejects_busy_gpu_stale_observations_and_active_paging(self):
        source = headroom()
        source['gpu']['samples'][0]['statistics'][0]['Device Utilization %'] = 90
        source['vmAfter']['stdout'] = 'Swapins: 200.\nSwapouts: 302.\nPageouts: 400.'
        result = measurement.qualify_headroom(source, now_ms=measurement.utc_ms(source['endedAtUtc']) + 301_000)
        self.assertFalse(result['qualified'])
        self.assertEqual(set(result['reasons']), {'headroom-not-fresh', 'background-gpu-busy', 'paging-during-preflight'})

    def test_missing_gpu_is_not_zero_utilization(self):
        source = headroom()
        source['gpu']['samples'][0]['statistics'] = []
        with self.assertRaisesRegex(measurement.ToolFailure, 'interval-unavailable'):
            measurement.headroom_facts(source)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.original = '{"compileType":"game","appid":"local-test","setting":{"es6":false}}\n'
        (self.root / 'project.config.json').write_text(self.original)
        (self.root / 'game.js').write_bytes(b'ordinary bootstrap')
        (self.root / 'payload').mkdir()
        (self.root / 'payload/engine.js').write_bytes(b'actual runtime payload')
        self.rows = []
        for name in ('project.config.json', 'game.js', 'payload/engine.js'):
            value = (self.root / name).read_bytes()
            self.rows.append({'path': name, 'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest()})
        self.publish()

    def publish(self):
        data = json.dumps({'target': 'wechat', 'artifacts': self.rows}).encode()
        (self.root / 'forgeax-dist.json').write_bytes(data)
        self.digest = hashlib.sha256(data).hexdigest()

    def test_checks_payload_beyond_bootstrap(self):
        self.assertEqual(measurement.verify_files(self.root, self.digest)['artifactsVerified'], 3)
        (self.root / 'payload/engine.js').write_bytes(b'changed runtime payload')
        with self.assertRaisesRegex(ValueError, 'artifact-mismatch: payload/engine.js'):
            measurement.verify_files(self.root, self.digest)

    def test_only_additive_ide_config_is_admitted(self):
        config = json.loads(self.original)
        config['setting']['minifyWXML'] = True
        config['editorSetting'] = {}
        (self.root / 'project.config.json').write_text(json.dumps(config))
        result = measurement.verify_files(self.root, self.digest, self.original)
        self.assertEqual(result['ideConfigurationAdditions'], ['/editorSetting', '/setting/minifyWXML'])
        config['setting']['es6'] = True
        (self.root / 'project.config.json').write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, 'config-value-changed'):
            measurement.verify_files(self.root, self.digest, self.original)

    def test_rejects_wrong_reference_and_duplicate_or_escaping_paths(self):
        with self.assertRaisesRegex(ValueError, 'manifest-mismatch'):
            measurement.verify_files(self.root, '0' * 64)
        self.rows.append(self.rows[0])
        self.publish()
        with self.assertRaisesRegex(ValueError, 'path-invalid'):
            measurement.verify_files(self.root, self.digest)
        self.rows[-1] = {'path': '../outside', 'bytes': 0, 'sha256': '0' * 64}
        self.publish()
        with self.assertRaisesRegex(ValueError, 'path-invalid'):
            measurement.verify_files(self.root, self.digest)


class CounterTests(unittest.TestCase):
    def test_rejects_the_actual_fallen_player_instead_of_passing_empty_scene_fps(self):
        state = snapshot()
        state['player']['position'] = [9.334806442260742, -560.52978515625, 6.444488525390625]
        state['player']['grounded'] = False
        with self.assertRaisesRegex(measurement.ToolFailure, 'scene-retention'):
            measurement.validate_player_scene(state, [0, 0.96006, 7.4])
        state['player']['grounded'] = True
        state['player']['position'] = [3, 0.96006, 7.4]
        with self.assertRaisesRegex(measurement.ToolFailure, 'scene-retention'):
            measurement.validate_player_scene(state, [0, 0.96006, 7.4])

    def test_uses_completed_game_clock_not_host_or_submitted_fps(self):
        start, end = snapshot(), snapshot(clock=20000, completed=450)
        result = measurement.sample_delta(start, end)
        self.assertEqual(result['completedFps'], 35)
        self.assertEqual(result['completedDelta'], 350)

    def test_rejects_reset_extent_change_and_nonordinary_state(self):
        for change in ('generation', 'canvas', 'display', 'counter'):
            start, end = snapshot(), snapshot(clock=20000, completed=450)
            if change == 'generation':
                end['renderer']['generation'] = 2
            elif change == 'canvas':
                end['canvas']['width'] = 320
            elif change == 'display':
                end['display']['pixelRatio'] = 2
            else:
                end['renderer']['completed'] = 90
            with self.assertRaises(measurement.ToolFailure):
                measurement.sample_delta(start, end)
        state = snapshot()
        state['capabilities']['rhiCapture'] = True
        with self.assertRaisesRegex(measurement.ToolFailure, 'recorder-enabled'):
            measurement.validate_state(state)
        state = snapshot()
        state['renderer']['presented'] = 59
        with self.assertRaises(measurement.ToolFailure):
            measurement.validate_state(state)


class OrchestrationTests(unittest.TestCase):
    def runner(self, **changes):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        config = root / 'machine.json'
        config.write_text('{"cli":"/uninvoked/wechatide"}')
        args = SimpleNamespace(config=config, project='/owned/game', manifest_sha='a' * 64,
            out=root / 'output', headroom_before=None, publication=None, interaction='game-3d',
            minimum_cpu_idle=40, maximum_background_gpu=50, skill_version='0.3.11')
        calls = []
        class Fake(measurement.Measurement):
            def headroom(self, name, duration=15):
                result = headroom()
                if changes.get('busy'):
                    result['gpu']['samples'][0]['statistics'][0]['Device Utilization %'] = 90
                return result

            def publication(self):
                return {'manifestSha256': args.manifest_sha}

            def call(self, name, tool, *parameters):
                calls.append((name, tool, parameters))
                if tool == 'check_wechatide_status':
                    return {'loginExpired': False, 'versionRelation': 'equal'}
                if tool == 'open_project_window':
                    return {'type': 'alreadyopen' if changes.get('existing') else 'newopen', 'winId': 's42'}
                if tool == 'close_project_window':
                    return {'winId': 's0' if changes.get('wrong_close') else 's42'}
                if tool == 'project_list':
                    return {'projects': []}
                if tool == 'automation_evaluate':
                    if '--args' in parameters:
                        raise measurement.ToolFailure('INPUT_ERROR: deprecated_args')
                    return {'result': snapshot()}
                if tool == 'automation_game_action':
                    return {'success': True}
                raise AssertionError(tool)

            def windows(self, kind):
                if kind == 'move-changing':
                    self.touch('touchstart', 112, 276)
                    raise measurement.ToolFailure('preserved-native-operation-failure')
                return []
        return Fake(args), calls

    def test_state_uses_parameterless_official_evaluation(self):
        runner, calls = self.runner()
        self.assertEqual(runner.state('state')['renderer']['presented'], 100)
        parameters = calls[-1][2]
        self.assertNotIn('--args', parameters)
        source = parameters[parameters.index('--fn-source') + 1]
        self.assertTrue(source.startswith('async function()'))
        self.assertIn('const interaction=true;', source)

    def test_movement_pulse_releases_before_reading_and_returns_toward_origin(self):
        runner, calls = self.runner()
        initial = runner.state('initial')
        offset = snapshot()
        offset['player']['position'][2] = -1
        runner.movement_pulse(offset)
        actions = [(parameters[parameters.index('--action') + 1],
                    parameters[parameters.index('--x') + 1], parameters[parameters.index('--y') + 1])
                   for _, tool, parameters in calls if tool == 'automation_game_action']
        self.assertEqual(actions, [('touchstart', '112', '290'), ('touchend', '112', '290')])
        self.assertEqual(calls[-1][1], 'automation_evaluate')
        self.assertIsNone(runner.held)
        self.assertEqual(runner.report['movementPulses'][0]['after']['player'], initial['player'])

    def test_slow_movement_pulse_is_released_before_rejecting_its_timing(self):
        runner, calls = self.runner()
        initial = runner.state('initial')
        with patch.object(measurement.time, 'monotonic', side_effect=[10, 15]):
            with self.assertRaisesRegex(measurement.ToolFailure, 'contact-envelope-exceeded'):
                runner.movement_pulse(initial)
        self.assertIsNone(runner.held)
        self.assertEqual(calls[-1][2][calls[-1][2].index('--action') + 1], 'touchend')

    def test_busy_preflight_never_opens_or_touches(self):
        runner, calls = self.runner(busy=True)
        result = runner.run()
        self.assertFalse(result['success'])
        self.assertEqual([tool for _, tool, _ in calls], ['check_wechatide_status'])

    def test_preserves_existing_shared_window(self):
        runner, calls = self.runner(existing=True)
        result = runner.run()
        self.assertFalse(result['windowOwned'])
        self.assertNotIn('close_project_window', [tool for _, tool, _ in calls])

    def test_failure_releases_touch_and_closes_exact_owned_window(self):
        runner, calls = self.runner()
        ready = {'readyFramesPassed': True, 'screenshot': {'result': {'imageWidth': 794, 'imageHeight': 368}}}
        with patch.object(measurement, 'observe', return_value=ready):
            result = runner.run()
        self.assertFalse(result['success'])
        self.assertEqual(result['failure'], 'preserved-native-operation-failure')
        actions = [parameters[parameters.index('--action') + 1] for _, tool, parameters in calls
                   if tool == 'automation_game_action']
        self.assertEqual(actions, ['touchstart', 'touchend'])
        self.assertEqual(result['close']['winId'], 's42')
        self.assertIsNone(runner.held)


if __name__ == '__main__':
    unittest.main()
