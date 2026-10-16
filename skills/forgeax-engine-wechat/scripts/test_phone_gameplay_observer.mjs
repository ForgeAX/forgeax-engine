import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createGameplayObserver } from './fixtures/gameplay-benchmark/observer.mjs';
import { collectPhoneGameplayQualification } from './phone_gameplay_qualification.mjs';

const source = (await readFile(new URL('./phone_gameplay_observer.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export function', 'function');
const transportSource = (
  await readFile(new URL('./phone_gameplay_transport.mjs', import.meta.url), 'utf8')
)
  .replace(/^import .*;\n/gm, '')
  .replace('export function', 'function');

const socketSource = (
  await readFile(new URL('./phone_gameplay_socket.mjs', import.meta.url), 'utf8')
).replace('export function', 'function');

async function exercise({
  retry = false,
  connectFailure = false,
  rejectArmed = false,
  mode = 'timed',
} = {}) {
  let time = 0,
    nextTimer = 0,
    frameId = 0,
    arm,
    report,
    paused = false,
    connectCount = 0;
  const diagnosticCalls = [],
    profiler = {};
  const diagnostics =
    mode === 'cpu'
      ? {
          cpu: {
            profiler,
            start() {
              diagnosticCalls.push(['start', time]);
              return { ok: true, value: {} };
            },
            stop() {
              assert.equal(paused, true);
              diagnosticCalls.push(['stop', time]);
            },
            read() {
              assert.equal(paused, true);
              return {
                capture: {
                  records: [
                    {
                      kind: 'phase',
                      source: 'app',
                      phase: 'frame-total',
                      startMicros: (arm.startMs + 10) * 1000,
                      endMicros: (arm.startMs + 20) * 1000,
                    },
                  ],
                },
              };
            },
          },
        }
      : mode === 'gpu'
        ? {
            gpu: {
              wrapHost: (value) => value,
              start() {
                diagnosticCalls.push(['start', time]);
              },
              stop() {
                diagnosticCalls.push(['stop', time]);
              },
              async collect() {
                assert.equal(paused, true);
                diagnosticCalls.push(['collect', time]);
              },
              dispose() {
                assert.equal(paused, true);
                diagnosticCalls.push(['dispose', time]);
                return { cleanup: { status: 'complete' } };
              },
            },
          }
        : mode === 'qualification'
          ? { qualify: collectPhoneGameplayQualification }
          : {};
  const timers = new Map(),
    stages = [],
    reads = [],
    callbacks = [];
  const schedule = (fn, ms) => {
    const id = ++nextTimer;
    timers.set(id, { at: time + ms, fn });
    return id;
  };
  const cancel = (id) => timers.delete(id);
  const result = (value) => ({ ok: true, value, unwrap: () => value });
  const platform = {
    now: () => result(time),
    visible: () => true,
    subscribe: () => result(() => {}),
    display: () =>
      result({ width: 800, height: 360, pixelRatio: 4, drawingWidth: 3200, drawingHeight: 1440 }),
  };
  const native = {
    setEnableDebug() {
      assert.fail('Capture must never toggle native debug');
    },
    getAppBaseInfo: () => ({ enableDebug: true, SDKVersion: 'contract' }),
    getWindowInfo: () => ({ windowWidth: 800, windowHeight: 360, pixelRatio: 4 }),
    connectSocket(options) {
      let onMessage, onClose, onError;
      const failConnect = connectFailure && connectCount++ === 0;
      options.success({ errMsg: 'connectSocket:ok' });
      return {
        onOpen(callback) {
          schedule(() => {
            if (failConnect) {
              onError({ errMsg: 'connectSocket:fail connection refused' });
              onClose({ code: 1006 });
            } else callback({});
          }, 0);
        },
        onError(callback) {
          onError = callback;
        },
        onClose(callback) {
          onClose = callback;
        },
        onMessage(callback) {
          onMessage = callback;
        },
        close(options) {
          options.success({});
          onClose({ code: 1000 });
        },
        send(options) {
          const message = JSON.parse(options.data),
            stage = message.stage;
          stages.push({ stage, at: time });
          if (arm && !rejectArmed)
            assert.ok(time < arm.startMs || time >= arm.endMs, 'No timed network');
          if (retry && stage === 'ready') {
            options.fail({ errMsg: 'original socket send failure' });
            return;
          }
          let response;
          if (stage === 'ready') {
            assert.equal(message.debug.policy, 'unchanged');
            assert.equal(message.debug.before.appBaseInfo.enableDebug, true);
            response = {
              action: 'arm',
              delayMs: 2000,
              durationMs: 4000,
              maxEvents: 65536,
              phases: ['walk', 'run', 'jump', 'run-jump'].map((name, i) => ({
                name,
                startMs: i * 1000,
                endMs: (i + 1) * 1000,
              })),
            };
          } else if (stage === 'armed') {
            arm = message.arm;
            response = rejectArmed
              ? { action: 'rejected' }
              : { action: 'accepted', synchronization: { uncertaintyMs: 1 } };
          } else if (stage === 'release')
            response = { action: 'released', input: { releaseStatus: 'up-messages-dispatched' } };
          else throw Error('Unexpected control stage');
          options.success({});
          onMessage({
            data: JSON.stringify({
              ...response,
              kind: message.kind,
              source: message.source,
              runId: message.runId,
              stage,
            }),
          });
        },
      };
    },
  };

  const renderer = { inspect: () => ({ frame: { pendingCompletionCount: 0 } }) };
  const inspection = {
    renderer: () => ({ phase: 'ready' }),
    async read(id) {
      reads.push(time);
      if (!rejectArmed && arm && mode !== 'qualification')
        assert.ok(time < arm.startMs || time >= arm.endMs, 'No timed inspection');
      return id === 'game-3d.player'
        ? {
            position: [0, 1, 0],
            grounded: true,
            controls: { horizontal: 0, vertical: 0, run: false },
            camera: { yaw: time / 1000 },
          }
        : { vertexCount: 12, busy: false };
    },
    ui: () => ({ ok: true, value: { truncated: false, nodes: [] } }),
  };
  const context = vm.createContext({
    createGameplayObserver: () => createGameplayObserver({ schedule, cancel }),
    setTimeout: schedule,
    clearTimeout: cancel,
    Date: { now: () => time },
    console,
    persistPhoneReport(_wx, value, label) {
      if (label === 'gameplay') report = structuredClone(value);
      return { body: JSON.stringify(value) };
    },
    sendPhoneReport(_wx, options, value) {
      assert.ok(options.reportUrl.endsWith('/report'));
      value.transfer = { status: 'sent' };
    },
    __forgeaxGameInspection: inspection,
  });
  vm.runInContext(
    `(() => { ${socketSource}; globalThis.createPhoneGameplaySocket = createPhoneGameplaySocket; })()`,
    context,
  );
  vm.runInContext(`${transportSource}\n${source}`, context);
  const observed = context.createPhoneGameplayObserver(
    {
      controlUrl: 'http://127.0.0.1:12345/contract',
      runId: 'offline_contract_20261013',
      source: { manifestSha256: 'a'.repeat(64) },
      mode,
    },
    native,
    undefined,
    diagnostics,
  );
  const options = observed.observeOptions(
    {
      platform,
      world: { identity: 3 },
      renderer,
      onFrameSubmitted: () => callbacks.push('submitted'),
      onFrameCompleted: () => callbacks.push('completed'),
    },
    1,
  );
  if (mode === 'cpu') {
    assert.equal(options.profiler, profiler);
    assert.equal(observed.rendererOptions({}).profiler, profiler);
  }
  function frame() {
    const receipt = { frameId: ++frameId, completed: Promise.resolve(result({})) };
    const detail = {
      frameId,
      receipt,
      worldIdentity: 3,
      deviceGeneration: 2,
      presentation: 'ready',
    };
    options.onFrameSubmitted(detail);
    options.onFrameCompleted(detail);
  }
  for (let i = 0; i < 60; i++) frame();
  observed.bindApp({
    onError() {},
    pause() {
      paused = true;
      return result();
    },
    start() {
      throw Error('Controller must not replace or restart App loop');
    },
  });
  for (let step = 0; step < 450 && !report; step++) {
    for (let i = 0; i < 15; i++) await Promise.resolve();
    time += 20;
    for (const [id, timer] of [...timers])
      if (timer.at <= time) {
        timers.delete(id);
        timer.fn();
      }
    if (!paused) frame();
  }
  assert.ok(report, 'Controller must terminate within its bounded window');
  assert.equal(callbacks[0], 'submitted');
  assert.equal(callbacks[1], 'completed');
  return { report, arm, stages, reads, paused, diagnosticCalls };
}

test('phone controller reuses actual observer, original callbacks and post-window receipt drain', async () => {
  const { report, arm, stages, paused } = await exercise();
  assert.equal(report.status, 'complete');
  assert.equal(report.debug.policy, 'unchanged');
  assert.equal(report.debug.before.appBaseInfo.enableDebug, true);
  assert.equal(report.debug.after.appBaseInfo.enableDebug, true);
  assert.equal(report.cleanFpsEvidence, false);
  assert.deepEqual(report.debugReceipts, []);
  assert.equal(report.capture.schemaVersion, 'forgeax-gameplay-capture/1');
  assert.ok(report.capture.events.length > 300);
  assert.equal(report.capture.drain.lastSubmittedFrame, report.capture.drain.lastCompletedFrame);
  assert.ok(stages.find((row) => row.stage === 'release').at >= arm.endMs);
  assert.equal(paused, true);
});

test('receiver may start after preview; closed connection failures retry before one readiness', async () => {
  const { report, stages } = await exercise({ connectFailure: true });
  assert.equal(report.status, 'complete');
  assert.equal(stages.filter((row) => row.stage === 'ready').length, 1);
  assert.equal(stages.filter((row) => row.stage === 'armed').length, 1);
  assert.match(report.connection.firstNativeError.native.errMsg, /connection refused/);
  assert.deepEqual(report.debugReceipts, []);
});

test('ambiguous socket send failure is retained and never rearms the observer', async () => {
  const { report, stages } = await exercise({ retry: true });
  assert.equal(report.status, 'partial');
  assert.equal(stages.filter((row) => row.stage === 'ready').length, 1);
  assert.equal(stages.filter((row) => row.stage === 'armed').length, 0);
  assert.match(report.failure, /original socket send failure/);
});

test('rejected synchronization preserves partial events and requests native release before drain', async () => {
  const { report, stages, paused } = await exercise({ rejectArmed: true });
  assert.equal(report.status, 'partial');
  assert.match(report.failure, /Socket response identity/);
  assert.equal(report.capture.failure, 'interrupted');
  assert.equal(stages.at(-1).stage, 'release');
  assert.equal(paused, true);
});

test('CPU mode shares one instance and reports actual phase coverage after App drain', async () => {
  const { report, arm, diagnosticCalls } = await exercise({ mode: 'cpu' });
  assert.equal(report.diagnostic, 'cpu');
  assert.equal(report.cleanFpsEvidence, false);
  assert.ok(diagnosticCalls[0][1] >= arm.startMs);
  assert.equal(report.diagnosticWindow.phases[0].name, 'walk');
  assert.equal(report.diagnosticWindow.phases[0].framesStarted, 1);
  assert.equal(report.diagnosticWindow.phases[1].framesStarted, 0);
});

test('GPU queries bracket only the short diagnostic and collect after original receipt drain', async () => {
  const { report, arm, diagnosticCalls } = await exercise({ mode: 'gpu' });
  assert.equal(report.diagnostic, 'gpu');
  assert.ok(diagnosticCalls[0][1] >= arm.startMs);
  assert.deepEqual(
    diagnosticCalls.slice(-2).map((row) => row[0]),
    ['collect', 'dispose'],
  );
  assert.equal(report.gpu.cleanup.status, 'complete');
});

test('only explicit qualification samples the timed public player and refuses inert actions', async () => {
  const { report, paused } = await exercise({ mode: 'qualification' });
  assert.equal(report.diagnostic, 'qualification');
  assert.equal(report.status, 'partial');
  assert.equal(report.failure, 'input-qualification-failed');
  assert.ok(report.inputQualification.samples.length > 10);
  assert.equal(report.inputQualification.evidence.walking, false);
  assert.equal(paused, true);
});
