#!/usr/bin/env python3
"""Measure ordinary game completion counters around actual official simulator input."""
import argparse
import contextlib
from datetime import datetime
import hashlib
import inspect
import io
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

from wechatide import ToolFailure, invoke, load_config, transport
from wait_game import observe


SCRIPTS = Path(__file__).resolve().parent
STATE = '''async function(){
  const interaction=INTERACTION;
  const g=GameGlobal.__gameContextWindow, i=g?.__forgeaxGameInspection;
  if(typeof g?.performance?.now!=='function')return {failure:'game-clock-unavailable'};
  const clock=g.performance,before=clock.now(),r=i?.renderer?.();
  const canvases=GameGlobal.document.querySelectorAll('canvas#myCanvas');
  const c=canvases.length===1?canvases[0]:undefined;
  const w=g.wx?.getWindowInfo?.();
  const player=interaction&&await i.read('game-3d.player');
  const vase=interaction&&await i.read('game-3d.runtime-vase');
  const after=clock.now();
  return JSON.parse(JSON.stringify({utcMs:Date.now(),clockOriginMs:clock.timeOrigin,
    observedAtMs:(before+after)/2,observationCostMs:after-before,
    canvas:c&&{width:c.width,height:c.height},canvasCount:canvases.length,
    display:w&&{width:w.windowWidth,height:w.windowHeight,pixelRatio:w.pixelRatio},
    temporaryProbePresent:!!g?.__forgeaxDfgConstProbe,
    capabilities:{rhiCapture:typeof i?.rhiCapture?.captureFrame==='function',
      profiler:!!i&&Object.keys(i).some(k=>/profiler/i.test(k))},
    renderer:r&&{generation:r.generation,phase:r.phase,completed:r.completed,
      presented:r.presented,capabilities:r.capabilities,
      startupError:r.startupError,lastError:r.lastError},player,vase},
    (key,v)=>v&&typeof v.message==='string'?{...v,name:v.name,message:v.message,cause:v.cause}:v));
}'''


def utc_ms(value):
    return datetime.fromisoformat(value).timestamp() * 1000


def headroom_facts(report):
    """Parse the existing Mac collector; totals are never treated as current paging."""
    required = ('intervalCpu', 'gpu', 'memory', 'pressure', 'thermal', 'vmBefore', 'vmAfter',
                'consoleBefore', 'consoleAfter')
    if any(report.get(key, {}).get('exitCode') != 0 for key in required):
        raise ToolFailure('headroom-observation-unavailable')
    for key in ('consoleBefore', 'consoleAfter'):
        state = report[key]
        if any(type(state.get(flag)) is not bool for flag in ('consoleLocked', 'screenLocked')):
            raise ToolFailure('headroom-console-state-unavailable')
    cpu = [float(x) for x in re.findall(r'([\d.]+)% idle', report['intervalCpu']['stdout'])][1:]
    samples = report['gpu']['samples']
    gpu = [float(v) for row in samples for stats in row.get('statistics', [])
           for k, v in stats.items() if k == 'Device Utilization %']
    if (not cpu or not gpu or any(row.get('status') != 'available' for row in samples)
            or any(not 0 <= v <= 100 for v in cpu + gpu)):
        raise ToolFailure('headroom-interval-unavailable')
    def counter(key, text):
        match = re.search(r'^' + re.escape(key) + r':\s+(\d+)\.', text, re.M)
        if not match:
            raise ToolFailure('headroom-paging-counter-unavailable')
        return int(match[1])
    paging = {key: counter(key, report['vmAfter']['stdout']) - counter(key, report['vmBefore']['stdout'])
              for key in ('Swapins', 'Swapouts', 'Pageouts')}
    free = re.search(r'System-wide memory free percentage:\s*(\d+)%', report['memory']['stdout'])
    pressure = re.search(r'kern.memorystatus_vm_pressure_level:\s*(\d+)', report['pressure']['stdout'])
    thermal = report['thermal']['stdout'].strip().splitlines()
    known = ('Note: No thermal warning level has been recorded',
             'Note: No performance warning level has been recorded',
             'Note: No CPU power status has been recorded')
    return {'cpuIdlePercent': cpu, 'gpuDevicePercent': gpu, 'pagingDelta': paging,
            'console': {stage: {flag: report['console' + stage.capitalize()][flag]
                               for flag in ('consoleLocked', 'screenLocked')}
                        for stage in ('before', 'after')},
            'memoryFreePercent': int(free[1]) if free else None,
            'normalPressure': bool(pressure and pressure[1] == '1'),
            'noRecordedThermalWarning': bool(thermal) and all(line in known for line in thermal),
            'windowUtcMs': [utc_ms(samples[0]['atUtc']), utc_ms(samples[-1]['endedAtUtc'])]}


def qualify_headroom(report, minimum_cpu_idle=40, maximum_background_gpu=50, now_ms=None):
    facts = headroom_facts(report)
    age = (time.time() * 1000 if now_ms is None else now_ms) - utc_ms(report['endedAtUtc'])
    reasons = []
    if not 0 <= age <= 300_000:
        reasons.append('headroom-not-fresh')
    if min(facts['cpuIdlePercent']) < minimum_cpu_idle:
        reasons.append('insufficient-cpu-idle')
    if max(facts['gpuDevicePercent']) > maximum_background_gpu:
        reasons.append('background-gpu-busy')
    if facts['memoryFreePercent'] is None or facts['memoryFreePercent'] < 10 or not facts['normalPressure']:
        reasons.append('memory-pressure')
    if any(value != 0 for value in facts['pagingDelta'].values()):
        reasons.append('paging-during-preflight')
    if not facts['noRecordedThermalWarning']:
        reasons.append('thermal-observation-needs-review')
    return {'qualified': not reasons, 'reasons': reasons, 'facts': facts,
            'policy': {'minimumCpuIdlePercent': minimum_cpu_idle,
                       'maximumBackgroundGpuPercent': maximum_background_gpu,
                       'minimumMemoryFreePercent': 10, 'maximumAgeSeconds': 300}}


def verify_files(project, manifest_sha, original_config=None):
    """Runs on the publication machine; only additive IDE configuration metadata is admitted."""
    root = Path(project).resolve()
    data = (root / 'forgeax-dist.json').read_bytes()
    if hashlib.sha256(data).hexdigest() != manifest_sha:
        raise ValueError('publication-manifest-mismatch')
    manifest = json.loads(data)
    if manifest.get('target') != 'wechat' or not isinstance(manifest.get('artifacts'), list):
        raise ValueError('publication-target-invalid')
    seen, additions, total, configuration = set(), [], 0, None
    def extends(original, actual, path=''):
        if isinstance(original, dict) and isinstance(actual, dict):
            for key, value in original.items():
                if key not in actual:
                    raise ValueError('publication-config-value-removed')
                extends(value, actual[key], path + '/' + key)
            additions.extend(path + '/' + key for key in actual.keys() - original.keys())
        elif original != actual or type(original) is not type(actual):
            raise ValueError('publication-config-value-changed')
    for row in manifest['artifacts']:
        name = row['path']
        path = Path(name)
        if (path.is_absolute() or '..' in path.parts or not path.parts or name in seen
                or (root / path).resolve().parent != root and root not in (root / path).resolve().parents):
            raise ValueError('publication-path-invalid')
        seen.add(name)
        content = (root / path).read_bytes()
        total += len(content)
        exact = len(content) == row['bytes'] and hashlib.sha256(content).hexdigest() == row['sha256']
        if name == 'project.config.json':
            configuration = {'declaredSha256': row['sha256'],
                'actualSha256': hashlib.sha256(content).hexdigest(),
                'original': json.loads(original_config) if original_config is not None else json.loads(content),
                'actual': json.loads(content)}
        if not exact:
            if name != 'project.config.json' or original_config is None:
                raise ValueError('publication-artifact-mismatch: ' + name)
            original_bytes = original_config.encode()
            if len(original_bytes) != row['bytes'] or hashlib.sha256(original_bytes).hexdigest() != row['sha256']:
                raise ValueError('original-project-config-mismatch')
            extends(json.loads(original_config), json.loads(content))
    if 'game.js' not in seen or 'project.config.json' not in seen:
        raise ValueError('publication-entry-missing')
    return {'manifestSha256': manifest_sha, 'artifactsVerified': len(seen), 'bytesVerified': total,
            'project': manifest.get('project'), 'ideConfigurationAdditions': sorted(additions),
            'configuration': configuration}


def validate_state(value, interaction=False):
    r = value.get('renderer') or {}
    if (r.get('phase') != 'ready' or r.get('startupError') or r.get('lastError')
            or value.get('temporaryProbePresent') or value.get('canvasCount') != 1
            or not value.get('canvas') or r.get('presented', 0) < 60):
        raise ToolFailure('ordinary-ready-state-unavailable')
    if any(type(r.get(k)) is not int for k in ('generation', 'completed', 'presented')):
        raise ToolFailure('invalid-renderer-counters')
    if r['generation'] < 0 or r['completed'] < r['presented']:
        raise ToolFailure('inconsistent-renderer-counters')
    for key in ('utcMs', 'clockOriginMs', 'observedAtMs', 'observationCostMs'):
        if type(value.get(key)) not in (int, float) or not math.isfinite(value[key]):
            raise ToolFailure('invalid-game-clock')
    if value.get('capabilities', {}).get('rhiCapture'):
        raise ToolFailure('recorder-enabled-publication-is-not-uninstrumented-throughput')
    if interaction:
        player = value.get('player')
        if not isinstance(player, dict) or not isinstance(value.get('vase'), dict):
            raise ToolFailure('game-3d-projection-unavailable')
        if player.get('camera', {}).get('pointerLocked') is not False:
            raise ToolFailure('touch-player-pointer-locked')
    return value


def sample_delta(start, end):
    a, b = start['renderer'], end['renderer']
    elapsed = end['observedAtMs'] - start['observedAtMs']
    if (a['generation'] != b['generation'] or start['clockOriginMs'] != end['clockOriginMs']
            or start['canvas'] != end['canvas'] or start.get('display') != end.get('display')
            or not 9000 <= elapsed <= 30000
            or b['completed'] < a['completed'] or b['presented'] < a['presented']):
        raise ToolFailure('sample-identity-clock-or-counters-changed')
    result = {'start': start, 'end': end, 'elapsedMs': elapsed}
    for key in ('completed', 'presented'):
        result[key + 'Delta'] = b[key] - a[key]
        result[key + 'Fps'] = result[key + 'Delta'] * 1000 / elapsed
    return result


def player_neutral(state):
    controls = state['player']['controls']
    return controls['horizontal'] == 0 and controls['vertical'] == 0 and controls['run'] is False


def validate_player_scene(state, origin=None):
    """A falling player still presents frames; those no longer measure this scene."""
    player = state['player']
    position = player.get('position')
    if (not isinstance(position, list) or len(position) != 3
            or any(type(v) not in (int, float) or not math.isfinite(v) for v in position)
            or player.get('grounded') is not True):
        raise ToolFailure('game-3d-scene-retention-failed: player is not grounded at a finite position')
    if origin is not None and (math.hypot(position[0] - origin[0], position[2] - origin[2]) > 2.5
                               or abs(position[1] - origin[1]) > 0.35):
        raise ToolFailure('game-3d-scene-retention-failed: player left the bounded starting area')


class Measurement:
    def __init__(self, args):
        self.args, self.config = args, load_config(args.config)
        self.out = args.out
        self.out.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.report = {'success': False, 'project': args.project, 'manifestSha256': args.manifest_sha,
                       'interaction': args.interaction, 'samples': [], 'operations': [],
                       'toolSources': {name: hashlib.sha256((SCRIPTS / name).read_bytes()).hexdigest()
                           for name in ('measure_game_throughput.py', 'mac_headroom.py', 'wait_game.py', 'wechatide.py')},
                       'interpretation': 'Ordinary completed/presented counter windows at the recorded native input cadence. No frame-time tails or exclusive GPU timing.',
                       'continuousUiFrameBudget': {'status': 'not-measured',
                           'reason': 'CLI input cadence and aggregate counters do not establish one changed UI per completed frame or frame-interval p95.'}}
        self.sequence, self.identity, self.held, self.origin = 0, None, None, None

    def call(self, name, tool, *parameters):
        self.sequence += 1
        with contextlib.redirect_stdout(io.StringIO()):
            result, status = invoke(self.config, [tool, *parameters],
                                    self.out / f'{self.sequence:04}-{name}', 30)
        if status:
            raise ToolFailure(f'{name}: official status {status}; retained original tool result')
        return result['result']

    def state(self, name):
        result = self.call(name, 'automation_evaluate', '--project', self.args.project,
                           '--fn-source', STATE.replace('INTERACTION', json.dumps(bool(self.args.interaction))))
        value = validate_state(result['result'], bool(self.args.interaction))
        if self.args.interaction:
            validate_player_scene(value, self.origin)
            if self.origin is None:
                self.origin = tuple(value['player']['position'])
                self.report['sceneReference'] = {'position': self.origin,
                    'maximumHorizontalDistance': 2.5, 'maximumHeightChange': 0.35,
                    'groundedRequired': True, 'maximumContactEnvelopeMs': 4000}
        identity = (value['renderer']['generation'], value['clockOriginMs'], value['canvas'], value.get('display'))
        if self.identity is None:
            self.identity = identity
        if self.identity != identity:
            raise ToolFailure('game-identity-changed-across-windows')
        return value

    def publication(self):
        original = None
        if self.args.publication:
            verify_files(str(self.args.publication), self.args.manifest_sha)
            original = (self.args.publication / 'project.config.json').read_bytes().decode('utf-8')
        source = 'import hashlib,json,sys\nfrom pathlib import Path\n' + inspect.getsource(verify_files)
        source += '\nprint(json.dumps(verify_files(*json.loads(sys.stdin.read()))))\n'
        result = subprocess.run(transport(self.config, ['python3', '-I', '-c', source]),
                                input=json.dumps([self.args.project, self.args.manifest_sha, original]),
                                capture_output=True, text=True, timeout=45, check=False)
        if result.returncode:
            (self.out / 'publication-failure.stderr').write_text(result.stderr)
            raise ToolFailure('publication-verification-failed; see retained stderr')
        return json.loads(result.stdout)

    def touch(self, action, x, y):
        # Remember attempted down/move even if the CLI times out after native delivery.
        if action in ('touchstart', 'touchmove'):
            self.held = (x, y)
        started = time.time() * 1000
        result = self.call(action, 'automation_game_action', '--project', self.args.project,
                           '--action', action, '--x', str(x), '--y', str(y),
                           '--coordinate-space', 'image', '--image-width', '794', '--image-height', '368')
        if action == 'touchend':
            self.held = None
        self.report['operations'].append({'action': action, 'x': x, 'y': y,
                                         'startedUtcMs': started, 'endedUtcMs': time.time() * 1000})
        return result

    def release(self):
        if self.held is not None:
            self.touch('touchend', *self.held)

    def movement_pulse(self, before):
        # Small real gestures return toward the frozen World position. Never
        # leave movement held during a state read, screenshot or monitor wait.
        position = before['player']['position']
        dx, dz = self.origin[0] - position[0], self.origin[2] - position[2]
        distance = math.hypot(dx, dz)
        if distance < 0.15:
            dx, dz, distance = 0, -1, 1
        yaw = before['player']['camera']['yaw']
        horizontal = (dx * math.cos(yaw) + dz * math.sin(yaw)) / distance
        vertical = (dx * math.sin(yaw) - dz * math.cos(yaw)) / distance
        x, y = round(112 + 7 * horizontal), round(283 - 7 * vertical)
        started = time.monotonic()
        try:
            self.touch('touchstart', x, y)
        finally:
            self.release()
        elapsed = (time.monotonic() - started) * 1000
        if elapsed > 4000:
            raise ToolFailure('movement-contact-envelope-exceeded-4000ms')
        after = self.state('movement-pulse-released')
        if not player_neutral(after):
            raise ToolFailure('movement-pulse-did-not-release')
        self.report.setdefault('movementPulses', []).append({
            'before': before, 'after': after, 'contactEnvelopeMs': elapsed})
        return after

    def headroom(self, name, duration=15):
        target = self.out / (name + '.json')
        result = subprocess.run([sys.executable, str(SCRIPTS / 'mac_headroom.py'), '--config',
                                 str(self.args.config), '--duration', str(duration), '--out', str(target)],
                                capture_output=True, text=True, timeout=duration + 50, check=False)
        (self.out / (name + '.stderr')).write_text(result.stderr)
        if result.returncode:
            raise ToolFailure(name + '-observation-failed')
        return json.loads(target.read_text())

    def windows(self, kind):
        target = self.out / (kind + '-headroom.json')
        with (self.out / (kind + '-monitor.stdout')).open('x') as stdout, \
                (self.out / (kind + '-monitor.stderr')).open('x') as stderr:
            monitor = subprocess.Popen([sys.executable, str(SCRIPTS / 'mac_headroom.py'), '--config',
                str(self.args.config), '--duration', '55', '--out', str(target)],
                stdout=stdout, stderr=stderr, start_new_session=True)
            samples = []
            try:
                time.sleep(1)
                for index in range(3):
                    start = self.state(f'{kind}-{index}-start')
                    operation_start = len(self.report['operations'])
                    deadline = time.monotonic() + 10
                    step = 0
                    current = start
                    while time.monotonic() < deadline:
                        if kind == 'move-changing':
                            current = self.movement_pulse(current)
                        elif kind == 'look-changing':
                            self.touch('touchmove', 670 + (12 if step % 2 else -12), 210)
                        elif kind == 'editor-toggle':
                            self.touch('tap', 666, 80)
                        else:
                            time.sleep(max(0, deadline - time.monotonic()))
                        step += 1
                    end = self.state(f'{kind}-{index}-end')
                    sample = {'kind': kind, 'index': index, **sample_delta(start, end),
                              'nativeOperationCount': len(self.report['operations']) - operation_start}
                    sample['nativeOperationsPerSecond'] = sample['nativeOperationCount'] * 1000 / sample['elapsedMs']
                    samples.append(sample)
                    self.report['samples'].append(sample)
                    print(json.dumps({k: v for k, v in sample.items() if k not in ('start', 'end')}), flush=True)
            finally:
                operation_failed = sys.exc_info()[0] is not None
                monitor_failure = None
                # Stop gameplay immediately, including while waiting for the
                # already-running resource collector's final samples.
                try:
                    self.release()
                except BaseException as error:
                    self.report['releaseFailure'] = str(error) or type(error).__name__
                try:
                    code = monitor.wait(timeout=55)
                except subprocess.TimeoutExpired:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(monitor.pid, signal.SIGTERM)
                    try:
                        monitor.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        with contextlib.suppress(ProcessLookupError):
                            os.killpg(monitor.pid, signal.SIGKILL)
                        monitor.wait(timeout=5)
                    code, monitor_failure = None, kind + '-monitor-deadline'
                if code != 0 and monitor_failure is None:
                    monitor_failure = kind + '-monitor-failed'
                if monitor_failure:
                    self.report.setdefault('monitorFailures', []).append(monitor_failure)
                    if not operation_failed:
                        raise ToolFailure(monitor_failure)
                if self.report.get('releaseFailure') and not operation_failed:
                    raise ToolFailure('native-contact-release-failed')
        facts = headroom_facts(json.loads(target.read_text()))
        lower, upper = facts['windowUtcMs']
        covered = all(lower <= x['start']['utcMs'] <= x['end']['utcMs'] <= upper for x in samples)
        self.report.setdefault('headroomDuring', {})[kind] = {'facts': facts, 'coversEverySample': covered}
        if not covered:
            raise ToolFailure(kind + '-monitor-did-not-cover-samples')
        if not facts['normalPressure'] or any(facts['pagingDelta'].values()) or not facts['noRecordedThermalWarning']:
            raise ToolFailure(kind + '-resource-pressure-during-sample')
        return samples

    def interactions(self):
        initial = self.state('before-move')
        if not player_neutral(initial):
            raise ToolFailure('game-controls-not-neutral-before-run')
        try:
            self.windows('move-changing')
        finally:
            self.release()
        released = self.state('after-move-release')
        positions = [row['after']['player']['position'] for row in self.report.get('movementPulses', [])]
        origin = initial['player']['position']
        distance = max((math.hypot(p[0] - origin[0], p[2] - origin[2]) for p in positions), default=0)
        if not player_neutral(released):
            raise ToolFailure('joystick-operation-not-observed')
        if distance < 0.01:
            raise ToolFailure('joystick-did-not-move-world-player')
        self.report['observedMovementDistance'] = distance
        self.report['moveRelease'] = released
        self.call('move-screen', 'simulator_screenshot', '--project', self.args.project)
        before_look = self.state('before-look')
        self.touch('touchstart', 670, 210)
        try:
            looked = self.windows('look-changing')
        finally:
            self.release()
        after_look = self.state('after-look-release')
        angles = [s['player']['camera']['yaw'] for row in looked for s in (row['start'], row['end'])]
        if max(angles) - min(angles) < 0.001 or not player_neutral(after_look):
            raise ToolFailure('look-operation-not-observed')
        self.report['lookRelease'] = after_look
        self.report['beforeLook'] = before_look
        self.call('look-screen', 'simulator_screenshot', '--project', self.args.project)
        editor = self.windows('editor-toggle')
        if not all(player_neutral(s) for row in editor for s in (row['start'], row['end'])):
            raise ToolFailure('editor-operation-leaked-game-input')
        # Keep the final form visible for review outside the measured windows.
        if sum(x['nativeOperationCount'] for x in editor) % 2 == 0:
            self.touch('tap', 666, 80)
        self.call('editor-screen', 'simulator_screenshot', '--project', self.args.project)
        self.touch('tap', 666, 80)

    def close(self):
        if not self.report.get('windowOwned'):
            return
        try:
            self.release()
        except BaseException as error:
            self.report['releaseFailure'] = str(error)
        projects = self.call('close-selector', 'project_list', '--scope', 'all')['projects']
        selected = [x['projectPath'] for x in projects
                    if x['projectPath'].rstrip('/').casefold() == self.args.project.rstrip('/').casefold()]
        if len(selected) > 1:
            raise ToolFailure('owned-project-selector-ambiguous')
        self.report['close'] = self.call('close', 'close_project_window', '--project',
                                        selected[0] if selected else self.args.project)
        if self.report['close'].get('winId') != self.report['open']['winId']:
            raise ToolFailure('close-acknowledgement-window-mismatch')

    def run(self):
        try:
            status = self.call('status', 'check_wechatide_status', '--skill-version', self.args.skill_version)
            self.report['toolStatus'] = {key: status.get(key) for key in (
                'skillVersion', 'versionRelation', 'loginExpired', 'cliTokenRequired')}
            if status.get('loginExpired') is not False or status.get('versionRelation') not in ('equal', 'agent_ahead'):
                raise ToolFailure('official-tool-environment-not-ready')
            before = (json.loads(self.args.headroom_before.read_text()) if self.args.headroom_before
                      else self.headroom('headroom-before'))
            qualification = qualify_headroom(before, self.args.minimum_cpu_idle, self.args.maximum_background_gpu)
            self.report['headroomBefore'] = qualification
            if not qualification['qualified']:
                raise ToolFailure('host-capacity-not-qualified: ' + ', '.join(qualification['reasons']))
            self.report['publicationBefore'] = self.publication()
            self.report['open'] = self.call('open', 'open_project_window', '--project', self.args.project)
            opened = self.report['open']
            self.report['windowOwned'] = opened.get('type') == 'newopen' and isinstance(opened.get('winId'), str)
            if not self.report['windowOwned']:
                raise ToolFailure('project-window-already-existed; preserve its owner')
            with contextlib.redirect_stdout(io.StringIO()):
                ready = observe(self.config, self.args.project, self.out / 'ready', 120)
            self.report['ready'] = ready
            if ready['readyFramesPassed'] is not True:
                raise ToolFailure('original-120-second-60-presented-frame-gate-failed')
            if self.args.interaction:
                screen = ready['screenshot']['result']
                if (screen['imageWidth'], screen['imageHeight']) != (794, 368):
                    raise ToolFailure('game-3d-input-map-needs-calibration; screenshot extent changed')
            initial = self.state('initial')
            self.report['capabilities'] = initial['capabilities']
            self.report['display'] = {'canvas': initial['canvas'], 'window': initial.get('display')}
            if self.args.interaction and (initial['canvas'] != {'width': 2532, 'height': 1170}
                                         or initial.get('display', {}).get('pixelRatio') != 3):
                raise ToolFailure('game-3d-framebuffer-extent-changed')
            self.windows('idle')
            if self.args.interaction:
                self.interactions()
            self.report['publicationAfter'] = self.publication()
            self.call('final-screen', 'simulator_screenshot', '--project', self.args.project)
            self.report['samplesPassed'] = True
            self.report['completedThroughputAtLeast30'] = all(s['completedFps'] >= 30 for s in self.report['samples'])
        except BaseException as error:
            self.report['failure'] = str(error) or type(error).__name__
        finally:
            try:
                self.close()
            except BaseException as error:
                self.report['closeFailure'] = str(error)
            if self.report.get('close'):
                try:
                    self.report['headroomAfter'] = headroom_facts(self.headroom('headroom-after'))
                except BaseException as error:
                    self.report['afterObservationFailure'] = str(error)
            self.report['success'] = self.report.get('samplesPassed') is True and not any(
                self.report.get(k) for k in ('failure', 'closeFailure', 'releaseFailure', 'afterObservationFailure'))
            result = self.out / 'result.json'
            result.write_text(json.dumps(self.report, indent=2) + '\n')
            result.chmod(0o600)
            print(json.dumps({'success': self.report['success'], 'failure': self.report.get('failure'),
                              'closed': 'close' in self.report, 'result': str(result.resolve())}), flush=True)
        return self.report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--skill-version', default='0.3.11', help='version from the installed official skill')
    parser.add_argument('--project', required=True)
    parser.add_argument('--manifest-sha', required=True)
    parser.add_argument('--publication', type=Path, help='untouched local publication, needed to admit additive IDE config metadata')
    parser.add_argument('--headroom-before', type=Path, help='fresh collector JSON; otherwise capture and qualify it automatically')
    parser.add_argument('--minimum-cpu-idle', type=float, default=40)
    parser.add_argument('--maximum-background-gpu', type=float, default=50)
    parser.add_argument('--interaction', choices=['game-3d'], help='qualified 794x368 / 2532x1170 ordinary game controls')
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    if not Path(args.project).is_absolute() or not re.fullmatch(r'[0-9a-f]{64}', args.manifest_sha):
        parser.error('project must be absolute and manifest-sha a lowercase SHA-256')
    if not 0 <= args.minimum_cpu_idle <= 100 or not 0 <= args.maximum_background_gpu <= 100:
        parser.error('headroom policy percentages must be within 0..100')
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        return 0 if Measurement(args).run()['success'] else 1
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == '__main__':
    raise SystemExit(main())
