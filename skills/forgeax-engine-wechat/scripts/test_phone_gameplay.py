"""Offline finite phone-control and artifact tests; no device or performance claim."""
import copy
import http.client
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import run_phone_gameplay_benchmark as runner

from run_phone_gameplay_benchmark import GameplayControl, digest, make_timeline, validate_gameplay_report

SOURCE = {'engineCommit': 'a' * 40, 'manifestSha256': 'b' * 64, 'entrySha256': 'c' * 64,
          'observerSha256': 'd' * 64, 'controllerSha256': 'e' * 64}
RUN = 'offline_gameplay_contract'
PHASES = [{'name': name, 'startMs': i * 1000, 'endMs': (i + 1) * 1000}
          for i, name in enumerate(('walk', 'run', 'jump', 'run-jump'))]


def report():
    return {'kind': 'forgeax-phone-gameplay', 'schemaVersion': 'forgeax-phone-gameplay/1',
            'runId': RUN, 'source': SOURCE, 'mode': 'timed', 'status': 'complete', 'finishedAt': 123,
            'diagnosticOnly': True, 'cleanFpsEvidence': False, 'debugReceipts': [],
            'debug': {'policy': 'unchanged', 'before': {'atMs': 0, 'appBaseInfo': {'enableDebug': True}},
                      'after': {'atMs': 6100, 'appBaseInfo': {'enableDebug': True}}},
            'websocket': {'events': [{'atMs': 100}, {'atMs': 6100}]},
            'failure': None, 'afterPlayer': {'grounded': True, 'controls': {'horizontal': 0, 'vertical': 0, 'run': False}},
            'capture': {'schemaVersion': 'forgeax-gameplay-capture/1', 'status': 'complete', 'failure': None,
                        'startMs': 2000, 'endMs': 6000, 'phases': PHASES, 'capacity': 65536,
                        'events': [{'atMs': 2010 + i * 1000, 'frameId': i, 'phase': i, 'kind': kind}
                                   for i in range(4) for kind in ('submitted', 'completed')],
                        'drain': {'success': True, 'lastSubmittedFrame': 3, 'lastCompletedFrame': 3,
                                  'renderer': {'frame': {'pendingCompletionCount': 0}}}}}


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.out = Path(self.temporary.name)
        with socket.socket() as socket_:
            socket_.bind(('127.0.0.1', 0))
            self.port = socket_.getsockname()[1]
        self.phone = {'controlUrl': f'http://127.0.0.1:{self.port}/{RUN}', 'runId': RUN, 'reportSource': SOURCE}
        self.control = GameplayControl(self.phone, self.out, threading.Event(), deadline=5, max_uncertainty_ms=100)
        self.control.timeline = {'durationMs': 4000, 'phases': PHASES}
        self.control.start()
        self.addCleanup(self.control.close)

    def post(self, stage, value, headers=None, path=None):
        body = json.dumps(value).encode()
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            connection.request('POST', path or f'/{RUN}/{stage}', body,
                               {'Content-Type': 'application/json', **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read()), body
        finally:
            connection.close()

    def message(self, stage, **value):
        if stage == 'ready':
            value.setdefault('debug', {'policy': 'unchanged', 'before': {'atMs': 0, 'appBaseInfo': {'enableDebug': True}}})
        return {'kind': 'forgeax-phone-gameplay-control/1', 'runId': RUN,
                'source': SOURCE, 'stage': stage, **value}

    def arm(self):
        result = []
        worker = threading.Thread(target=lambda: result.append(self.post('ready', self.message('ready', observation={'ready': True}))))
        worker.start()
        self.assertTrue(self.control.ready.wait(1))
        self.assertEqual(result, [], 'Phone cannot arm before native input setup is ready')
        self.control.input_ready.set()
        worker.join(2)
        self.assertEqual(result[0][0], 200)
        self.assertEqual(result[0][1]['action'], 'arm')
        self.assertFalse(self.control.armed.is_set())
        arm = {'startMs': 2000, 'endMs': 6000, 'nowMs': 0}
        status, response, _ = self.post('armed', self.message('armed', arm=arm))
        self.assertEqual(status, 200)
        return response

    def test_real_loopback_barrier_release_and_full_hashed_artifact(self):
        response = self.arm()
        sync = response['synchronization']
        self.assertLessEqual(sync['startEarliestMonotonicMs'], sync['startMonotonicMs'])
        self.assertLessEqual(sync['startMonotonicMs'], sync['startLatestMonotonicMs'])
        self.assertGreater(self.control.start_capture(), time.monotonic())
        self.control.input = {'session': {'execution': {'releaseStatus': 'up-messages-dispatched'}}}
        self.control.released.set()
        status, response, _ = self.post('release', self.message('release'))
        self.assertEqual((status, response['action']), (200, 'released'))
        value = report()
        body = json.dumps(value).encode()
        status, receipt, _ = self.post('report', value, {
            'X-Forgeax-Report-Bytes': str(len(body)), 'X-Forgeax-Report-Sha256': digest(body)})
        self.assertEqual(status, 200)
        self.assertEqual(receipt, {'status': 'saved', 'bytes': len(body), 'sha256': digest(body)})
        self.assertEqual((self.out / 'phone-report.json').read_bytes(), body)
        self.assertEqual((self.out / 'phone-report.json').stat().st_mode & 0o777, 0o600)
        self.assertTrue(self.control.finished.wait(.5))

    def test_source_path_and_duplicate_arm_are_rejected(self):
        self.assertEqual(self.post('ready', self.message('ready'), path='/other/ready')[0], 404)
        bad = self.message('ready', observation={}) | {'source': {}}
        self.assertEqual(self.post('ready', bad)[0], 400)
        self.arm()
        self.assertEqual(self.post('ready', self.message('ready', observation={}))[0], 400)
        self.assertEqual(self.post('armed', self.message('armed', arm={}))[0], 400)

    def test_excess_clock_uncertainty_cancels_before_native_dispatch(self):
        self.control.state = 'waiting-armed'
        self.control.arm_sent = time.monotonic() - 1
        status, response, _ = self.post('armed', self.message('armed', arm={'startMs': 2000, 'endMs': 6000, 'nowMs': 0}))
        self.assertEqual(status, 400)
        self.assertIn('uncertainty', response['reason'])
        self.assertTrue(self.control.cancel.is_set())
        with self.assertRaisesRegex(ValueError, 'uncertainty'):
            self.control.start_capture()

    def test_transport_only_receives_ready_without_input_setup_or_arming(self):
        self.control.observe_only = True
        status, response, _ = self.post('ready', self.message('ready', observation={'renderer': {'phase': 'ready'}}))
        self.assertEqual((status, response['action']), (200, 'observe-only'))
        self.assertFalse(self.control.input_ready.is_set())
        self.assertFalse(self.control.armed.is_set())
        self.assertIsNone(self.control.input)

    def test_observed_debug_state_is_required_before_arm(self):
        self.control.input_ready.set()
        for debug in ({}, {'policy': 'unchanged', 'before': {}}):
            self.control.state = 'waiting-ready'
            self.assertEqual(self.post('ready', self.message('ready', observation={}, debug=debug))[0], 400)
            self.assertFalse(self.control.armed.is_set())
            self.assertFalse(hasattr(self.control, 'arm_sent'))

    def test_future_reviewed_capture_keeps_ready_unarmed_until_atomic_handoff(self):
        capture_path, screenshot_path = self.out / 'capture.json', self.out / 'screen.png'
        result = []
        worker = threading.Thread(target=lambda: result.append(self.post('ready', self.message('ready', observation={}))))
        worker.start()
        self.assertTrue(self.control.ready.wait(1))
        captured = {'state': 'captured', 'screenshotSha256': digest(b'original screenshot')}
        loaded = []
        reader = threading.Thread(target=lambda: loaded.append(runner.read_reviewed_capture(
            capture_path, screenshot_path, self.control)))
        reader.start()
        screenshot_path.write_bytes(b'original screenshot')
        time.sleep(.1)
        self.assertEqual(loaded, [], 'Screenshot alone is not the reviewed handoff')
        self.assertFalse(self.control.input_ready.is_set())
        self.assertEqual(result, [])
        staged = self.out / 'reviewed.json'
        staged.write_text(json.dumps(captured))
        staged.rename(capture_path)
        reader.join(1)
        self.assertEqual(loaded[0], (captured, capture_path.read_bytes(), b'original screenshot'))
        self.assertEqual(result, [], 'Reading files cannot arm or bypass the native target guard')
        self.control.input_ready.set()
        worker.join(1)
        self.assertEqual(result[0][1]['action'], 'arm')

    def test_review_preparation_after_thirty_seconds_retains_two_second_clock_lead_in(self):
        self.control.stop_at = time.monotonic() + 200
        responses = []
        worker = threading.Thread(target=lambda: responses.append(self.post('ready', self.message('ready', observation={}))))
        worker.start()
        self.assertTrue(self.control.ready.wait(1))
        try:
            now = time.monotonic()
            self.assertTrue(117 < self.control.input_deadline - now <= 118)
            capture_path, screenshot_path = self.out / 'capture.json', self.out / 'screen.png'
            capture_path.write_text('{}')
            screenshot_path.write_bytes(b'reviewed')
            with patch.object(runner.time, 'monotonic', return_value=now + 30):
                self.assertEqual(runner.read_reviewed_capture(capture_path, screenshot_path, self.control)[0], {})
            self.assertFalse(self.control.input_ready.is_set())
            self.control.input_ready.set()
            worker.join(1)
            self.assertEqual(responses[0][0], 200)
            self.assertEqual(responses[0][1]['delayMs'], 2000)
            self.assertEqual(responses[0][1]['durationMs'], 4000)
        finally:
            self.control.cancel.set()
            worker.join(1)

    def test_future_capture_deadline_rejects_late_input_without_arming_or_rearm(self):
        self.control.stop_at = time.monotonic() + .15
        result = []
        worker = threading.Thread(target=lambda: result.append(self.post('ready', self.message('ready', observation={}))))
        worker.start()
        self.assertTrue(self.control.ready.wait(1))
        with self.assertRaisesRegex(ValueError, 'deadline|cancelled'):
            runner.read_reviewed_capture(self.out / 'absent.json', self.out / 'absent.png', self.control)
        worker.join(1)
        self.assertEqual(result[0][0], 400)
        self.assertFalse(self.control.input_ready.is_set())
        self.assertFalse(hasattr(self.control, 'arm_sent'))
        with self.assertRaisesRegex(ValueError, 'deadline|cancelled'):
            self.control.start_capture()
        self.assertFalse(self.control.input_ready.is_set())
        self.assertEqual(self.post('ready', self.message('ready', observation={}))[0], 400)

    def test_future_capture_invalid_json_is_terminal_without_native_setup(self):
        self.control.state = 'preparing-input'
        self.control.input_deadline = time.monotonic() + 1
        capture_path, screenshot_path = self.out / 'bad.json', self.out / 'screen.png'
        capture_path.write_bytes(b'{')
        screenshot_path.write_bytes(b'image')
        with self.assertRaises(json.JSONDecodeError):
            runner.read_reviewed_capture(capture_path, screenshot_path, self.control)
        self.assertFalse(self.control.input_ready.is_set())
        self.assertFalse(hasattr(self.control, 'arm_sent'))

    def test_partial_failure_saved_but_hash_mismatch_never_saved(self):
        value = {'kind': 'forgeax-phone-gameplay', 'schemaVersion': 'forgeax-phone-gameplay/1',
                 'runId': RUN, 'source': SOURCE, 'mode': 'timed', 'status': 'partial',
                 'finishedAt': 123, 'failure': 'original startup failure'}
        body = json.dumps(value).encode()
        headers = {'X-Forgeax-Report-Bytes': str(len(body)), 'X-Forgeax-Report-Sha256': '0' * 64}
        self.assertEqual(self.post('report', value, headers)[0], 400)
        self.assertFalse((self.out / 'phone-report.json').exists())
        headers['X-Forgeax-Report-Sha256'] = digest(body)
        self.assertEqual(self.post('report', value, headers)[0], 200)
        self.assertEqual(json.loads((self.out / 'phone-report.json').read_bytes())['failure'], 'original startup failure')


class ArtifactTests(unittest.TestCase):
    def test_stationary_complete_collection_requires_valid_complete_cpu_owner(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / 'forgeax-dist.json').write_text('{}')
            phone = {'controlUrl': 'http://127.0.0.1:12345/offline', 'runId': RUN,
                     'mode': 'cpu', 'cpuFrames': 120, 'completionTiming': True}
            phases = [{'name': 'stationary', 'startMs': 0, 'endMs': 8000}]
            complete_cpu = {'status': 'complete', 'validation': {'ok': True},
                            'coverage': {'ownerCoverageComplete': True}}
            cases = [('complete', complete_cpu, None), ('missing', None, None),
                     ('read-failed', None, 'original CPU read error'),
                     ('stop-failed', complete_cpu, 'original CPU stop error'),
                     *[(state, {**complete_cpu, 'status': state}, None) for state in ('partial', 'failed', 'overflow')],
                     ('invalid', {**complete_cpu, 'validation': {'ok': False}}, None),
                     ('missing-owner', {**complete_cpu, 'coverage': {'ownerCoverageComplete': False}}, None)]
            for name, cpu, cpu_error in cases:
                with self.subTest(name=name):
                    out = base / name
                    value = report()
                    value.update(mode='cpu', diagnostic='cpu')
                    value['capture'].update(phases=phases, endMs=10000)
                    value['debug']['after']['atMs'] = 10100
                    value['websocket']['events'][-1]['atMs'] = 10100
                    for event in value['capture']['events']:
                        event['phase'] = 0
                    if cpu is not None:
                        value['cpu'] = cpu
                    if cpu_error is not None:
                        value['cpuError'] = cpu_error
                    # The original wire contract admits the completed App/drain envelope.
                    validate_gameplay_report(value, SOURCE, RUN, phases, 'cpu')
                    original = copy.deepcopy(value)
                    def start(control, *_):
                        control.observation = {'player': value['afterPlayer']}
                        control.ready.set()
                        control.finished.set()
                        control.report = value
                    args = ['runner', '--stationary-diagnostic', str(base / 'arm.json'),
                            '--publication', str(base), '--out', str(out)]
                    with patch.object(sys, 'argv', args), patch.object(runner, 'verify_publication', return_value=(phone, {})), \
                            patch.object(GameplayControl, 'start', start), patch.object(GameplayControl, 'close'), \
                            patch.object(GameplayControl, 'start_capture'), patch.object(runner, 'wait_for_stationary_arm', return_value={}), \
                            patch.object(sys, 'stdout', io.StringIO()):
                        self.assertEqual(runner.main(), 0 if name == 'complete' else 1)
                    saved = json.loads((out / 'result.json').read_text())
                    self.assertEqual(saved['success'], name == 'complete')
                    self.assertEqual(saved['phoneStatus'], 'complete')
                    self.assertEqual(value, original, 'Runner must not rewrite the original phone report')
                    if name != 'complete':
                        self.assertEqual(saved['failure'], 'stationary-cpu-capture-incomplete')
                    if cpu_error:
                        self.assertEqual(saved['cpuError'], cpu_error)
                    if cpu is not None:
                        self.assertEqual(json.loads((out / 'cpu.json').read_text()), cpu)

    def test_transport_only_retains_observation_semantics_and_final_failures(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / 'forgeax-dist.json').write_text('{}')
            phone = {'controlUrl': 'http://127.0.0.1:12345/offline', 'runId': RUN, 'mode': 'cpu'}
            def start(control, *_):
                self.assertTrue(control.observe_only)
                control.ready.set()
                control.finished.set()
                control.report = {'status': 'partial', 'failure': 'transport-observation-only'}
            for failure in (None, 'cleanup', 'source-changed'):
                out = base / str(failure)
                args = ['runner', '--transport-only', '--publication', str(base), '--out', str(out)]
                verification = [(phone, {}), ValueError('source-changed') if failure == 'source-changed' else (phone, {})]
                with patch.object(sys, 'argv', args), patch.object(runner, 'verify_publication', side_effect=verification), \
                        patch.object(GameplayControl, 'start', start), \
                        patch.object(GameplayControl, 'close', side_effect=ValueError('cleanup') if failure == 'cleanup' else None), \
                        patch.object(runner, 'perform_timeline') as native, patch.object(sys, 'stdout', io.StringIO()):
                    self.assertEqual(runner.main(), 1 if failure else 0)
                    native.assert_not_called()
                value = json.loads((out / 'result.json').read_text())
                self.assertTrue(value['transportOnly'])
                self.assertEqual(value['phoneReason'], 'transport-observation-only')
                self.assertEqual(value['success'], failure is None)
                self.assertEqual('cleanupFailure' in value, failure == 'cleanup')
                if failure == 'source-changed':
                    self.assertIn(failure, value['failure'])

    def test_stationary_rejects_other_publications_before_starting(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / 'forgeax-dist.json').write_text('{}')
            expected = {'controlUrl': 'http://127.0.0.1:12345/offline', 'runId': RUN,
                        'mode': 'cpu', 'cpuFrames': 120, 'completionTiming': True}
            for index, changed in enumerate(({'mode': 'timed'}, {'mode': 'gpu'},
                                            {'cpuFrames': 240}, {'completionTiming': False})):
                out = base / str(index)
                args = ['runner', '--stationary-diagnostic', str(base / 'arm.json'),
                        '--publication', str(base), '--out', str(out)]
                with patch.object(sys, 'argv', args), patch.object(runner, 'verify_publication', return_value=(expected | changed, {})), \
                        patch.object(GameplayControl, 'start') as start, patch.object(sys, 'stdout', io.StringIO()):
                    self.assertEqual(runner.main(), 1)
                    start.assert_not_called()
                self.assertIn('120-frame CPU/completion', json.loads((out / 'result.json').read_text())['failure'])

    def test_stationary_cli_rejects_ambiguous_modes_and_existing_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            marker, out = base / 'arm.json', base / 'uncreated'
            args = [sys.executable, str(Path(__file__).with_name('run_phone_gameplay_benchmark.py')),
                    '--publication', '/unused-publication', '--out', str(out),
                    '--stationary-diagnostic', str(marker)]
            for extra in (['--transport-only'], ['--await-capture']):
                result = subprocess.run(args + extra, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn('cannot be combined', result.stderr)
                self.assertFalse(out.exists())
            marker.write_text('{}')
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('must not already exist', result.stderr)
            self.assertFalse(out.exists())

    def test_stationary_main_keeps_real_protocol_and_partial_report_without_native_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            publication, out, marker = base / 'publication', base / 'result', base / 'arm.json'
            publication.mkdir()
            manifest = b'{"target":"wechat"}'
            (publication / 'forgeax-dist.json').write_bytes(manifest)
            with socket.socket() as selected:
                selected.bind(('127.0.0.1', 0))
                port = selected.getsockname()[1]
            phone = {'controlUrl': f'http://127.0.0.1:{port}/{RUN}', 'runId': RUN,
                     'reportSource': SOURCE, 'mode': 'cpu', 'cpuFrames': 120,
                     'completionTiming': True, 'debugPolicy': 'unchanged'}
            args = ['runner', '--publication', str(publication), '--out', str(out),
                    '--stationary-diagnostic', str(marker)]
            ready_for_marker, peer_done = threading.Event(), threading.Event()
            failures, workers = [], []
            value = {'kind': 'forgeax-phone-gameplay', 'schemaVersion': 'forgeax-phone-gameplay/1',
                     'source': SOURCE, 'runId': RUN, 'mode': 'cpu', 'diagnostic': 'cpu',
                     'diagnosticOnly': True, 'cleanFpsEvidence': False, 'status': 'partial',
                     'finishedAt': 123, 'failure': 'offline-stationary-partial'}
            raw = json.dumps(value).encode()

            def printed(text):
                if json.loads(text).get('state') == 'awaiting-arm':
                    ready_for_marker.set()

            def message(stage, **extra):
                return {'kind': 'forgeax-phone-gameplay-control/1', 'source': SOURCE,
                        'runId': RUN, 'stage': stage, **extra}

            def peer(control):
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                try:
                    connection.request('POST', f'/{RUN}/ready', json.dumps(message('ready',
                        observation={'player': {'grounded': True, 'controls': {
                            'horizontal': 0, 'vertical': 0, 'run': False}}},
                        debug={'policy': 'unchanged', 'before': {'atMs': 0,
                            'appBaseInfo': {'enableDebug': True}}})), {'Content-Type': 'application/json'})
                    self.assertTrue(ready_for_marker.wait(2))
                    time.sleep(.06)
                    self.assertFalse(control.input_ready.is_set())
                    self.assertFalse(control.armed.is_set())
                    staged = base / 'marker.tmp'
                    staged.write_text(json.dumps({'runId': RUN, 'diagnosticManifestSha256': digest(manifest)}))
                    staged.rename(marker)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    arm = json.loads(response.read())
                    self.assertEqual((arm['action'], arm['delayMs'], arm['durationMs']), ('arm', 2000, 8000))
                    self.assertEqual(arm['phases'], [{'name': 'stationary', 'startMs': 0, 'endMs': 8000}])
                    for stage, payload in [('armed', message('armed', arm={
                            'startMs': 2000, 'endMs': 10000, 'nowMs': 0})), ('release', message('release'))]:
                        connection.request('POST', f'/{RUN}/{stage}', json.dumps(payload), {'Content-Type': 'application/json'})
                        response = connection.getresponse()
                        reply = json.loads(response.read())
                        self.assertEqual(response.status, 200, reply)
                        if stage == 'armed':
                            self.assertLessEqual(reply['synchronization']['uncertaintyMs'], 25)
                        else:
                            self.assertEqual(reply['action'], 'released')
                            self.assertEqual(reply['input']['session']['execution']['releaseStatus'], 'no-contact-started')
                    # Early release deliberately cancels: preserve the original failed report anyway.
                    connection.request('POST', f'/{RUN}/report', raw, {'Content-Type': 'application/json',
                        'X-Forgeax-Report-Bytes': str(len(raw)), 'X-Forgeax-Report-Sha256': digest(raw)})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read())['sha256'], digest(raw))
                except Exception as error:
                    failures.append(error)
                    control.cancel.set()
                finally:
                    connection.close()
                    peer_done.set()

            original_start, original_close = GameplayControl.start, GameplayControl.close
            def start(control, *_):
                original_start(control)
                worker = threading.Thread(target=peer, args=(control,))
                workers.append(worker)
                worker.start()
            def close(control):
                original_close(control)
                raise ValueError('offline cleanup failure')
            with patch.object(sys, 'argv', args), patch.object(runner, 'verify_publication', return_value=(phone, {})), \
                    patch.object(GameplayControl, 'start', start), patch.object(GameplayControl, 'close', close), \
                    patch.object(runner, 'print', side_effect=lambda text, **_: printed(text), create=True), \
                    patch.object(runner, 'perform_timeline') as native, patch.object(runner, 'make_timeline') as timeline, \
                    patch.object(runner, 'read_reviewed_capture') as capture, patch.object(runner, 'node_call') as analyze:
                self.assertEqual(runner.main(), 1)
                native.assert_not_called()
                timeline.assert_not_called()
                capture.assert_not_called()
                analyze.assert_not_called()
            for worker in workers:
                worker.join(2)
            self.assertTrue(peer_done.is_set())
            if failures:
                raise failures[0]
            self.assertEqual((out / 'phone-report.json').read_bytes(), raw)
            self.assertEqual((out / 'phone-report.json').stat().st_mode & 0o777, 0o600)
            result = json.loads((out / 'result.json').read_text())
            self.assertTrue(result['stationaryDiagnostic'])
            self.assertFalse(result['input']['attempted'])
            self.assertFalse(result['cleanFpsEvidence'])
            self.assertEqual(result['failure'], 'offline-stationary-partial')
            self.assertIn('offline cleanup failure', result['cleanupFailure'])

    def test_stationary_marker_is_bounded_source_bound_and_cannot_extend_deadline(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            expected = {'runId': RUN, 'diagnosticManifestSha256': 'a' * 64}
            for kind in ('preexisting', 'symlink', 'oversize', 'wrong-source', 'extra-field', 'expired', 'valid'):
                with self.subTest(kind=kind):
                    marker = base / (kind + '.json')
                    control = GameplayControl({}, base, threading.Event(), deadline=5)
                    control.input_deadline = time.monotonic() + 1
                    if kind == 'preexisting':
                        marker.write_text(json.dumps(expected))
                    original_check = control.check_input_deadline
                    def publish():
                        original_check()
                        if kind == 'symlink':
                            marker.symlink_to('missing')
                        else:
                            value = {**expected, 'extra': True} if kind == 'extra-field' else expected
                            if kind == 'wrong-source':
                                value = {**expected, 'diagnosticManifestSha256': 'b' * 64}
                            marker.write_text(' ' * 4097 if kind == 'oversize' else json.dumps(value))
                    if kind == 'expired':
                        control.input_deadline = time.monotonic() - 1
                    with patch.object(control, 'check_input_deadline', side_effect=publish), \
                            patch.object(sys, 'stdout', io.StringIO()):
                        if kind == 'valid':
                            self.assertEqual(runner.wait_for_stationary_arm(control, marker, RUN, 'a' * 64), expected)
                        else:
                            with self.assertRaises(ValueError):
                                runner.wait_for_stationary_arm(control, marker, RUN, 'a' * 64)
                    self.assertFalse(control.input_ready.is_set())
                    self.assertFalse(control.armed.is_set())

    def test_complete_needs_matching_source_order_phases_drain_and_landing(self):
        validate_gameplay_report(report(), SOURCE, RUN, PHASES)
        for mutate in [lambda x: x.update(source={}),
                       lambda x: x['capture']['events'][1].update(phase=2),
                       lambda x: x['capture']['events'][2].update(frameId=0),
                       lambda x: x['capture']['drain']['renderer']['frame'].update(pendingCompletionCount=1),
                       lambda x: x['debugReceipts'].append({'enableDebug': False}),
                       lambda x: x['debug']['after']['appBaseInfo'].update(enableDebug=False),
                       lambda x: x['websocket']['events'].append({'atMs': 2010}),
                       lambda x: x['afterPlayer'].update(grounded=False)]:
            value = copy.deepcopy(report())
            mutate(value)
            with self.assertRaises(ValueError):
                validate_gameplay_report(value, SOURCE, RUN, PHASES)

    def test_uses_shared_timeline_with_native_display_conversion(self):
        roles = {'move-stick': (10, 200, 100, 100), 'look-pad': (180, 50, 280, 180),
                 'run': (600, 240, 50, 50), 'jump': (700, 240, 50, 50)}
        observation = {'visible': True, 'display': {'width': 800, 'height': 360, 'pixelRatio': 4,
                        'drawingWidth': 3200, 'drawingHeight': 1440},
                       'ui': {'truncated': False, 'nodes': [
                           {'attributes': {'data-ui-part': part}, 'rect': dict(zip(('x', 'y', 'width', 'height'), rect))}
                           for part, rect in roles.items()]}}
        value = make_timeline('node', observation, {'width': 3200, 'height': 1440}, 1000)
        self.assertEqual(value['coordinateSpace'], {'width': 3200, 'height': 1440, 'unit': 'device-px'})
        self.assertEqual(value['events'][-1]['contacts'], [])
        self.assertEqual(value['workload'], 'shuttle-250ms/1')
        selected = make_timeline('node', observation, {'width': 3200, 'height': 1440}, 1000,
                                 {'jump': {'u': .5, 'v': .85}})
        self.assertEqual(selected['buttonPoints'], {'run': {'u': .5, 'v': .5}, 'jump': {'u': .5, 'v': .85}})
        jumps = [contact for event in selected['events'] for contact in event['contacts'] if contact['role'] == 'jump']
        self.assertTrue(jumps)
        self.assertTrue(all(contact['x'] == 2900 and contact['y'] == 1130 for contact in jumps))
        self.assertEqual(observation['ui']['nodes'][-1]['rect'], {'x': 700, 'y': 240, 'width': 50, 'height': 50})

    def test_await_capture_cli_listens_before_reading_future_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            publication = base / 'publication'
            publication.mkdir()
            (publication / 'forgeax-dist.json').write_text('{"target":"wechat"}')
            capture_path, screenshot_path = base / 'future.json', base / 'future.png'
            out = base / 'result'
            args = ['runner', '--await-capture', '--publication', str(publication), '--out', str(out),
                    '--manifest', str(publication / 'forgeax-dist.json'), '--adb', '/unused-adb',
                    '--serial', 'offline', '--cache', str(base / 'cache'),
                    '--capture-result', str(capture_path), '--screenshot', str(screenshot_path)]
            phone = {'controlUrl': 'http://127.0.0.1:12345/offline', 'runId': RUN, 'mode': 'qualification'}
            def started(control, *_):
                self.assertFalse(capture_path.exists())
                self.assertFalse(screenshot_path.exists())
                control.ready.set()
                control.state = 'preparing-input'
                control.input_deadline = time.monotonic() + 1
                # An invalid publication handoff must fail before any native operation.
                screenshot_path.write_bytes(b'image')
                capture_path.write_text('{')
            with patch.object(sys, 'argv', args), patch.object(runner, 'verify_publication', return_value=(phone, {})), \
                    patch.object(runner.GameplayControl, 'start', started), \
                    patch.object(runner.GameplayControl, 'close'), patch.object(runner, 'perform_timeline') as native:
                self.assertEqual(runner.main(), 1)
                native.assert_not_called()
            value = json.loads((out / 'result.json').read_text())
            self.assertEqual(value['input'], {'attempted': False, 'state': 'not-attempted'})
            self.assertIn('JSONDecodeError', value['failure'])

    def test_await_capture_rejects_existing_files_and_transport_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            captured = base / 'existing.json'
            captured.write_text('{}')
            args = [sys.executable, str(Path(__file__).with_name('run_phone_gameplay_benchmark.py')),
                    '--await-capture', '--publication', '/unused-publication', '--out', str(base / 'uncreated'),
                    '--manifest', '/unused-manifest', '--adb', '/unused-adb', '--serial', 'offline',
                    '--cache', str(base / 'cache'), '--capture-result', str(captured),
                    '--screenshot', str(base / 'future.png')]
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('must not already exist', result.stderr)
            self.assertFalse((base / 'uncreated').exists())
            captured.unlink()
            result = subprocess.run(args + ['--transport-only'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('cannot be combined', result.stderr)
            self.assertFalse((base / 'uncreated').exists())

    def test_cli_rejects_nonobject_button_points_before_output_or_native_setup(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary) / 'uncreated'
            for value in ('[]', 'null'):
                result = subprocess.run([sys.executable, str(Path(__file__).with_name('run_phone_gameplay_benchmark.py')),
                    '--publication', '/unused-publication', '--out', str(out), '--transport-only',
                    '--button-points', value], capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn('button-points must be a JSON object', result.stderr)
                self.assertFalse(out.exists())


if __name__ == '__main__':
    unittest.main()
