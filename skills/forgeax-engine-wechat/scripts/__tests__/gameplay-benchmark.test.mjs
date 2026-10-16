import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeGameplay, rollingMinimum } from '../analyze_gameplay_performance.mjs';
import { createGameplayObserver } from '../fixtures/gameplay-benchmark/observer.mjs';
import {
  createGameplayTimeline,
  validateTimeline,
} from '../fixtures/gameplay-benchmark/timeline.mjs';

const geometry = {
  move: { x: 10, y: 200, width: 120, height: 120 },
  look: { x: 200, y: 50, width: 320, height: 200 },
  run: { x: 600, y: 250, width: 50, height: 50 },
  jump: { x: 700, y: 250, width: 50, height: 50 },
};
const timeline = () =>
  createGameplayTimeline({
    geometry,
    coordinateSpace: { unit: 'css-px', width: 844, height: 390 },
    phaseMs: 1000,
  });
const ok = (value) => ({ ok: true, value, unwrap: () => value });

test('buttonPoints choose real rect interiors without changing movement, look or default centers', () => {
  const options = {
    geometry,
    coordinateSpace: { unit: 'css-px', width: 844, height: 390 },
    phaseMs: 1000,
  };
  const before = structuredClone(geometry);
  const original = createGameplayTimeline(options);
  const buttonPoints = { run: { u: 0.25, v: 0.75 }, jump: { u: 0.5, v: 0.85 } };
  const selected = createGameplayTimeline({ ...options, buttonPoints });
  assert.deepEqual(selected.buttonPoints, buttonPoints);
  assert.deepEqual(geometry, before);
  for (const [index, event] of selected.events.entries()) {
    assert.equal(event.atMs, original.events[index].atMs);
    for (const contact of event.contacts) {
      if (buttonPoints[contact.role]) {
        const rect = geometry[contact.role],
          point = buttonPoints[contact.role];
        assert.equal(contact.x, rect.x + rect.width * point.u);
        assert.equal(contact.y, rect.y + rect.height * point.v);
      } else
        assert.deepEqual(
          contact,
          original.events[index].contacts.find((row) => row.id === contact.id),
        );
    }
  }
  assert.deepEqual(
    original.events,
    createGameplayTimeline({
      ...options,
      buttonPoints: { run: { u: 0.5, v: 0.5 }, jump: { u: 0.5, v: 0.5 } },
    }).events,
  );
  assert.deepEqual(
    createGameplayTimeline({ ...options, buttonPoints: { jump: { u: 0.5, v: 0.85 } } }).buttonPoints
      .run,
    { u: 0.5, v: 0.5 },
  );
});

test('buttonPoints reject invalid roles, noninterior coordinates and device rounding onto a real rect edge', () => {
  const options = {
    geometry,
    coordinateSpace: { unit: 'device-px', width: 844, height: 390 },
    phaseMs: 1000,
  };
  for (const buttonPoints of [
    null,
    [],
    { look: { u: 0.5, v: 0.5 } },
    { jump: null },
    { jump: { u: 0.5, v: 0 } },
    { jump: { u: 1, v: 0.5 } },
    { jump: { u: '0.5', v: 0.5 } },
    { jump: { u: NaN, v: 0.5 } },
    { jump: { u: 0.5, v: 0.5, x: 1 } },
    { jump: { u: 0.9999, v: 0.85 } },
  ])
    assert.throws(() => createGameplayTimeline({ ...options, buttonPoints }), /button.*point/i);
});

function harness() {
  let time = 0,
    visible = true,
    callback,
    paused = false;
  let originalSubmitted = 0,
    originalCompleted = 0;
  const platform = { now: () => ok(time), visible: () => visible, subscribe: () => ok(() => {}) };
  const observer = createGameplayObserver({
    schedule: (fn) => {
      callback = fn;
      return 1;
    },
    cancel: () => {},
  });
  const options = observer.observeOptions(
    {
      platform,
      renderer: {
        inspect() {
          assert.ok(paused);
          return { frame: { pendingCompletionCount: 0 } };
        },
      },
      world: { identity: 'world-A' },
      onFrameSubmitted: () => originalSubmitted++,
      onFrameCompleted: () => originalCompleted++,
    },
    7,
  );
  observer.bindApp({
    onError() {},
    pause: () => {
      paused = true;
      return ok();
    },
  });
  function event(frameId, extra = {}) {
    const detail = {
      frameId,
      deviceGeneration: 2,
      worldIdentity: 'world-A',
      presentation: 'ready',
      ...extra,
    };
    detail.receipt = { frameId, completed: Promise.resolve(ok()) };
    options.onFrameSubmitted(detail);
    options.onFrameCompleted(detail);
  }
  for (let frame = 0; frame < 60; frame++) event(frame);
  return {
    observer,
    event,
    time: (value) => {
      time = value;
    },
    hide: () => {
      visible = false;
    },
    end: () => callback(),
    originals: () => [originalSubmitted, originalCompleted],
  };
}

test('four semantic phases keep stable contacts and truthful final release', () => {
  const value = timeline();
  assert.equal(value.durationMs, 4000);
  assert.equal(value.events.at(-1).contacts.length, 0);
  const roles = (at) =>
    value.events
      .find((event) => Math.abs(event.atMs - at) < 1e-7)
      .contacts.map((contact) => contact.role);
  assert.deepEqual(roles(0), ['move', 'look']);
  assert.deepEqual(roles(1050), ['move', 'look', 'run']);
  assert.deepEqual(roles(2200), ['look', 'jump']);
  assert.deepEqual(roles(3200), ['move', 'look', 'run', 'jump']);
  assert.throws(() => validateTimeline({ ...value, events: value.events.slice(0, -1) }), /release/);
  assert.throws(
    () =>
      validateTimeline({
        ...value,
        events: [value.events[0], value.events[0], ...value.events.slice(1)],
      }),
    /ordering/,
  );
  const device = createGameplayTimeline({
    geometry,
    coordinateSpace: { unit: 'device-px', width: 844, height: 390 },
    phaseMs: 1000,
  });
  assert.ok(
    device.events.every((event) =>
      event.contacts.every((contact) => Number.isInteger(contact.x) && Number.isInteger(contact.y)),
    ),
  );
});

test('forty-second shuttle bounds directed hold time without weakening movement', () => {
  const value = createGameplayTimeline({
    geometry,
    coordinateSpace: { unit: 'css-px', width: 844, height: 390 },
  });
  assert.equal(value.workload, 'shuttle-250ms/1');
  const centerY = geometry.move.y + geometry.move.height / 2;
  let directedMs = 0;
  let movingMs = 0;
  let runningMs = 0;
  for (let index = 0; index < value.events.length - 1; index++) {
    const event = value.events[index];
    const dt = value.events[index + 1].atMs - event.atMs;
    const move = event.contacts.find((contact) => contact.role === 'move');
    if (move) {
      assert.ok(Math.abs(centerY - move.y) >= geometry.move.height * 0.3 - 1e-7);
      movingMs += dt;
      if (event.contacts.some((contact) => contact.role === 'run')) runningMs += dt;
      directedMs += Math.sign(centerY - move.y) * dt;
      assert.ok(Math.abs(directedMs) <= 250 + 1e-7, `unbounded directed hold at ${event.atMs}`);
    }
    if (value.phases.some((phase) => phase.endMs === value.events[index + 1].atMs))
      assert.ok(Math.abs(directedMs) < 1e-7, 'Complete phases return directed input to zero');
  }
  assert.ok(Math.abs(movingMs - 30000) < 1e-7);
  assert.ok(Math.abs(runningMs - 20000) < 1e-7);
  // This checks the generated input's area, not actual collision or landing.
  // Runtime position and grounded witnesses remain hardware-run requirements.
});

test('observer retains original callbacks and times only matching ready completions', async () => {
  const h = harness(),
    t = timeline();
  const arm = h.observer.arm({ ...t, delayMs: 100 });
  assert.equal(arm.startMs, 100);
  h.time(99);
  h.event(60);
  h.time(110);
  h.event(61);
  assert.throws(() => h.observer.status(), /No inspection/);
  h.time(120);
  h.event(62);
  await assert.rejects(h.observer.drain(), /after timed/);
  h.time(4100);
  h.end();
  const report = await h.observer.drain();
  assert.equal(report.status, 'complete');
  assert.deepEqual(
    report.events.map((row) => row.atMs),
    [110, 110, 120, 120],
  );
  assert.deepEqual(h.originals(), [63, 63]);
});

for (const [name, action, expected] of [
  ['identity', (h) => h.event(60, { worldIdentity: 'other' }), 'identity-mismatch'],
  ['not ready', (h) => h.event(60, { presentation: 'pending' }), 'non-ready-completion'],
  [
    'hidden',
    (h) => {
      h.hide();
      h.event(60);
    },
    'hidden',
  ],
  [
    'clock reset',
    (h) => {
      h.event(60);
      h.time(105);
      h.event(61);
    },
    'invalid-clock',
  ],
])
  test(`observer fails closed on ${name}`, async () => {
    const h = harness();
    h.observer.arm({ ...timeline(), delayMs: 100 });
    h.time(110);
    action(h);
    h.time(4100);
    h.end();
    const report = await h.observer.drain();
    assert.equal(report.status, 'partial');
    assert.equal(report.failure, expected);
  });

test('overflow is partial even when the drain succeeds', async () => {
  const h = harness();
  h.observer.arm({ ...timeline(), delayMs: 100, maxEvents: 1 });
  h.time(110);
  h.event(60);
  h.time(4100);
  h.end();
  const report = await h.observer.drain();
  assert.equal(report.failure, 'overflow');
  assert.equal(report.events.length, 1);
});

test('window denominator and stalls cannot be hidden by percentile-only analysis', () => {
  const value = {
    schemaVersion: 'forgeax-gameplay-capture/1',
    status: 'complete',
    startMs: 0,
    endMs: 4000,
    phases: timeline().phases,
    drain: { success: true, lastSubmittedFrame: 3, lastCompletedFrame: 3 },
    events: [10, 1010, 2010, 3010].map((atMs, frameId) => ({ atMs, frameId, kind: 'completed' })),
  };
  const result = analyzeGameplay(value);
  assert.equal(result.all.fps, 1);
  assert.equal(result.all.intervalMs.p95, 1000);
  assert.equal(result.all.over33_333Ms, 3);
  assert.equal(result.target.strictMeanReachedInEveryPhase, false);
  assert.equal(result.all.actualDroppedPresentationFrames, null);
  assert.equal(rollingMinimum([1, 2, 1500, 2500], 0, 4000), 0);
  const duplicate = { ...value, events: [value.events[0], ...value.events] };
  assert.equal(analyzeGameplay(duplicate).status, 'partial');
});

test('rolling counts are invariant under an epoch clock origin and preserve both half-open edges', () => {
  for (const origin of [0, 1_700_000_000_000]) {
    assert.equal(rollingMinimum([origin, origin + 1001], origin, origin + 2000), 0);
    assert.equal(
      rollingMinimum([origin, origin, origin + 1000, origin + 1000], origin, origin + 2000),
      2,
      'When the left-edge pair leaves, the exact right-edge pair enters',
    );
    assert.equal(
      rollingMinimum([origin, origin, origin + 1000], origin, origin + 1000),
      2,
      'A phase exactly one second long has only its original half-open window',
    );
  }
  assert.equal(
    rollingMinimum([0, 1000 + 2 ** -30], 0, 1000 + 2 ** -30),
    0,
    'A representable gap smaller than a fixed epsilon still contains an empty window',
  );
});

test('recovered GPU03 completion timestamps keep their minimum through the phone report analysis path', () => {
  // Only relative completion times from the recovered report are retained.
  // Original SHA256: 978205b5d409f8b50cb262e50599a4d68eeed3f8f667c7df6ff50ddf0898c1f5
  const offsets = [
    30.780029296875, 57.891845703125, 106.60595703125, 136.0498046875, 160.5439453125,
    211.615966796875, 229.81982421875, 257.447998046875, 309.886962890625, 330.079833984375,
    358.466796875, 412.447998046875, 434.491943359375, 476.885009765625, 515.61083984375,
    558.885009765625, 595.884033203125, 648.039794921875, 689.10693359375, 719.030029296875,
    758.73095703125, 814.9228515625, 852.48095703125, 887.11083984375, 928.805908203125,
    981.096923828125, 1021.469970703125, 1060.808837890625, 1105.156005859375, 1142.9990234375,
    1184.94189453125, 1216.557861328125, 1252.7998046875, 1288.141845703125, 1322.641845703125,
    1360.037841796875, 1403.4580078125, 1439.85888671875, 1489.798828125, 1513.291015625,
    1560.02001953125, 1594.69091796875, 1628.376953125, 1657.351806640625, 1705.996826171875,
    1731.594970703125, 1771.914794921875, 1792.995849609375, 1845.031005859375, 1868.474853515625,
    1911.156005859375, 1951.097900390625, 1993.745849609375, 2034.14599609375, 2072.723876953125,
    2121.594970703125, 2144.685791015625, 2180.10888671875, 2220.263916015625, 2254.385986328125,
    2301.115966796875, 2325.724853515625, 2368.072021484375, 2406.887939453125, 2449.2109375,
    2486.512939453125, 2541.5068359375, 2561.282958984375, 2612.005859375, 2653.892822265625,
    2692.8330078125, 2728.7119140625, 2771.52099609375, 2813.876953125, 2855.435791015625,
    2885.2958984375, 2924.81298828125, 2965.916015625, 3003.572021484375, 3036.284912109375,
    3089.208984375, 3125.447021484375, 3161.011962890625, 3198.31298828125, 3239.3818359375,
    3280.65283203125, 3320.868896484375, 3344.86279296875, 3394.035888671875, 3436.281005859375,
    3477.5830078125, 3510.08203125, 3547.52880859375, 3595.15283203125, 3627.703857421875,
    3663.7919921875, 3703.579833984375, 3745.291015625, 3790.455810546875, 3819.77587890625,
    3863.120849609375, 3888.9658203125, 3923.161865234375, 3960.476806640625, 3993.538818359375,
  ];
  for (const startMs of [0, 1_700_000_000_000]) {
    const result = analyzeGameplay({
      diagnostic: 'stationary-gpu',
      failure: 'GPU timing unavailable or incomplete: timer-extension-unavailable',
      capture: {
        schemaVersion: 'forgeax-gameplay-capture/1',
        status: 'complete',
        startMs,
        endMs: startMs + 4000,
        phases: [{ name: 'stationary', startMs: 0, endMs: 4000 }],
        events: offsets.map((offset, frameId) => ({
          atMs: startMs + offset,
          frameId,
          kind: 'completed',
          phase: 0,
        })),
        drain: { success: true, lastSubmittedFrame: 104, lastCompletedFrame: 104 },
      },
    });
    assert.equal(result.all.completed, 105);
    assert.equal(result.all.fps, 26.25);
    assert.equal(result.all.rollingOneSecondMinimum, 24);
    assert.equal(result.target.strict60Cadence.met, false);
  }
});

test('CDP adds and releases individual contacts without dropping retained fingers', async () => {
  const { createCdpContacts } = await import('../run_gameplay_benchmark.mjs');
  const calls = [],
    dispatch = createCdpContacts({
      send: async (method, params) => calls.push({ method, ...params }),
    });
  const move = { id: 1, role: 'move', x: 20, y: 30 },
    look = { id: 2, role: 'look', x: 200, y: 100 },
    jump = { id: 4, role: 'jump', x: 700, y: 300 };
  await dispatch([move, look]);
  await dispatch([move, { ...look, x: 210 }, jump]);
  await dispatch([move, { ...look, x: 210 }]);
  await dispatch([]);
  assert.deepEqual(
    calls.map((call) => [call.type, call.touchPoints.map((point) => point.id)]),
    [
      ['touchStart', [1, 2]],
      ['touchStart', [1, 2, 4]],
      ['touchMove', [1, 2, 4]],
      ['touchEnd', [4]],
      ['touchEnd', []],
    ],
  );
});

test('input backlog aborts and releases rather than compressing overdue actions', async () => {
  const { executeTimeline } = await import('../run_gameplay_benchmark.mjs');
  const contacts = [];
  const result = await executeTimeline(timeline(), async (value) => contacts.push(value), {
    startAt: performance.now() - 1000,
    maxLatenessMs: 5,
  });
  assert.equal(result.success, false);
  assert.equal(result.sentEvents, 0);
  assert.equal(result.droppedEvents, timeline().events.length);
  assert.deepEqual(contacts, [[]]);
});

test('Blitz geometry requires one untruncated actual control per role', async () => {
  const { geometryFromInspection } = await import('../run_gameplay_benchmark.mjs');
  const nodes = Object.entries({
    move: 'move-stick',
    look: 'look-pad',
    run: 'run',
    jump: 'jump',
  }).map(([role, part]) => ({ attributes: { 'data-ui-part': part }, rect: geometry[role] }));
  assert.deepEqual(geometryFromInspection({ truncated: false, nodes }), geometry);
  assert.throws(() => geometryFromInspection({ truncated: true, nodes }), /truncate/);
  assert.throws(
    () => geometryFromInspection({ truncated: false, nodes: nodes.slice(1) }),
    /Unique/,
  );
});

test('host transforms refuse missing or duplicate exact seams', async () => {
  const { replaceOnce } = await import('../build_gameplay_benchmark.mjs');
  const changes = [];
  assert.equal(
    replaceOnce('before OWNER after', 'OWNER', 'observed', changes, 'owner'),
    'before observed after',
  );
  assert.equal(changes.length, 1);
  assert.throws(() => replaceOnce('OWNER OWNER', 'OWNER', '', [], 'owner'), /match once/);
  assert.throws(() => replaceOnce('other', 'OWNER', '', [], 'owner'), /match once/);
});

test('publication seams follow minifier namespaces and reject ambiguous native owners', async () => {
  const { browserPlatformSeam, replaceGameWasmHost } = await import(
    '../build_gameplay_benchmark.mjs'
  );
  const require = createRequire(
    await realpath(
      join(process.env.FORGEAX_TOOL_ROOT ?? process.cwd(), 'node_modules/tsup/dist/index.js'),
    ),
  );
  const { parse } = require('acorn');
  for (const namespace of ['o', 'a', 'nativeHost']) {
    const source = `${namespace}.i({wx,requestAnimationFrame:e=>requestAnimationFrame(e),cancelAnimationFrame:e=>cancelAnimationFrame(e)},Nr)`;
    const host = `const p=${source}.unwrap();other.i({},Nr);`;
    assert.deepEqual(browserPlatformSeam(host, parse), { namespace, source });
    assert.throws(() => browserPlatformSeam(`${host}${source};`, parse), /Exactly one/);
    assert.throws(
      () => browserPlatformSeam(host.replace('Nr)', 'otherCanvas)'), parse),
      /Exactly one/,
    );
    assert.throws(
      () =>
        browserPlatformSeam(
          host.replace('e=>requestAnimationFrame(e)', 'e=>customFrame(e)'),
          parse,
        ),
      /contract/,
    );
  }
  for (const namespace of ['i', 'r', 'nativeHost']) {
    const path = 'payload/wasm/rapier3d.wasm.br';
    const source = `${namespace}.a({wx,WXWebAssembly},\`${path}\`).unwrap()`;
    const changes = [];
    assert.equal(
      replaceGameWasmHost(`${source};other.a(1);`, parse, path, changes),
      `__browserHost.createBrowserWasmHost(${JSON.stringify(path)});other.a(1);`,
    );
    assert.equal(changes.length, 1);
    assert.throws(() => replaceGameWasmHost(`${source};${source}`, parse, path, []), /Exactly one/);
    assert.throws(
      () =>
        replaceGameWasmHost(
          source.replace('{wx,WXWebAssembly}', '{wx,WXWebAssembly:other}'),
          parse,
          path,
          [],
        ),
      /Exactly one/,
    );
  }
});

test('unacknowledged DOWN still receives unconditional native cancel', async () => {
  const { createCdpContacts } = await import('../run_gameplay_benchmark.mjs');
  const calls = [],
    dispatch = createCdpContacts({
      send: async (_, params) => {
        calls.push(params.type);
        if (params.type === 'touchStart') throw new Error('ACK lost');
      },
    });
  await assert.rejects(dispatch([{ id: 1, role: 'move', x: 20, y: 20 }]), /ACK lost/);
  await dispatch.release();
  assert.deepEqual(calls, ['touchStart', 'touchCancel']);
});

test('aborting input releases immediately and preserves an incomplete result', async () => {
  const { executeTimeline } = await import('../run_gameplay_benchmark.mjs');
  const controller = new AbortController(),
    contacts = [];
  const result = executeTimeline(timeline(), async (value) => contacts.push(value), {
    startAt: performance.now() + 100,
    signal: controller.signal,
  });
  controller.abort();
  const value = await result;
  assert.equal(value.success, false);
  assert.equal(value.sentEvents, 0);
  assert.deepEqual(contacts, [[]]);
});

test('observer abort allows real drain but can never become a completed window', async () => {
  const h = harness();
  h.observer.arm({ ...timeline(), delayMs: 100 });
  h.time(110);
  h.event(60);
  h.observer.abort();
  const value = await h.observer.drain();
  assert.equal(value.status, 'partial');
  assert.equal(value.failure, 'interrupted');
  assert.equal(value.endedAtMs, 110);
});

test('a 60 FPS mean with a long completion gap cannot pass stable cadence', () => {
  const phases = timeline().phases,
    events = [];
  for (let phase = 0; phase < 4; phase++)
    for (let index = 0; index < 60; index++) {
      const frameId = phase * 60 + index;
      const atMs =
        phase * 1000 + (phase === 0 && (index === 1 || index === 2) ? 40 : (index * 1000) / 60);
      for (const kind of ['submitted', 'completed']) events.push({ kind, atMs, frameId, phase });
    }
  const capture = {
    schemaVersion: 'forgeax-gameplay-capture/1',
    status: 'complete',
    startMs: 0,
    endMs: 4000,
    phases,
    events,
    drain: { success: true, lastSubmittedFrame: 239, lastCompletedFrame: 239 },
  };
  const report = {
    capture,
    semanticQualification: { success: true },
    inputDispatch: { success: true, droppedEvents: 0 },
    toolVerification: false,
  };
  const a = analyzeGameplay(report);
  assert.equal(a.status, 'complete');
  assert.equal(a.target.strictMeanReachedInEveryPhase, true);
  assert.equal(a.target.strict60Cadence.met, false);
  assert.equal(a.target.hardwarePerformanceQualified, false);
  assert.equal(analyzeGameplay({ ...report, inputDispatch: undefined }).status, 'partial');
  const fallen = analyzeGameplay({
    ...report,
    performanceQualification: { status: 'qualified' },
    failure: { message: 'Player did not become neutral and landed' },
  });
  assert.ok(fallen.errors.includes('runner-failure'));
  assert.equal(fallen.status, 'partial');
  assert.equal(fallen.target.strictMeanReachedInEveryPhase, false);
  assert.equal(fallen.target.hardwarePerformanceQualified, false);
  assert.ok(
    analyzeGameplay({
      ...report,
      capture: { ...capture, events: [{ ...events[0], phase: 3 }, ...events.slice(1)] },
    }).errors.includes('invalid-event-phase'),
  );
});

test('CPU profiling cannot qualify even a stable 80 FPS capture', () => {
  const report = {
    capture: {
      schemaVersion: 'forgeax-gameplay-capture/1',
      status: 'complete',
      startMs: 0,
      endMs: 4000,
      phases: timeline().phases,
      events: Array.from({ length: 320 }, (_, frameId) =>
        ['submitted', 'completed'].map((kind) => ({
          kind,
          atMs: frameId * 12.5,
          frameId,
          phase: Math.floor(frameId / 80),
        })),
      ).flat(),
      drain: { success: true, lastSubmittedFrame: 319, lastCompletedFrame: 319 },
    },
    semanticQualification: { success: true },
    inputDispatch: { success: true, droppedEvents: 0 },
    toolVerification: false,
    performanceQualification: { status: 'qualified' },
  };
  const clean = analyzeGameplay(report);
  assert.equal(clean.target.strict60Cadence.met, true);
  assert.equal(clean.target.hardwarePerformanceQualified, true);
  const profiled = analyzeGameplay({ ...report, diagnostic: 'cpu-profile' });
  assert.equal(profiled.all.fps, 80);
  assert.equal(profiled.target.strict60Cadence.met, false);
  assert.equal(profiled.target.hardwarePerformanceQualified, false);
});

test('33 ms CDP acknowledgements do not reduce a 60 Hz input schedule to 30 Hz', async () => {
  const { createCdpContacts, executeTimeline } = await import('../run_gameplay_benchmark.mjs');
  const calls = [];
  const dispatch = createCdpContacts({
    send: async (_, params) => {
      calls.push({
        at: performance.now(),
        type: params.type,
        ids: params.touchPoints.map((point) => point.id),
      });
      await new Promise((resolve) => setTimeout(resolve, 33));
    },
  });
  const t = timeline();
  const result = await executeTimeline(t, dispatch, {
    startAt: performance.now() + 50,
    maxLatenessMs: 100,
    maxPending: 4,
  });
  assert.equal(result.success, true, result.failure);
  assert.equal(result.sentEvents, 241);
  assert.equal(result.acknowledgedEvents, 241);
  assert.ok(result.peakPending >= 2 && result.peakPending <= 4);
  assert.equal(result.unsettledEvents, 0);
  assert.ok(result.events.at(-1).sentMs < 4050);
  assert.equal(calls.at(-1).type, 'touchEnd');
});

const shortInputTimeline = (stepMs = 1000 / 60) => {
  const source = createGameplayTimeline({
    geometry,
    coordinateSpace: { unit: 'css-px', width: 844, height: 390 },
    phaseMs: 1000,
    stepMs,
  });
  return validateTimeline({
    ...source,
    durationMs: 200,
    phases: source.phases.map((phase, index) => ({
      ...phase,
      startMs: index * 50,
      endMs: (index + 1) * 50,
    })),
    events: [...source.events.filter((event) => event.atMs < 200), { atMs: 200, contacts: [] }],
  });
};

for (const [stepMs, expectedCapacity, maxLatenessMs, ackDelayMs] of [
  [1000 / 60, 7, 100, 90],
  [10, 11, 100, 90],
  [1000 / 60, 4, 50, 40],
])
  test(`${ackDelayMs} ms ACKs retain every due snapshot at ${Math.round(1000 / stepMs)} Hz`, async () => {
    const { createCdpContacts, executeTimeline } = await import('../run_gameplay_benchmark.mjs');
    const calls = [];
    const dispatch = createCdpContacts({
      send: async (_, params) => {
        calls.push(params.type);
        await new Promise((resolve) => setTimeout(resolve, ackDelayMs));
      },
    });
    const t = shortInputTimeline(stepMs);
    const result = await executeTimeline(t, dispatch, {
      startAt: performance.now() + 20,
      maxLatenessMs,
    });
    assert.equal(result.success, true, result.failure);
    assert.equal(result.maxPending, expectedCapacity);
    assert.ok(result.peakPending >= expectedCapacity - 2 && result.peakPending <= expectedCapacity);
    assert.equal(result.sentEvents, t.events.length);
    assert.equal(result.acknowledgedEvents, t.events.length);
    assert.equal(result.droppedEvents, 0);
    assert.equal(result.unsettledEvents, 0);
    assert.ok(result.events.at(-1).sentMs <= t.durationMs + result.allowedLatenessMs);
    assert.ok(
      result.events.every((event) => event.acknowledgedMs - event.sentMs >= ackDelayMs - 15),
    );
    assert.equal(calls.at(-1), 'touchEnd');
    assert.equal(result.wireMetrics.releaseConfirmed, true);
  });

test('an overlapping rejected ACK remains a failure after the remaining ACKs settle', async () => {
  const { createCdpContacts, executeTimeline } = await import('../run_gameplay_benchmark.mjs');
  let calls = 0;
  const dispatch = createCdpContacts({
    send: async (_, params) => {
      const first = calls++ === 0;
      if (params.type === 'touchCancel') return;
      await new Promise((resolve) => setTimeout(resolve, first ? 75 : 90));
      if (first) throw new Error('Input ACK rejected');
    },
  });
  const result = await executeTimeline(shortInputTimeline(), dispatch);
  assert.equal(result.success, false);
  assert.equal(result.failure, 'Input ACK rejected');
  assert.equal(result.failureStage, 'event');
  assert.ok(result.sentEvents > 4);
  assert.equal(result.acknowledgedEvents, result.sentEvents - 1);
  assert.ok(result.droppedEvents > 0);
  assert.equal(result.unsettledEvents, 0);
  assert.equal(result.events[0].acknowledgedMs, null);
  assert.equal(result.wireMetrics.releaseConfirmed, true);
});

for (const [name, maxPending, expectedCapacity] of [
  ['derived', undefined, 7],
  ['explicit', 2, 2],
  ['hard-bounded', undefined, 16],
])
  test(`the ${name} queue still fails and releases when ACKs never settle`, async () => {
    const { createCdpContacts, executeTimeline } = await import('../run_gameplay_benchmark.mjs');
    const calls = [];
    const dispatch = createCdpContacts({
      send: (_, params) => {
        calls.push(params.type);
        return params.type === 'touchCancel' ? Promise.resolve() : new Promise(() => {});
      },
    });
    let t = shortInputTimeline();
    if (name === 'hard-bounded') {
      const source = shortInputTimeline(10);
      t = validateTimeline({
        ...source,
        durationMs: source.durationMs / 10,
        phases: source.phases.map((phase) => ({
          ...phase,
          startMs: phase.startMs / 10,
          endMs: phase.endMs / 10,
        })),
        events: source.events.map((event) => ({ ...event, atMs: event.atMs / 10 })),
      });
    }
    const result = await executeTimeline(t, dispatch, { maxPending, settleTimeoutMs: 20 });
    assert.equal(result.success, false);
    assert.equal(result.maxPending, expectedCapacity);
    assert.equal(result.failure, `Input acknowledgement backlog reached ${expectedCapacity}`);
    assert.match(result.cleanupError, /settlement timed out/);
    assert.equal(result.sentEvents, expectedCapacity);
    assert.equal(result.acknowledgedEvents, 0);
    assert.ok(result.droppedEvents > 0);
    assert.equal(result.unsettledEvents, expectedCapacity);
    assert.ok(result.events.every((event) => event.acknowledgedMs === null));
    assert.equal(calls.at(-1), 'touchCancel');
  });

test('overlapping snapshots update planned contacts before any acknowledgement', async () => {
  const { createCdpContacts } = await import('../run_gameplay_benchmark.mjs');
  const calls = [],
    finish = [];
  const dispatch = createCdpContacts({
    send: (_, params) => {
      calls.push(params);
      return new Promise((resolve) => finish.push(resolve));
    },
  });
  const move = { id: 1, role: 'move', x: 20, y: 20 },
    look = { id: 2, role: 'look', x: 30, y: 30 };
  const a = dispatch([move]),
    b = dispatch([move, look]),
    c = dispatch([{ ...look, x: 40 }]);
  assert.deepEqual(
    calls.map((call) => [call.type, call.touchPoints.map((point) => point.id)]),
    [
      ['touchStart', [1]],
      ['touchStart', [1, 2]],
      ['touchEnd', [1]],
      ['touchMove', [2]],
    ],
  );
  finish.forEach((resolve) => {
    resolve();
  });
  await Promise.all([a, b, c]);
});

test('release skips confirmed all-up but preserves failure of uncertain native cleanup', async () => {
  const { createCdpContacts } = await import('../run_gameplay_benchmark.mjs');
  const calls = [],
    point = { id: 1, role: 'move', x: 20, y: 20 };
  const dispatch = createCdpContacts({
    send: async (_, params) => {
      calls.push(params.type);
    },
  });
  await dispatch([point]);
  await dispatch([]);
  await dispatch.release();
  await dispatch.release();
  assert.deepEqual(calls, ['touchStart', 'touchEnd']);
  assert.equal(dispatch.wireMetrics().releaseConfirmed, true);
  const uncertain = createCdpContacts({
    send: async () => {
      throw new Error('original native failure');
    },
  });
  await assert.rejects(uncertain([point]), /original native failure/);
  await assert.rejects(uncertain.release(), /original native failure/);
  assert.equal(uncertain.wireMetrics().releaseConfirmed, false);
});

test('landing waits for the resolved player and returns the same checked sample', async () => {
  const { waitForReleasedPlayer } = await import('../run_gameplay_benchmark.mjs');
  const neutral = { controls: { horizontal: 0, vertical: 0, run: false } };
  let reads = 0;
  const landed = { ...neutral, grounded: true };
  const result = await waitForReleasedPlayer(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return ++reads >= 3 ? landed : { ...neutral, grounded: false };
    },
    { timeoutMs: 100, intervalMs: 1 },
  );
  assert.equal(reads, 3);
  assert.equal(result, landed);
  await assert.rejects(
    waitForReleasedPlayer(async () => ({ ...neutral, grounded: false }), {
      timeoutMs: 5,
      intervalMs: 1,
    }),
    /did not become neutral and landed/,
  );
});
