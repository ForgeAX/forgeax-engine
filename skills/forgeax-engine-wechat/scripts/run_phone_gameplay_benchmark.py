#!/usr/bin/env python3
"""Collect one native gameplay capture through an explicitly configured ADB reverse.

Requires a reviewed --for-input capture; --await-capture listens before preview
and accepts a future reviewed file pair within the existing ready deadline.
--stationary-diagnostic ARM_FILE instead collects eight seconds without native
input, after the operator publishes a source-bound marker following readiness.
No preview, login, reverse creation, screenshot or thermal sampling is implicit.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import re
import selectors
import signal
import socket
import subprocess
import threading
import time
from urllib.parse import urlsplit

from android_game_multitouch import perform_timeline, validate_timeline, verify_inputs
from diagnose_phone_startup import validate_report_url
from receive_phone_gl_report import private_write

HERE = Path(__file__).resolve().parent
MAX_REPORT = 24 * 1024 * 1024
INPUT_SETUP_SECONDS = 118  # Two seconds inside the phone ready exchange deadline.


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save(path, value):
    private_write(path, (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode())


def read_bounded(path, limit):
    with Path(path).open('rb') as source:
        value = source.read(limit + 1)
    if len(value) > limit:
        raise ValueError(f'{Path(path).name} exceeds input size limit')
    return value


def read_reviewed_capture(capture_result, screenshot, control=None):
    if control is not None:
        while True:
            control.check_input_deadline()
            # The operator reviews elsewhere, publishes the PNG, then atomically
            # publishes result.json last. File creation is the explicit handoff.
            if Path(capture_result).exists() and Path(screenshot).exists():
                break
            control.cancel.wait(.05)
    captured_bytes = read_bounded(capture_result, 65536)
    captured = json.loads(captured_bytes)
    screenshot_bytes = read_bounded(screenshot, 64 * 1024 * 1024)
    return captured, captured_bytes, screenshot_bytes


def wait_for_stationary_arm(control, path, run_id, manifest_sha256):
    """Wait for the operator's after-ready image/PID/headroom handoff."""
    if path.exists() or path.is_symlink():
        raise ValueError('Arm marker appeared before readiness was handed off')
    print(json.dumps({'state': 'awaiting-arm', 'runId': run_id, 'armFile': str(path),
                      'diagnosticManifestSha256': manifest_sha256,
                      'remainingSeconds': max(0, control.input_deadline - time.monotonic())}), flush=True)
    while True:
        control.check_input_deadline()
        if path.is_symlink():
            raise ValueError('Arm marker must be a regular file, not a symlink')
        if path.exists():
            if not path.is_file():
                raise ValueError('Arm marker must be a regular file')
            value = json.loads(read_bounded(path, 4096))
            if value != {'runId': run_id, 'diagnosticManifestSha256': manifest_sha256}:
                raise ValueError('Arm marker does not match this exact run and publication')
            return value
        control.cancel.wait(.05)


def node_call(node, source, value):
    result = subprocess.run([node, '--input-type=module', '-e', source],
                            input=json.dumps(value).encode(), capture_output=True, timeout=30)
    if result.returncode:
        raise ValueError('Shared JavaScript tool failed: ' + result.stderr.decode(errors='replace')[-4000:])
    return json.loads(result.stdout)


def verify_publication(node, publication, selected_manifest):
    expected = digest(selected_manifest)
    result = node_call(node, '''
import {verifyNativePublication} from ''' + json.dumps((HERE / 'run_simulator_gameplay_benchmark.mjs').as_uri()) + ''';
let text=''; for await (const part of process.stdin) text+=part;
const v=JSON.parse(text); console.log(JSON.stringify(await verifyNativePublication(v.publication,v.hash)));
''', {'publication': str(publication), 'hash': expected})
    benchmark = json.loads(read_bounded(publication / 'benchmark-manifest.json', 8 * 1024 * 1024))
    phone = benchmark['source'].get('phone')
    if not phone or phone.get('mode') not in ('timed', 'cpu', 'gpu', 'qualification'):
        raise ValueError('Expected an explicitly prepared phone gameplay publication')
    if phone.get('debugPolicy') != 'unchanged':
        raise ValueError('Expected a phone capture that never toggles debug state')
    validate_report_url(phone['controlUrl'])
    if not re.fullmatch('[A-Za-z0-9_-]{16,96}', phone['runId']):
        raise ValueError('Invalid prepared phone run ID')
    return phone, result


def make_timeline(node, observation, captured, phase_ms, button_points=None):
    return node_call(node, '''
import {createGameplayTimeline} from ''' + json.dumps((HERE / 'fixtures/gameplay-benchmark/timeline.mjs').as_uri()) + ''';
import {geometryFromInspection} from ''' + json.dumps((HERE / 'run_gameplay_benchmark.mjs').as_uri()) + ''';
let text=''; for await (const part of process.stdin) text+=part;
const {observation,captured,phaseMs,buttonPoints}=JSON.parse(text), d=observation.display;
if (!observation.visible || ![d.width,d.height,d.pixelRatio,d.drawingWidth,d.drawingHeight].every(x=>Number.isFinite(x)&&x>0))
  throw Error('Visible native display required');
const sx=captured.width/d.width, sy=captured.height/d.height;
if(Math.abs(sx/sy-1)>0.01) throw Error('Full-screen native display aspect differs from reviewed screenshot');
const geometry=geometryFromInspection(observation.ui);
for(const r of Object.values(geometry)) {
  r.x*=sx;r.y*=sy;r.width*=sx;r.height*=sy;
  if(r.x<0||r.y<0||r.x+r.width>captured.width||r.y+r.height>captured.height)
    throw Error('Native controls leave the reviewed display');
}
console.log(JSON.stringify(createGameplayTimeline({geometry,phaseMs,buttonPoints,
  coordinateSpace:{width:captured.width,height:captured.height,unit:'device-px'}})));
''', {'observation': observation, 'captured': captured, 'phaseMs': phase_ms,
      'buttonPoints': {} if button_points is None else button_points})


def validate_gameplay_report(report, source, run_id, phases, mode='timed'):
    """Admit this explicit kind; collection failure is retained as a partial artifact."""
    if (not isinstance(report, dict) or report.get('kind') != 'forgeax-phone-gameplay'
            or report.get('schemaVersion') != 'forgeax-phone-gameplay/1'
            or report.get('source') != source or report.get('runId') != run_id
            or report.get('mode') != mode or report.get('status') not in ('complete', 'partial')
            or not finite(report.get('finishedAt'))):
        raise ValueError('Gameplay report kind, source, run or terminal state mismatch')
    if mode != 'timed' and (report.get('diagnostic') != mode or report.get('cleanFpsEvidence') is not False):
        raise ValueError('Intrusive phone capture must be explicitly diagnostic')
    capture = report.get('capture')
    if capture is None:
        if report['status'] == 'complete' or not isinstance(report.get('failure'), str):
            raise ValueError('Complete report requires the actual capture')
        return report
    if (not isinstance(capture, dict) or capture.get('schemaVersion') != 'forgeax-gameplay-capture/1'
            or capture.get('status') not in ('complete', 'partial') or capture.get('phases') != phases
            or not finite(capture.get('startMs')) or not finite(capture.get('endMs'))
            or capture['endMs'] <= capture['startMs'] or capture['endMs'] - capture['startMs'] > 120000
            or type(capture.get('capacity')) is not int or not 1 <= capture['capacity'] <= 65536
            or not isinstance(capture.get('events'), list) or len(capture['events']) > capture['capacity']):
        raise ValueError('Invalid bounded gameplay capture')
    previous, frames = -math.inf, {'submitted': -1, 'completed': -1}
    for event in capture['events']:
        if (not isinstance(event, dict) or event.get('kind') not in frames
                or not finite(event.get('atMs')) or not capture['startMs'] <= event['atMs'] < capture['endMs']
                or event['atMs'] < previous or type(event.get('frameId')) is not int
                or not 0 <= event['frameId'] <= 2 ** 53 - 1
                or event['frameId'] <= frames[event['kind']] or type(event.get('phase')) is not int
                or not 0 <= event['phase'] < len(phases)):
            raise ValueError('Invalid frame event order, identity or timestamp')
        phase = phases[event['phase']]
        if not phase['startMs'] <= event['atMs'] - capture['startMs'] < phase['endMs']:
            raise ValueError('Frame phase does not match timestamp')
        previous, frames[event['kind']] = event['atMs'], event['frameId']
    if report['status'] == 'complete':
        debug = report.get('debug', {})
        before, after = debug.get('before', {}), debug.get('after', {})
        events = report.get('websocket', {}).get('events', [])
        if (debug.get('policy') != 'unchanged' or report.get('debugReceipts')
                or report.get('cleanFpsEvidence') is not False or report.get('diagnosticOnly') is not True
                or type(before.get('appBaseInfo', {}).get('enableDebug')) is not bool
                or before['appBaseInfo']['enableDebug'] != after.get('appBaseInfo', {}).get('enableDebug')
                or not finite(before.get('atMs')) or not finite(after.get('atMs'))
                or before['atMs'] >= capture['startMs'] or after['atMs'] < capture['endMs']
                or not events or any(not finite(row.get('atMs')) or
                    capture['startMs'] <= row['atMs'] < capture['endMs'] for row in events)):
            raise ValueError('Unchanged observed debug state and silent timed socket required')
        drain = capture.get('drain', {})
        player = report.get('afterPlayer', {})
        controls = player.get('controls', {})
        if (capture['status'] != 'complete' or capture.get('failure') is not None
                or report.get('failure') is not None or not drain.get('success')
                or type(drain.get('lastSubmittedFrame')) is not int
                or drain.get('lastSubmittedFrame') != drain.get('lastCompletedFrame')
                or drain.get('renderer', {}).get('frame', {}).get('pendingCompletionCount') != 0
                or not capture['events'] or player.get('grounded') is not True
                or controls.get('horizontal') != 0 or controls.get('vertical') != 0
                or controls.get('run') is not False):
            raise ValueError('Complete capture has unresolved drain, input or frame failure')
    return report


class GameplayControl:
    """One finite readiness/arm/release/report exchange, with same-host clock bounds."""
    def __init__(self, phone, out, cancellation, deadline=180, max_uncertainty_ms=25, observe_only=False):
        self.phone, self.out, self.cancel = phone, Path(out), cancellation
        self.stop_at = time.monotonic() + deadline
        self.max_uncertainty_ms = max_uncertainty_ms
        self.observe_only = observe_only
        self.ready = threading.Event()
        self.input_ready = threading.Event()
        self.armed = threading.Event()
        self.released = threading.Event()
        self.finished = threading.Event()
        self.lock = threading.Lock()
        self.state = 'waiting-ready'
        self.observation = self.timeline = self.input = self.report = self.synchronization = None
        self.failure = None
        self.input_deadline = None
        self.connections = set()
        self.thread = None

    def wait(self, event, limit=30, ignore_cancel=False):
        until = min(self.stop_at, time.monotonic() + limit)
        while not event.wait(.05):
            if (self.cancel.is_set() and not ignore_cancel) or time.monotonic() >= until:
                raise ValueError('Capture cancelled or control deadline expired')

    def check_input_deadline(self):
        if (self.cancel.is_set() or self.input_deadline is None
                or time.monotonic() >= min(self.stop_at, self.input_deadline)):
            raise ValueError(self.failure or 'Input setup cancelled or ready deadline expired')

    def start_capture(self):
        self.check_input_deadline()
        self.input_ready.set()
        self.wait(self.armed, 15)
        if self.failure:
            raise ValueError(self.failure)
        return self.synchronization['startMonotonicMs'] / 1000

    def handle(self, stage, value):
        if (not isinstance(value, dict) or value.get('kind') != 'forgeax-phone-gameplay-control/1'
                or value.get('runId') != self.phone['runId'] or value.get('source') != self.phone['reportSource']
                or value.get('stage') != stage):
            raise ValueError('Control source, run or stage mismatch')
        if stage == 'ready':
            with self.lock:
                if self.state != 'waiting-ready':
                    raise ValueError('Readiness already consumed; a run never rearms')
                self.state = 'preparing-input'
                self.input_deadline = min(self.stop_at, time.monotonic() + INPUT_SETUP_SECONDS)
                self.observation = value.get('observation')
                if not isinstance(self.observation, dict):
                    raise ValueError('Missing ready observation')
                save(self.out / 'ready.json', value)
                self.ready.set()
                if self.observe_only:
                    self.state = 'waiting-report'
                    return {'action': 'observe-only'}
            self.wait(self.input_ready, INPUT_SETUP_SECONDS)
            self.check_input_deadline()
            if self.timeline is None:
                raise ValueError('No validated input timeline')
            debug = value.get('debug', {})
            if (debug.get('policy') != 'unchanged'
                    or type(debug.get('before', {}).get('appBaseInfo', {}).get('enableDebug')) is not bool):
                raise ValueError('Observed unchanged debug state required before arming')
            self.state = 'waiting-armed'
            self.arm_sent = time.monotonic()
            return {'action': 'arm', 'phases': self.timeline['phases'],
                    'durationMs': self.timeline['durationMs'], 'delayMs': 2000, 'maxEvents': 65536}
        if stage == 'armed':
            received = time.monotonic()
            if self.state != 'waiting-armed':
                raise ValueError('Unexpected or duplicate armed receipt')
            arm = value.get('arm', {})
            if (not all(finite(arm.get(key)) for key in ('startMs', 'endMs', 'nowMs'))
                    or not 1000 <= arm['startMs'] - arm['nowMs'] <= 2000
                    or arm['endMs'] - arm['startMs'] != self.timeline['durationMs']):
                raise ValueError('Invalid phone Platform clock range')
            uncertainty = (received - self.arm_sent) * 500
            start = (received + self.arm_sent) / 2 + (arm['startMs'] - arm['nowMs']) / 1000
            self.synchronization = {
                'armSentMonotonicMs': self.arm_sent * 1000, 'armedReceivedMonotonicMs': received * 1000,
                'roundTripMs': uncertainty * 2, 'uncertaintyMs': uncertainty,
                'maxUncertaintyMs': self.max_uncertainty_ms, 'startMonotonicMs': start * 1000,
                'startEarliestMonotonicMs': start * 1000 - uncertainty,
                'startLatestMonotonicMs': start * 1000 + uncertainty,
                'phone': arm,
            }
            save(self.out / 'synchronization.json', self.synchronization)
            if uncertainty > self.max_uncertainty_ms or start - time.monotonic() < .25:
                self.failure = 'Startup clock uncertainty or remaining lead-in exceeded its bound'
                self.cancel.set()
                self.armed.set()
                raise ValueError(self.failure)
            self.state = 'capturing'
            self.armed.set()
            return {'action': 'accepted', 'synchronization': self.synchronization}
        if stage == 'release':
            if self.state not in ('capturing', 'waiting-armed'):
                raise ValueError('Unexpected input release request')
            if not self.synchronization or time.monotonic() * 1000 < (
                    self.synchronization['startMonotonicMs'] + self.timeline['durationMs'] - 100):
                self.cancel.set()  # An early phone failure stops native input, then waits for cleanup.
            self.wait(self.released, 10, ignore_cancel=True)
            self.state = 'waiting-report'
            execution = self.input.get('session', {}).get('execution', {}) if self.input else {}
            released = execution.get('releaseStatus') in ('up-messages-dispatched', 'no-contact-started')
            return {'action': 'released' if released else 'release-unknown', 'input': self.input}
        raise ValueError('Unknown fixed control stage')

    def start(self, node=None, websocket_bundle=None):
        owner = self
        url = urlsplit(self.phone['controlUrl'])

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def setup(self):
                self.request.settimeout(20)
                with owner.lock:
                    owner.connections.add(self.request)
                super().setup()

            def finish(self):
                try:
                    super().finish()
                finally:
                    with owner.lock:
                        owner.connections.discard(self.request)

            def reply(self, code, data):
                body = json.dumps(data).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                prefix = url.path + '/'
                stage = self.path[len(prefix):] if self.path.startswith(prefix) else ''
                if stage not in ('ready', 'armed', 'release', 'report'):
                    self.reply(404, {'status': 'rejected', 'reason': 'unexpected-path'})
                    return
                try:
                    for key in ('Content-Type', 'Content-Length'):
                        if len(self.headers.get_all(key, [])) != 1:
                            raise ValueError('Exactly one ' + key + ' required')
                    length = self.headers['Content-Length']
                    if (self.headers.get('Transfer-Encoding')
                            or self.headers['Content-Type'].split(';')[0] != 'application/json'
                            or not length.isascii() or not length.isdigit()
                            or not 0 < int(length) <= (MAX_REPORT if stage == 'report' else 2 * 1024 * 1024)):
                        raise ValueError('Bounded fixed-length JSON required')
                    body = self.rfile.read(int(length))
                    if len(body) != int(length):
                        raise ValueError('Incomplete body')
                    value = json.loads(body)
                    if stage == 'report':
                        for key in ('X-Forgeax-Report-Bytes', 'X-Forgeax-Report-Sha256'):
                            if len(self.headers.get_all(key, [])) != 1:
                                raise ValueError('Exactly one ' + key + ' required')
                        if (self.headers['X-Forgeax-Report-Bytes'] != str(len(body))
                                or self.headers['X-Forgeax-Report-Sha256'] != digest(body)):
                            raise ValueError('Report bytes or SHA-256 mismatch')
                        validate_gameplay_report(value, owner.phone['reportSource'], owner.phone['runId'],
                                                 owner.timeline['phases'] if owner.timeline else None,
                                                 owner.phone.get('mode', 'timed'))
                        if owner.report is not None:
                            if (owner.out / 'phone-report.json').read_bytes() != body:
                                raise ValueError('Terminal report bytes changed')
                        else:
                            private_write(owner.out / 'phone-report.json', body)
                            owner.report = value
                        if value['status'] != 'complete':
                            owner.cancel.set()
                        self.reply(200, {'status': 'saved', 'bytes': len(body), 'sha256': digest(body)})
                        owner.finished.set()
                    else:
                        response = owner.handle(stage, value)
                        self.reply(200, {'runId': owner.phone['runId'], 'stage': stage, **response})
                except Exception as error:
                    owner.failure = str(error)[:2048]
                    try:
                        self.reply(400, {'status': 'rejected', 'reason': owner.failure})
                    except OSError:
                        pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0 if websocket_bundle else url.port), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .1}, daemon=True)
        self.thread.start()
        self.bridge = None
        if websocket_bundle:
            bundle = Path(websocket_bundle).resolve(strict=True)
            config = {'controlUrl': self.phone['controlUrl'],
                      'backendUrl': f'http://127.0.0.1:{self.server.server_port}{url.path}',
                      'runId': self.phone['runId'], 'source': self.phone['reportSource'],
                      'eventsFile': str(self.out / 'transport-events.json')}
            config_path = self.out / 'transport-config.json'
            save(config_path, config)
            self.bridge_stderr = (self.out / 'transport-stderr.txt').open('xb')
            self.bridge = subprocess.Popen([node, str(bundle), '--config', str(config_path)],
                                           stdout=subprocess.PIPE, stderr=self.bridge_stderr, text=True)
            with selectors.DefaultSelector() as selector:
                selector.register(self.bridge.stdout, selectors.EVENT_READ)
                if not selector.select(10):
                    raise ValueError('WebSocket carrier listening deadline')
                receipt = self.bridge.stdout.readline()
            if not receipt or json.loads(receipt).get('state') != 'listening':
                raise ValueError('WebSocket carrier did not confirm listening')
            save(self.out / 'transport-listening.json', json.loads(receipt))

    def close(self):
        self.cancel.set()
        if getattr(self, 'bridge', None):
            self.bridge.terminate()
            try:
                self.bridge.wait(3)
            except subprocess.TimeoutExpired:
                self.bridge.kill()
                self.bridge.wait(2)
            self.bridge.stdout.close()
            self.bridge_stderr.close()
        self.server.shutdown()
        with self.lock:
            connections = list(self.connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.server.server_close()
        self.thread.join(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('adb', 'serial', 'cache', 'capture-result', 'screenshot', 'manifest', 'publication', 'out'):
        parser.add_argument('--' + key, required=key in ('publication', 'out'))
    parser.add_argument('--await-capture', action='store_true',
                        help='Listen before preview; wait for future manually reviewed capture files within the ready deadline')
    parser.add_argument('--transport-only', action='store_true', help='Receive readiness/report only; no ADB or input setup')
    parser.add_argument('--stationary-diagnostic', type=Path, metavar='ARM_FILE',
                        help='Eight-second CPU/completion diagnostic without input; publish this new source-bound marker after awaiting-arm')
    parser.add_argument('--node', default='node')
    parser.add_argument('--ws-host', default=str(HERE / 'phone_gameplay_ws_host.bundle.mjs'),
                        help='Frozen Node ws carrier bundle; no package installation on the ADB host')
    parser.add_argument('--phase-ms', type=int, default=10000)
    parser.add_argument('--button-points', type=json.loads, default={},
                        help='Explicit JSON run/jump points within inspected rectangles, e.g. {"jump":{"u":0.5,"v":0.85}}; omitted buttons use center')
    parser.add_argument('--deadline', type=int, default=180)
    parser.add_argument('--max-start-uncertainty-ms', type=float, default=25)
    args = parser.parse_args()
    if sum(bool(value) for value in (args.await_capture, args.transport_only, args.stationary_diagnostic)) > 1:
        parser.error('await-capture, transport-only and stationary-diagnostic cannot be combined')
    if args.stationary_diagnostic:
        if not args.stationary_diagnostic.is_absolute():
            parser.error('stationary-diagnostic requires an absolute future arm marker path')
        if args.stationary_diagnostic.exists() or args.stationary_diagnostic.is_symlink():
            parser.error('stationary-diagnostic arm marker must not already exist; publish only after awaiting-arm')
    if not isinstance(args.button_points, dict):
        parser.error('button-points must be a JSON object')
    if not args.transport_only and not args.stationary_diagnostic and any(getattr(args, key) is None for key in
            ('adb', 'serial', 'cache', 'capture_result', 'screenshot', 'manifest')):
        parser.error('Gameplay input requires adb, serial, cache, reviewed capture-result, screenshot and manifest')
    if args.await_capture:
        paths = [Path(args.capture_result), Path(args.screenshot)]
        if any(not path.is_absolute() for path in paths) or paths[0] == paths[1]:
            parser.error('await-capture requires two distinct absolute future file paths')
        if any(path.exists() or path.is_symlink() for path in paths):
            parser.error('await-capture files must not already exist; publish only after image review')
    if (not 250 <= args.phase_ms <= 30000 or not 30 <= args.deadline <= 600
            or not 0 < args.max_start_uncertainty_ms <= 100 or not Path(args.out).is_absolute()):
        parser.error('Invalid bounded duration, deadline, uncertainty or absolute output path')
    out = Path(args.out)
    out.mkdir(mode=0o700)
    cancellation = threading.Event()
    previous = {kind: signal.signal(kind, lambda *_: cancellation.set()) for kind in (signal.SIGINT, signal.SIGTERM)}
    control = None
    result = {'schemaVersion': 'forgeax-phone-gameplay-run/1', 'success': False,
              'qualification': 'Collection only; native action qualification, image review and temperature evidence are external.',
              'thermal': {'status': 'external-evidence-required'}, 'mode': 'timed',
              'diagnosticOnly': True, 'cleanFpsEvidence': False,
              'input': {'attempted': False, 'state': 'not-attempted'}}
    try:
        publication = Path(args.publication).resolve()
        manifest = read_bounded(args.manifest or publication / 'forgeax-dist.json', 8 * 1024 * 1024)
        phone, verified = verify_publication(args.node, publication, manifest)
        result.update(source=verified, runId=phone['runId'], mode=phone['mode'], selectedManifestSha256=digest(manifest))
        if args.stationary_diagnostic:
            result.update(stationaryDiagnostic=True,
                          qualification='Stationary CPU/completion collection only; no native action or clean FPS qualification.')
            if (phone['mode'] != 'cpu' or phone.get('cpuFrames') != 120
                    or phone.get('completionTiming') is not True):
                raise ValueError('Stationary diagnostic requires a prepared 120-frame CPU/completion publication')
        if not args.transport_only and not args.await_capture and not args.stationary_diagnostic:
            captured, captured_bytes, screenshot = read_reviewed_capture(args.capture_result, args.screenshot)
            result.update(captureResultSha256=digest(captured_bytes), screenshotSha256=digest(screenshot))
        # The existing native driver rechecks all source/screenshot/target bindings before connecting.
        control = GameplayControl(phone, out, cancellation, args.deadline, args.max_start_uncertainty_ms,
                                  observe_only=args.transport_only)
        control.start(args.node, args.ws_host)
        print(json.dumps({'state': 'listening', 'controlUrl': phone['controlUrl'], 'out': str(out)}), flush=True)
        control.wait(control.ready, args.deadline)
        if args.transport_only:
            control.wait(control.finished, args.deadline, ignore_cancel=True)
            result.update(transportOnly=True, input={'attempted': False, 'state': 'not-attempted'},
                          qualification='Transport observation only; no input or FPS capture.',
                          success=control.report.get('failure') == 'transport-observation-only',
                          phoneReason=control.report.get('failure'), connection=control.report.get('connection'))
        else:
            if args.stationary_diagnostic:
                player = control.observation.get('player', {})
                controls = player.get('controls', {})
                if (player.get('grounded') is not True or controls.get('horizontal') != 0
                        or controls.get('vertical') != 0 or controls.get('run') is not False):
                    raise ValueError('Stationary diagnostic requires a neutral grounded player at readiness')
                timeline = {'durationMs': 8000, 'phases': [{'name': 'stationary', 'startMs': 0, 'endMs': 8000}]}
                control.timeline = timeline
                # No native service or contact exists; this is not an input-dispatch witness.
                native = {'attempted': False, 'state': 'not-attempted',
                          'session': {'execution': {'releaseStatus': 'no-contact-started'}}}
                control.input = result['input'] = native
                control.released.set()
                code = 0
                save(out / 'timeline.json', timeline)
                save(out / 'input-result.json', native)
                marker = wait_for_stationary_arm(control, args.stationary_diagnostic, phone['runId'], digest(manifest))
                save(out / 'arm-marker.json', marker)
                control.start_capture()
                print(json.dumps({'state': 'armed', 'runId': phone['runId'], 'durationMs': 8000,
                                  'synchronization': control.synchronization}), flush=True)
            else:
                if args.await_capture:
                    result['awaitCapture'] = True
                    print(json.dumps({'state': 'awaiting-reviewed-capture',
                                      'remainingMs': max(0, control.input_deadline - time.monotonic()) * 1000}), flush=True)
                    captured, captured_bytes, screenshot = read_reviewed_capture(args.capture_result, args.screenshot, control)
                    result.update(captureResultSha256=digest(captured_bytes), screenshotSha256=digest(screenshot))
                timeline = make_timeline(args.node, control.observation, captured, args.phase_ms, args.button_points)
                validate_timeline(timeline, captured['width'], captured['height'])
                verify_inputs(args.serial, captured, manifest, screenshot, timeline)
                save(out / 'timeline.json', timeline)
                control.timeline = timeline
                try:
                    native, code = perform_timeline(args.adb, args.serial, args.cache, captured, manifest,
                                                    screenshot, timeline, cancellation,
                                                    start_capture=control.start_capture)
                    control.input = native
                    result['input'] = native
                    save(out / 'input-result.json', native)
                finally:
                    control.released.set()
            # Keep the original phone App running until its input release/landing/receipt drain completes.
            remaining = max(1, control.stop_at - time.monotonic())
            until = time.monotonic() + remaining
            while not control.finished.wait(.1) and time.monotonic() < until:
                if cancellation.is_set() and not control.armed.is_set():
                    break
            if control.report is None:
                raise ValueError('Phone report deadline: ' + str(control.failure))
            result.update(success=code == 0 and control.report['status'] == 'complete',
                          synchronization=control.synchronization, phoneStatus=control.report['status'],
                          debug=control.report.get('debug'),
                          failure=control.report.get('failure') or control.failure)
            if args.stationary_diagnostic:
                cpu = control.report.get('cpu') or {}
                if (control.report.get('cpuError') is not None or cpu.get('status') != 'complete'
                        or (cpu.get('validation') or {}).get('ok') is not True
                        or (cpu.get('coverage') or {}).get('ownerCoverageComplete') is not True):
                    result.update(success=False,
                                  failure=result['failure'] or 'stationary-cpu-capture-incomplete')
                if control.report.get('cpuError') is not None:
                    result['cpuError'] = control.report['cpuError']
            for diagnostic in ('cpu', 'gpu'):
                if control.report.get(diagnostic):
                    save(out / (diagnostic + '.json'), control.report[diagnostic])
                    result[diagnostic] = {'status': control.report[diagnostic].get('status'),
                                          'window': control.report.get('diagnosticWindow')}
            if control.report.get('inputQualification'):
                save(out / 'qualification.json', control.report['inputQualification'])
                result['semanticQualification'] = {key: value for key, value in control.report['inputQualification'].items()
                                                    if key != 'samples'}
            if control.report.get('capture') and not args.stationary_diagnostic:
                execution = native.get('session', {}).get('execution', {})
                analyzed = node_call(args.node, '''
import {analyzeGameplay,formatAnalysis} from ''' + json.dumps((HERE / 'analyze_gameplay_performance.mjs').as_uri()) + ''';
let text='';for await(const part of process.stdin)text+=part;const report=JSON.parse(text);
console.log(JSON.stringify({json:analyzeGameplay(report),markdown:formatAnalysis(report)}));
''', {**control.report, 'source': verified, 'workload': timeline.get('workload'),
          'semanticQualification': control.report.get('inputQualification') or
              {'success': False, 'reason': 'Independent native action qualification required'},
          'inputDispatch': {'success': code == 0,
                            'droppedEvents': len(timeline['events']) - execution.get('eventsDispatched', 0),
                            'releaseStatus': execution.get('releaseStatus')},
          'performanceQualification': {'status': 'unverified', 'reason': 'External thermal/image/action evidence'}})
                save(out / 'analysis.json', analyzed['json'])
                private_write(out / 'analysis.md', analyzed['markdown'].encode())
                result['analysis'] = {'status': analyzed['json']['status'],
                                      'fps': analyzed['json']['all']['fps']}
        verify_publication(args.node, publication, manifest)
    except Exception as error:
        result.update(success=False, failure=f'{type(error).__name__}: {str(error)[:4096]}')
        if control and control.report:
            result['phoneFailure'] = control.report.get('failure')
            result['connection'] = control.report.get('connection')
    finally:
        if control:
            try:
                control.close()
            except Exception as error:
                result.update(success=False, cleanupFailure=f'{type(error).__name__}: {str(error)[:4096]}')
        for kind, handler in previous.items():
            signal.signal(kind, handler)
        save(out / 'result.json', result)
    print(json.dumps({'success': result['success'], 'failure': result.get('failure'),
                      'result': str(out / 'result.json'),
                      **({'transportOnly': True} if args.transport_only else {})}))
    return 0 if result['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
