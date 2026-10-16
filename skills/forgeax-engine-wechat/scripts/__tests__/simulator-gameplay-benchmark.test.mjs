import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  configuration,
  connectCdp,
  controlGeometry,
  evaluate,
  inspectSimulator,
  installNativeTouchProbe,
  qualifySimulator,
  runSimulatorGameplayBenchmark,
  verifyNativeContacts,
  verifyNativePublication,
} from '../run_simulator_gameplay_benchmark.mjs';

// These are offline tooling contracts. No fixture is rendering or hardware evidence.
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const targetPath = '/game/s7/_sessionId/fixture/gamePage.html';
const nativeGeometry = {
  move: { x: 10, y: 200, width: 120, height: 120 },
  look: { x: 200, y: 50, width: 320, height: 200 },
  run: { x: 600, y: 250, width: 50, height: 50 },
  jump: { x: 700, y: 250, width: 50, height: 50 },
};
const ui = {
  truncated: false,
  nodes: Object.entries({ move: 'move-stick', look: 'look-pad', run: 'run', jump: 'jump' }).map(
    ([role, part]) => ({ attributes: { 'data-ui-part': part }, rect: nativeGeometry[role] }),
  ),
};
const extent = { width: 844, height: 390, dpr: 3, drawingWidth: 2532, drawingHeight: 1170 };
const canvasRect = { x: 10, y: 20, width: 422, height: 195 };
const viewport = { width: 600, height: 300 };
const stateGeometry = { ui, extent, canvasRect, viewport };
const options = (out) => ({
  endpoint: 'http://127.0.0.1:9422',
  window: 's7',
  targetPath,
  project: '/offline/project',
  manifestSha256: 'a'.repeat(64),
  out,
  phaseMs: 1000,
  capacityStatus: 'contended',
});

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-simulator-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function publication(t) {
  const directory = await temporary(t),
    files = [];
  const put = async (path, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    await writeFile(join(directory, path), bytes);
    const row = { path, bytes: bytes.length, sha256: sha(bytes) };
    files.push(row);
    return row;
  };
  const artifacts = [
    await put('game.js', 'ordinary-game'),
    await put('project.config.json', {
      compileType: 'game',
      setting: { es6: true },
      included: ['game.js'],
    }),
  ];
  const manifest = await put('forgeax-dist.json', { target: 'wechat', artifacts });
  const ordinary = await put('ordinary-forgeax-dist.json', { target: 'wechat', artifacts });
  await put('assembly-differences.json', { originalCallbacksPreserved: true });
  const source = {
    engineCommit: 'b'.repeat(40),
    diagnosticManifestSha256: manifest.sha256,
    publicationManifestSha256: ordinary.sha256,
  };
  const benchmark = { schemaVersion: 'forgeax-gameplay-native/1', source, files };
  await writeFile(join(directory, 'benchmark-manifest.json'), JSON.stringify(benchmark));
  return { directory, benchmark, manifestSha256: manifest.sha256 };
}

function realm({
  noTouch = false,
  cleanupFails = false,
  badCapture = false,
  strictWindow = false,
  rejectEmptyCancel = false,
  landingReads = 0,
  landingValue = true,
  nativeEndDelayMs = 0,
} = {}) {
  let time = 0,
    armed,
    aborted = false,
    drained = false,
    current = [],
    closeCount = 0;
  const log = [],
    listeners = Object.fromEntries(
      ['Start', 'Move', 'End', 'Cancel'].map((name) => [name, new Set()]),
    );
  const native = { getWindowInfo: () => ({ windowWidth: 844, windowHeight: 390, pixelRatio: 3 }) };
  for (const name of Object.keys(listeners)) {
    if (!noTouch) native[`onTouch${name}`] = (listener) => listeners[name].add(listener);
    if (!noTouch) native[`offTouch${name}`] = (listener) => listeners[name].delete(listener);
  }
  const nativeActive = new Map();
  const emit = (name, touches) => {
    for (const touch of touches) {
      if (name === 'End' || name === 'Cancel') nativeActive.delete(touch.identifier);
      else nativeActive.set(touch.identifier, touch);
    }
    for (const listener of listeners[name])
      listener({ changedTouches: touches, touches: [...nativeActive.values()] });
  };
  const renderer = {
    phase: 'ready',
    generation: 3,
    presented: 60,
    lastCompletion: { presentation: 'ready', worldIdentity: 'world-1', deviceGeneration: 2 },
  };
  const player = {
    position: [0, 1, 0],
    grounded: true,
    camera: { yaw: 0 },
    controls: { horizontal: 0, vertical: 0, run: false },
    simulation: { fixedTick: 60 },
  };
  const game = {
    wx: native,
    document: { visibilityState: 'visible' },
    __forgeaxGameInspection: {
      renderer() {
        renderer.presented += 2;
        player.simulation.fixedTick += 2;
        if (player.controls.vertical > 0) player.position[2] += 0.05;
        return clone(renderer);
      },
      read: async (name) => {
        await Promise.resolve();
        if (
          name === 'game-3d.player' &&
          armed &&
          time >= armed.endMs &&
          !drained &&
          current.length === 0
        ) {
          player.grounded = landingReads-- > 0 ? false : landingValue;
          player.position[1] = player.grounded === true ? 1 : 1.2;
          log.push({ kind: 'resolved-player', at: time, grounded: player.grounded });
        }
        return clone(name === 'game-3d.player' ? player : { vertexCount: 12, busy: false });
      },
      ui: () => ({ ok: true, value: clone(ui) }),
    },
    __gameplayBenchmark: {
      status() {
        assert.ok(
          !armed || time < armed.startMs || time >= armed.endMs || aborted,
          'Inspector entered timed window',
        );
        return { readyCompletions: 60, failure: null };
      },
      arm(value) {
        armed = {
          ...value,
          startMs: time + value.delayMs,
          endMs: time + value.delayMs + value.durationMs,
          nowMs: time,
        };
        log.push({ kind: 'arm', at: time });
        return clone(armed);
      },
      abort() {
        aborted = true;
        log.push({ kind: 'abort', at: time });
      },
      async drain() {
        assert.ok(aborted || time >= armed.endMs, 'Drain before window ended');
        assert.equal(current.length, 0, 'Drain must follow input release');
        assert.equal(player.grounded, true, 'Drain must allow natural landing');
        drained = true;
        log.push({ kind: 'drain', at: time });
        const events = badCapture
          ? []
          : armed.phases.flatMap((phase, index) =>
              [10, 510].flatMap((offset, frame) =>
                ['submitted', 'completed'].map((kind) => ({
                  kind,
                  atMs: armed.startMs + phase.startMs + offset,
                  frameId: index * 2 + frame,
                  phase: index,
                })),
              ),
            );
        return {
          schemaVersion: 'forgeax-gameplay-capture/1',
          status: aborted ? 'partial' : 'complete',
          failure: aborted ? 'interrupted' : null,
          startMs: armed.startMs,
          endMs: armed.endMs,
          phases: armed.phases,
          events,
          drain: { success: true, lastSubmittedFrame: 7, lastCompletedFrame: 7 },
        };
      },
    },
  };
  const gl = {
    RENDERER: 1,
    VERSION: 2,
    getExtension: () => null,
    getParameter: (value) => (value === 1 ? 'offline-contract-only' : 'WebGL 2'),
  };
  const canvas = {
    width: 2532,
    height: 1170,
    getBoundingClientRect: () => canvasRect,
    getContext: () => gl,
  };
  const context = vm.createContext({
    GameGlobal: {
      __gameContextWindow: game,
      wx: native,
      document: { querySelectorAll: () => [canvas] },
    },
    wx: native,
    URL,
    location: { href: `http://127.0.0.1${targetPath}` },
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    performance: { now: () => time + 10000 },
  });
  const touch = (point) => ({
    identifier: point.id + 100,
    clientX: (point.x - canvasRect.x) * 2,
    clientY: (point.y - canvasRect.y) * 2,
  });
  const contacts = async (next) => {
    const prior = current;
    const removed = prior.filter((point) => !next.some((value) => value.id === point.id));
    const added = next.filter((point) => !prior.some((value) => value.id === point.id));
    const moved = next.filter((point) =>
      prior.some((value) => value.id === point.id && (value.x !== point.x || value.y !== point.y)),
    );
    if (removed.length) emit('End', removed.map(touch));
    if (added.length) emit('Start', added.map(touch));
    if (moved.length) emit('Move', moved.map(touch));
    if (moved.some((point) => point.id === 2)) player.camera.yaw += 0.1;
    current = clone(next);
    player.controls.vertical = next.some((point) => point.id === 1) ? 1 : 0;
    player.controls.run = next.some((point) => point.id === 3);
    player.grounded = !next.some((point) => point.id === 4);
    player.position[1] = player.grounded ? 1 : 1.2;
  };
  contacts.release = async () => {
    emit('Cancel', current.map(touch));
    current = [];
    await contacts([]);
  };
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(600, 16);
  png.writeUInt32BE(300, 20);
  const cdp = {
    signal: new AbortController().signal,
    async send(method, params = {}) {
      log.push({ kind: method, at: time, type: params.type });
      if (strictWindow && armed && time >= armed.startMs && time < armed.endMs && !aborted)
        assert.equal(method, 'Input.dispatchTouchEvent', 'Only input is allowed during timing');
      if (method === 'Runtime.evaluate')
        return { result: { value: clone(await vm.runInContext(params.expression, context)) } };
      if (method === 'Page.captureScreenshot') return { data: png.toString('base64') };
      if (method === 'Input.dispatchTouchEvent') {
        if (params.type === 'touchEnd') time += nativeEndDelayMs;
        if (rejectEmptyCancel && params.type === 'touchCancel' && current.length === 0)
          throw Object.assign(new Error('Must send a TouchStart first to start a new touch.'), {
            code: 'cdp-command-rejected',
          });
        if (cleanupFails && params.type === 'touchCancel')
          throw Object.assign(new Error('release failed'), { code: 'release-failed' });
        if (params.type === 'touchCancel') await contacts.release();
        else await contacts(params.touchPoints);
      }
      return {};
    },
    async close() {
      closeCount++;
      return true;
    },
  };
  return {
    game,
    native,
    listeners,
    emit,
    cdp,
    log,
    contacts,
    player,
    renderer,
    context,
    now: () => time,
    sleep: async (ms) => {
      time += Math.max(0, ms);
    },
    setTime: (value) => {
      time = value;
    },
    result: () => ({ current, closeCount, armed, aborted, drained }),
  };
}

function dependencies(h, { failInput = false } = {}) {
  return {
    emit: () => {},
    now: h.now,
    sleep: h.sleep,
    verify: async () => ({ source: { engineCommit: 'b'.repeat(40) } }),
    discover: async () => [
      {
        url: `http://127.0.0.1${targetPath}`,
        webSocketDebuggerUrl: 'ws://127.0.0.1:9422/devtools/page/fixture',
      },
    ],
    connect: async () => h.cdp,
    qualify: async () => ({
      success: true,
      fixture: 'Offline orchestration only; actual qualifier tested separately.',
    }),
    execute: async (timeline, dispatch, { startAt }) => {
      h.setTime(startAt);
      await dispatch(timeline.events[0].contacts);
      if (failInput)
        return {
          success: false,
          failure: 'injected interruption',
          droppedEvents: timeline.events.length - 1,
        };
      h.setTime(startAt + timeline.durationMs);
      await dispatch.release();
      return {
        success: true,
        droppedEvents: 0,
        expectedEvents: timeline.events.length,
        sentEvents: timeline.events.length,
        events: [{ scheduledMs: 0, sentMs: 0, acknowledgedMs: 1 }],
      };
    },
  };
}

test('configuration requires explicit endpoint and exact window identity', () => {
  assert.throws(() => configuration({ ...options('/tmp/unused'), endpoint: undefined }), {
    code: 'invalid-endpoint',
  });
  assert.throws(
    () => configuration({ ...options('/tmp/unused'), targetPath: '/game/s8/fixture' }),
    { code: 'invalid-target-path' },
  );
  assert.throws(() => configuration({ ...options('/tmp/unused'), capacityStatus: 'qualified' }), {
    code: 'invalid-capacity-status',
  });
  assert.throws(() => configuration({ ...options('/tmp/unused'), nativeReleaseWitness: 'true' }), {
    code: 'invalid-native-release-witness',
  });
  assert.equal(configuration(options('/tmp/unused')).endpoint, 'http://127.0.0.1:9422/json/list');
});

test('native geometry maps to the actual offset CSS viewport without DPR scaling', () => {
  const mapped = controlGeometry(stateGeometry);
  assert.deepEqual(mapped.css.move, { x: 15, y: 120, width: 60, height: 60 });
  assert.deepEqual(mapped.coordinateSpace, { unit: 'css-px', ...viewport });
  assert.throws(() => controlGeometry({ ...stateGeometry, canvasRect: undefined }), {
    code: 'canvas-geometry-unavailable',
  });
  assert.throws(
    () => controlGeometry({ ...stateGeometry, canvasRect: { ...canvasRect, x: 300 } }),
    { code: 'canvas-outside-cdp-viewport' },
  );
});

test('serialized public wx probe observes stable independent contacts and preserves original subscribers', async () => {
  const h = realm();
  let originals = 0;
  h.native.onTouchStart(() => originals++);
  await evaluate(h.cdp, installNativeTouchProbe, { token: 'owned' });
  const contacts = [
    { id: 1, role: 'move', x: 30, y: 140 },
    { id: 2, role: 'look', x: 160, y: 100 },
  ];
  await h.contacts(contacts);
  assert.deepEqual(
    verifyNativeContacts(h.game.__forgeaxSimulatorTouchProbe.snapshot(), contacts, stateGeometry),
    { move: 101, look: 102 },
  );
  await h.contacts([contacts[0]]);
  assert.deepEqual(
    verifyNativeContacts(
      h.game.__forgeaxSimulatorTouchProbe.snapshot(),
      [contacts[0]],
      stateGeometry,
    ),
    { move: 101 },
  );
  const released = h.game.__forgeaxSimulatorTouchProbe.release();
  assert.equal(released.released, true);
  assert.equal(h.listeners.Start.size, 1);
  assert.equal(originals, 1);
  assert.equal(h.game.__forgeaxSimulatorTouchProbe, undefined);
});

test('distinct simulator wx proxies with equal display dimensions select only the game realm', async () => {
  const h = realm();
  h.native.getWindowInfo = () => ({
    windowWidth: 844,
    windowHeight: 390,
    pixelRatio: 3,
    screenWidth: 844,
    screenHeight: 390,
    statusBarHeight: 0,
    safeArea: { left: 47, top: 0, right: 797, bottom: 369, width: 750, height: 369 },
  });
  const aliasSubscriptions = [];
  for (const [owner, label] of [
    [h.context.GameGlobal, 'GameGlobal'],
    [h.context, 'globalThis'],
  ]) {
    owner.wx = { ...h.native, onTouchStart: () => aliasSubscriptions.push(label) };
  }
  assert.notEqual(h.context.GameGlobal.wx, h.game.wx);
  assert.notEqual(h.context.wx, h.game.wx);
  const state = await evaluate(h.cdp, inspectSimulator, { geometry: true });
  assert.equal(state.nativeDisplay.source, 'game-realm');
  assert.equal(state.nativeDisplay.aliases.length, 3);
  assert.deepEqual(state.extent, extent);
  const installed = await evaluate(h.cdp, installNativeTouchProbe, { token: 'native-proxies' });
  assert.equal(installed.source, 'game-realm');
  assert.equal(h.listeners.Start.size, 1);
  assert.deepEqual(aliasSubscriptions, []);
  const point = { id: 1, role: 'move', x: 30, y: 140 };
  await h.contacts([point]);
  assert.deepEqual(
    verifyNativeContacts(h.game.__forgeaxSimulatorTouchProbe.snapshot(), [point], stateGeometry),
    { move: 101 },
  );
  assert.equal(h.game.__forgeaxSimulatorTouchProbe.release().source, 'game-realm');
});

test('conflicting fallback display dimensions retain both sources and never install contacts', async () => {
  for (const [field, value] of [
    ['windowWidth', 843],
    ['windowHeight', 389],
    ['pixelRatio', 2],
  ]) {
    const h = realm();
    h.context.wx = {
      ...h.native,
      getWindowInfo: () => ({ ...h.native.getWindowInfo(), [field]: value }),
    };
    await assert.rejects(
      evaluate(h.cdp, inspectSimulator, { geometry: true }),
      (error) =>
        error.code === 'native-display-source-mismatch' &&
        error.detail.source === 'game-realm' &&
        error.detail.comparedSource === 'globalThis.wx' &&
        error.detail.actual[field] === value,
    );
    assert.equal(h.listeners.Start.size, 0);
  }
});

test('missing game-native APIs cannot silently substitute a wrapper proxy', async () => {
  const h = realm();
  h.game.wx = {};
  await assert.rejects(
    evaluate(h.cdp, inspectSimulator, { geometry: true }),
    (error) =>
      error.code === 'game-native-display-unavailable' && error.detail.source === 'game-realm',
  );
  await assert.rejects(
    evaluate(h.cdp, installNativeTouchProbe, { token: 'missing' }),
    (error) =>
      error.code === 'game-native-touch-unavailable' &&
      error.detail.source === 'game-realm' &&
      error.detail.missing.includes('onTouchStart'),
  );
  assert.equal(h.listeners.Start.size, 0);
  assert.equal(h.game.__forgeaxSimulatorTouchProbe, undefined);
});

test('native probe rejects duplicate IDs, malformed touches and bounded evidence overflow', async () => {
  for (const [kind, expected] of [
    ['duplicate', 'duplicate-native-touch-start'],
    ['invalid', 'invalid-native-touch'],
    ['overflow', 'touch-observer-overflow'],
  ]) {
    const h = realm();
    await evaluate(h.cdp, installNativeTouchProbe, {
      token: kind,
      maxEvents: kind === 'overflow' ? 1 : 512,
    });
    h.emit('Start', [{ identifier: 9, clientX: 30, clientY: 50 }]);
    h.emit('Start', [{ identifier: kind === 'invalid' ? NaN : 9, clientX: 30, clientY: 50 }]);
    assert.equal(h.game.__forgeaxSimulatorTouchProbe.snapshot().failure, expected);
    h.game.__forgeaxSimulatorTouchProbe.release();
  }
});

test('cross-realm startup failure keeps its original message and code', async () => {
  const h = realm();
  vm.runInContext(
    "GameGlobal.__gameContextWindow.__forgeaxGameInspection.renderer = () => ({startupError: Object.assign(new Error('native shader rejected'), {code:'shader-invalid', detail:{line:7}})})",
    h.context,
  );
  await assert.rejects(
    evaluate(h.cdp, inspectSimulator, {}),
    (error) =>
      error.code === 'ordinary-game-failed' &&
      error.detail.message === 'native shader rejected' &&
      error.detail.code === 'shader-invalid' &&
      error.detail.detail.line === 7,
  );
});

test('real qualifier validates public touch semantics, all gameplay controls and final stop', async () => {
  const h = realm();
  await evaluate(h.cdp, installNativeTouchProbe, { token: 'qualify' });
  const state = await evaluate(h.cdp, inspectSimulator, { geometry: true });
  const result = await qualifySimulator({
    cdp: h.cdp,
    dispatch: h.contacts,
    state,
    config: options('/unused'),
    geometry: controlGeometry(state).css,
    token: 'qualify',
    now: h.now,
    sleep: h.sleep,
  });
  assert.deepEqual(
    result.rows.map((row) => row.name),
    ['independent-run-release', 'walk', 'run', 'jump', 'run-jump'],
  );
  assert.equal(result.rows.at(-1).active.touch.active.length, 4);
  assert.equal(h.result().current.length, 0);
  assert.equal(h.player.controls.run, false);
  assert.equal(h.player.grounded, true);
  h.game.__forgeaxSimulatorTouchProbe.release();
});

test('normal qualification release uses End when emergency Cancel has no native event', async () => {
  const h = realm();
  await evaluate(h.cdp, installNativeTouchProbe, { token: 'normal-release' });
  const state = await evaluate(h.cdp, inspectSimulator, { geometry: true });
  let normalReleases = 0,
    emergencyCancels = 0;
  const dispatch = async (contacts) => {
    if (contacts.length === 0) normalReleases++;
    await h.contacts(contacts);
  };
  // Observed IDE behavior: the command ACK alone does not deliver a wx event.
  dispatch.release = async () => {
    emergencyCancels++;
  };
  const result = await qualifySimulator({
    cdp: h.cdp,
    dispatch,
    state,
    config: options('/unused'),
    geometry: controlGeometry(state).css,
    token: 'normal-release',
    now: h.now,
    sleep: h.sleep,
  });
  assert.equal(result.success, true);
  assert.ok(normalReleases > 0);
  assert.equal(emergencyCancels, 0);
  assert.ok(result.rows.every((row) => row.released.touch.activeCount === 0));
  assert.equal(h.result().current.length, 0);
  assert.deepEqual(h.player.controls, { horizontal: 0, vertical: 0, run: false });
  const native = h.game.__forgeaxSimulatorTouchProbe.release();
  assert.ok(native.events.some((event) => event.phase === 'end'));
  assert.ok(native.events.every((event) => event.phase !== 'cancel'));
});

test('semantic timeouts retain their independent-contact or gameplay stage and compact last state', async () => {
  for (const expectedStage of ['independent.run-release', 'jump.active']) {
    const h = realm();
    h.renderer.unrelatedLargeDiagnostics = 'x'.repeat(100000);
    h.player.unrelatedLargeDiagnostics = 'x'.repeat(100000);
    await evaluate(h.cdp, installNativeTouchProbe, { token: 'failure-stage' });
    const state = await evaluate(h.cdp, inspectSimulator, { geometry: true });
    let runHeld = false;
    const dispatch = async (contacts) => {
      const run = contacts.find((contact) => contact.id === 3);
      if (expectedStage === 'independent.run-release' && runHeld && !run) {
        // Reproduce an acknowledged release that ends Move and leaves Run held.
        await h.contacts([{ id: 3, ...controlGeometry(state).css.run }]);
        return;
      }
      await h.contacts(contacts);
      runHeld = Boolean(run);
      if (expectedStage === 'jump.active' && contacts.some((contact) => contact.id === 4)) {
        h.player.grounded = true;
        h.player.position[1] = 1;
      }
    };
    dispatch.release = h.contacts.release;
    await assert.rejects(
      qualifySimulator({
        cdp: h.cdp,
        dispatch,
        state,
        config: options('/unused'),
        geometry: controlGeometry(state).css,
        token: 'failure-stage',
        now: h.now,
        sleep: h.sleep,
      }),
      (error) => {
        assert.equal(error.code, 'gameplay-semantic-timeout');
        assert.equal(error.detail.stage, expectedStage);
        assert.ok(error.detail.expected);
        assert.ok(error.detail.last.player);
        assert.ok(error.detail.last.touch.events.length <= 8);
        assert.equal(error.detail.last.renderer.unrelatedLargeDiagnostics, undefined);
        assert.equal(error.detail.last.player.unrelatedLargeDiagnostics, undefined);
        if (expectedStage === 'independent.run-release') {
          assert.equal(error.detail.expected.run, false);
          assert.equal(error.detail.last.player.controls.run, true);
          assert.equal(error.detail.last.touch.active[0].id, 103);
        } else {
          assert.equal(error.detail.expected.airborneAndHeightAbove, 0.04);
          assert.equal(error.detail.last.player.grounded, true);
        }
        return true;
      },
    );
    h.game.__forgeaxSimulatorTouchProbe.release();
  }
});

test('qualification dispatch failure preserves stage, expected contacts and original cause', async () => {
  const h = realm();
  await evaluate(h.cdp, installNativeTouchProbe, { token: 'dispatch-failure' });
  const state = await evaluate(h.cdp, inspectSimulator, { geometry: true });
  const dispatch = async (contacts) => {
    if (contacts.length === 0) return h.contacts(contacts);
    throw Object.assign(new Error('native command rejected'), {
      code: 'cdp-command-rejected',
      detail: { nativeCode: -1 },
    });
  };
  dispatch.release = h.contacts.release;
  await assert.rejects(
    qualifySimulator({
      cdp: h.cdp,
      dispatch,
      state,
      config: options('/unused'),
      geometry: controlGeometry(state).css,
      token: 'dispatch-failure',
      now: h.now,
      sleep: h.sleep,
    }),
    (error) => {
      assert.equal(error.code, 'cdp-command-rejected');
      assert.equal(error.detail.stage, 'independent.walk-command');
      assert.equal(error.detail.expected.nativeContacts[0].role, 'move');
      assert.equal(error.detail.cause.message, 'native command rejected');
      assert.equal(error.detail.cause.detail.nativeCode, -1);
      assert.equal(error.detail.last.player.controls.vertical, 0);
      return true;
    },
  );
  h.game.__forgeaxSimulatorTouchProbe.release();
});

test('release ACK cannot hide a held native contact or non-neutral game controls', async (t) => {
  for (const stuck of ['native-contact', 'game-controls']) {
    const h = realm();
    const dep = dependencies(h);
    const send = h.cdp.send.bind(h.cdp);
    if (stuck === 'native-contact')
      h.cdp.send = async (method, params) => {
        if (method === 'Input.dispatchTouchEvent' && params.type === 'touchEnd') return {};
        return send(method, params);
      };
    dep.qualify = async ({ dispatch }) => {
      await dispatch([{ id: 3, role: 'run', x: 325, y: 155 }]);
      await dispatch([]);
      if (stuck === 'game-controls') h.player.controls.run = true;
      throw Object.assign(new Error('qualification interrupted'), { code: 'qualification-failed' });
    };
    const result = await runSimulatorGameplayBenchmark(
      options(join(await temporary(t), 'out')),
      dep,
    );
    assert.equal(result.failure.code, 'qualification-failed');
    assert.equal(result.inputCleanup.releaseConfirmed, true);
    assert.equal(result.cleanup.contactsReleased, false);
    assert.equal(result.cleanup.nativeContactsReleased, false);
    assert.equal(result.cleanup.touchObserverReleased, true);
    const error = result.errors.find((row) => row.stage === 'contact-release');
    assert.equal(error.code, 'native-input-release-timeout');
    assert.equal(error.detail.last.touch.activeCount, stuck === 'native-contact' ? 1 : 0);
    assert.equal(error.detail.last.player.controls.run, true);
    assert.equal(error.detail.last.renderer, undefined);
    assert.equal(h.now(), 1500);
    assert.equal(h.result().closeCount, 1);
  }
});

test('cleanup waits briefly for resolved native release and neutral game controls', async (t) => {
  const h = realm();
  const dep = dependencies(h);
  dep.qualify = async ({ dispatch }) => {
    await dispatch([{ id: 3, role: 'run', x: 325, y: 155 }]);
    await dispatch([]);
    h.player.controls.run = true;
    throw Object.assign(new Error('qualification interrupted'), { code: 'qualification-failed' });
  };
  let waits = 0;
  dep.sleep = async (ms) => {
    await h.sleep(ms);
    if (++waits === 3) h.player.controls.run = false;
  };
  const result = await runSimulatorGameplayBenchmark(options(join(await temporary(t), 'out')), dep);
  assert.equal(result.failure.code, 'qualification-failed');
  assert.equal(result.cleanup.contactsReleased, true);
  assert.equal(result.cleanup.nativeContactsReleased, true);
  assert.equal(result.nativeReleaseWitness.touch.activeCount, 0);
  assert.equal(result.nativeReleaseWitness.player.controls.run, false);
  assert.equal(waits, 3);
  assert.equal(result.errors.length, 0);
});

test('publication pin rejects a changed artifact even if the secondary inventory is rewritten', async (t) => {
  const fixture = await publication(t);
  await verifyNativePublication(fixture.directory, fixture.manifestSha256);
  const changed = Buffer.from('changed-game');
  await writeFile(join(fixture.directory, 'game.js'), changed);
  const row = fixture.benchmark.files.find((row) => row.path === 'game.js');
  row.sha256 = sha(changed);
  row.bytes = changed.length;
  await writeFile(
    join(fixture.directory, 'benchmark-manifest.json'),
    JSON.stringify(fixture.benchmark),
  );
  await assert.rejects(verifyNativePublication(fixture.directory, fixture.manifestSha256), {
    code: 'publication-artifact-mismatch',
  });
});

test('only additive IDE object metadata is admitted against independently frozen config', async (t) => {
  const fixture = await publication(t),
    ide = join(await temporary(t), 'ide');
  await cp(fixture.directory, ide, { recursive: true });
  const original = JSON.parse(await readFile(join(ide, 'project.config.json')));
  await writeFile(
    join(ide, 'project.config.json'),
    JSON.stringify({
      ...original,
      setting: { ...original.setting, newIdeField: true },
      editor: { folded: [] },
    }),
  );
  const result = await verifyNativePublication(ide, fixture.manifestSha256, fixture.directory);
  assert.deepEqual(result.configuration.ideAdditionPaths, ['/editor', '/setting/newIdeField']);
  await assert.rejects(verifyNativePublication(ide, fixture.manifestSha256), {
    code: 'publication-file-mismatch',
  });
  await writeFile(
    join(ide, 'project.config.json'),
    JSON.stringify({ ...original, setting: { es6: false } }),
  );
  await assert.rejects(verifyNativePublication(ide, fixture.manifestSha256, fixture.directory), {
    code: 'publication-config-value-changed',
  });
  await writeFile(join(ide, 'project.config.json'), JSON.stringify({ setting: original.setting }));
  await assert.rejects(verifyNativePublication(ide, fixture.manifestSha256, fixture.directory), {
    code: 'publication-config-value-removed',
  });
});

test('publication refuses an artifact symlink escaping its directory', async (t) => {
  const fixture = await publication(t),
    outside = join(await temporary(t), 'game.js');
  await writeFile(outside, 'ordinary-game');
  await rm(join(fixture.directory, 'game.js'));
  await symlink(outside, join(fixture.directory, 'game.js'));
  await assert.rejects(verifyNativePublication(fixture.directory, fixture.manifestSha256), {
    code: 'publication-path-escape',
  });
});

test('source mismatch fails before endpoint discovery and preserves a private failure report', async (t) => {
  const root = await temporary(t);
  let discovered = false;
  const result = await runSimulatorGameplayBenchmark(options(join(root, 'out')), {
    emit: () => {},
    verify: async () => {
      throw Object.assign(new Error('mismatch'), { code: 'publication-manifest-mismatch' });
    },
    discover: async () => {
      discovered = true;
    },
  });
  assert.equal(result.failure.code, 'publication-manifest-mismatch');
  assert.equal(discovered, false);
  assert.equal((await stat(join(root, 'out/report.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'out'))).mode & 0o777, 0o700);
});

test('missing endpoint or exact target never attaches or sends input', async (t) => {
  for (const endpointFails of [true, false]) {
    const h = realm(),
      dep = dependencies(h);
    let connected = false;
    dep.discover = async () => {
      if (endpointFails) throw new Error('offline');
      return [{ url: 'http://127.0.0.1/game/s8/unrelated' }];
    };
    dep.connect = async () => {
      connected = true;
      return h.cdp;
    };
    const result = await runSimulatorGameplayBenchmark(
      options(join(await temporary(t), 'out')),
      dep,
    );
    assert.equal(result.failure.code, endpointFails ? 'endpoint-unavailable' : 'target-not-found');
    assert.equal(connected, false);
    assert.equal(h.log.length, 0);
  }
});

test('missing public native touch bridge fails before arming and closes only its socket', async (t) => {
  const h = realm({ noTouch: true });
  const result = await runSimulatorGameplayBenchmark(
    options(join(await temporary(t), 'out')),
    dependencies(h),
  );
  assert.equal(result.failure.code, 'game-native-touch-unavailable');
  assert.equal(h.result().armed, undefined);
  assert.equal(h.result().closeCount, 1);
  assert.equal(h.game.__forgeaxSimulatorTouchProbe, undefined);
});

test('timing admits only input, release precedes drain, raw events survive and capacity stays unqualified', async (t) => {
  const h = realm({ strictWindow: true }),
    out = join(await temporary(t), 'out');
  const result = await runSimulatorGameplayBenchmark(options(out), dependencies(h));
  assert.equal(result.success, true, JSON.stringify(result.failure));
  assert.equal(result.analysis.status, 'complete');
  assert.equal(result.analysis.target.hardwarePerformanceQualified, false);
  assert.equal(result.performanceQualification.status, 'contended');
  assert.equal(result.capture.events.length, 16);
  assert.equal(result.images.length, 3);
  assert.ok(h.log.find((row) => row.kind === 'drain').at > h.result().armed.endMs);
  assert.deepEqual(
    JSON.parse(await readFile(join(out, 'report.json'))).capture.events,
    result.capture.events,
  );
  assert.equal(h.result().closeCount, 1);
  assert.equal(h.game.__forgeaxSimulatorTouchProbe, undefined);
});

test('input failure after arming unconditionally cancels, aborts and drains as partial', async (t) => {
  const h = realm();
  const result = await runSimulatorGameplayBenchmark(
    options(join(await temporary(t), 'out')),
    dependencies(h, { failInput: true }),
  );
  assert.equal(result.success, false);
  assert.equal(result.failure.code, 'input-timeline-incomplete');
  assert.equal(result.capture.status, 'partial');
  assert.equal(result.analysis.status, 'partial');
  assert.equal(result.cleanup.contactsReleased, true);
  assert.equal(result.cleanup.drained, true);
  assert.equal(h.result().aborted, true);
  assert.equal(h.result().current.length, 0);
});

test('an executed arm with a lost acknowledgement is still aborted and drained', async (t) => {
  const h = realm(),
    send = h.cdp.send.bind(h.cdp);
  h.cdp.send = async (method, params) => {
    const result = await send(method, params);
    if (
      method === 'Runtime.evaluate' &&
      params.expression.includes('__gameplayBenchmark.arm(value)')
    )
      throw Object.assign(new Error('ACK lost'), { code: 'cdp-command-timeout' });
    return result;
  };
  const result = await runSimulatorGameplayBenchmark(
    options(join(await temporary(t), 'out')),
    dependencies(h),
  );
  assert.equal(result.failure.code, 'cdp-command-timeout');
  assert.equal(h.result().aborted, true);
  assert.equal(h.result().drained, true);
  assert.equal(result.capture.status, 'partial');
  assert.equal(result.cleanup.contactsReleased, true);
});

test('a previously armed realm fails before new input or a second observer arm', async (t) => {
  const h = realm();
  h.game.__gameplayBenchmark.status = () => ({ readyCompletions: 60, armed: true, ended: true });
  const result = await runSimulatorGameplayBenchmark(
    options(join(await temporary(t), 'out')),
    dependencies(h),
  );
  assert.equal(result.failure.code, 'benchmark-realm-already-used');
  assert.equal(h.result().armed, undefined);
  assert.ok(!h.log.some((row) => row.type === 'touchStart'));
});

test('cleanup failure and empty completion evidence cannot become successful collection', async (t) => {
  for (const fixture of [{ cleanupFails: true }, { badCapture: true }]) {
    const h = realm(fixture);
    const result = await runSimulatorGameplayBenchmark(
      options(join(await temporary(t), 'out')),
      dependencies(h),
    );
    assert.equal(result.success, false);
    assert.equal(h.result().closeCount, 1);
    if (fixture.cleanupFails) {
      assert.equal(result.cleanup.contactsReleased, false);
      assert.ok(result.errors.some((row) => row.stage === 'contact-release'));
    } else {
      assert.equal(result.failure.code, 'analysis-incomplete');
      assert.ok(result.analysis.errors.includes('missing-completions'));
    }
  }
});

test('confirmed final all-up skips a redundant native cancel and records its wire evidence', async (t) => {
  const h = realm({ rejectEmptyCancel: true }),
    dep = dependencies(h);
  dep.execute = async (timeline, dispatch, { startAt }) => {
    h.setTime(startAt);
    await dispatch(timeline.events[0].contacts);
    h.setTime(startAt + timeline.durationMs);
    await dispatch(timeline.events.at(-1).contacts);
    await dispatch.release();
    return { success: true, droppedEvents: 0, wireMetrics: dispatch.wireMetrics() };
  };
  const result = await runSimulatorGameplayBenchmark(options(join(await temporary(t), 'out')), dep);
  assert.equal(result.success, true, JSON.stringify(result.failure));
  assert.deepEqual(
    h.log.filter((row) => row.kind === 'Input.dispatchTouchEvent').map((row) => row.type),
    ['touchStart', 'touchEnd'],
  );
  assert.equal(result.inputCleanup.releaseConfirmed, true);
  assert.equal(result.inputCleanup.pendingWireCommands, 0);
});

// Model the observed terminal timeout without changing the wire driver's ACK owner.
function terminalAckLoss(
  h,
  { deliver = true, beforeTerminal = () => {}, beforeResult = () => {} } = {},
) {
  const dep = dependencies(h),
    send = h.cdp.send.bind(h.cdp);
  let cancelCount = 0,
    input;
  h.cdp.send = async (method, params) => {
    if (method !== 'Input.dispatchTouchEvent') return send(method, params);
    if (params.type === 'touchCancel') cancelCount++;
    if (deliver) await send(method, params);
    if (params.type === 'touchEnd')
      throw Object.assign(new Error('Input acknowledgement settlement timed out'), {
        code: 'cdp-command-timeout',
      });
    if (!deliver && params.type === 'touchCancel')
      throw Object.assign(new Error('Must send a TouchStart first to start a new touch.'), {
        code: 'cdp-command-rejected',
      });
    return {};
  };
  dep.execute = async (timeline, dispatch, { startAt }) => {
    h.setTime(startAt);
    await dispatch(timeline.events[0].contacts);
    await beforeTerminal(startAt, timeline, dispatch);
    h.setTime(startAt + timeline.durationMs);
    await assert.rejects(dispatch(timeline.events.at(-1).contacts), {
      code: 'cdp-command-timeout',
    });
    let cleanupError;
    try {
      await dispatch.release();
    } catch (error) {
      cleanupError = error.message;
    }
    beforeResult();
    input = {
      success: false,
      failure: 'Input acknowledgement settlement timed out',
      failureStage: 'schedule-or-settlement',
      cleanupError,
      expectedEvents: timeline.events.length,
      sentEvents: timeline.events.length,
      acknowledgedEvents: timeline.events.length - 1,
      droppedEvents: 0,
      unsettledEvents: 0,
      events: [
        { scheduledMs: timeline.durationMs, sentMs: timeline.durationMs, acknowledgedMs: null },
      ],
    };
    return input;
  };
  return { dep, result: () => ({ cancelCount, input: clone(input) }) };
}

test('native release with missing final ACK remains partial and skips only the redundant second cancel', async (t) => {
  const h = realm({ strictWindow: true, rejectEmptyCancel: true, nativeEndDelayMs: 5 }),
    loss = terminalAckLoss(h);
  const result = await runSimulatorGameplayBenchmark(
    { ...options(join(await temporary(t), 'out')), nativeReleaseWitness: true },
    loss.dep,
  );
  assert.equal(result.success, false);
  assert.equal(result.failure.code, 'input-timeline-incomplete');
  assert.equal(result.analysis.status, 'partial');
  assert.equal(result.analysis.target.hardwarePerformanceQualified, false);
  assert.equal(result.analysis.target.strict60Cadence.met, false);
  assert.equal(result.diagnostic, 'native-release-witness');
  assert.deepEqual(result.inputDispatch, loss.result().input);
  assert.equal(result.inputDispatch.events.at(-1).acknowledgedMs, null);
  assert.equal(result.inputCleanup.releaseConfirmed, false);
  assert.equal(result.cleanup.contactsReleased, false);
  assert.equal(result.cleanup.nativeContactsReleased, true);
  assert.equal(result.terminalNativeRelease.outcome, 'native-released-ack-unconfirmed');
  assert.equal(result.terminalNativeRelease.samples.length, 1);
  assert.equal(result.terminalNativeRelease.samples[0].touch.events.at(-1).phase, 'End');
  assert.equal(result.terminalNativeRelease.samples[0].terminalTiming.matched, true);
  assert.equal(
    result.clockAlignment.nativeRelease.pageNowMs,
    10000,
    'Calibrate the independent page clock origin',
  );
  assert.equal(result.terminalNativeRelease.samples[0].state.player.controls.vertical, 0);
  assert.equal(
    loss.result().cancelCount,
    1,
    'The scheduler cleanup rejection must remain; only finally is skipped',
  );
  assert.match(result.inputDispatch.cleanupError, /Must send a TouchStart/);
  assert.equal(result.cleanup.nativeReleaseObserverReleased, true);
  assert.ok(Object.values(h.listeners).every((listeners) => listeners.size === 0));
});

test('ACK loss without native Start cannot borrow neutral player state or a rejected cancel as proof', async (t) => {
  const h = realm({ strictWindow: true }),
    loss = terminalAckLoss(h, { deliver: false });
  const result = await runSimulatorGameplayBenchmark(
    { ...options(join(await temporary(t), 'out')), nativeReleaseWitness: true },
    loss.dep,
  );
  assert.equal(result.terminalNativeRelease.outcome, 'native-start-not-observed');
  assert.equal(result.terminalNativeRelease.samples.length, 2);
  assert.equal(result.cleanup.nativeContactsReleased, false);
  assert.equal(result.cleanup.contactsReleased, false);
  assert.equal(loss.result().cancelCount, 2);
  assert.equal(result.analysis.status, 'partial');
  assert.deepEqual(result.inputDispatch, loss.result().input);
  assert.equal(result.cleanup.nativeReleaseObserverReleased, true);
});

test('duplicate native Start stays invalid and partial while successful listener removal is reported truthfully', async (t) => {
  const h = realm({ rejectEmptyCancel: true, nativeEndDelayMs: 5 });
  const loss = terminalAckLoss(h, {
    beforeTerminal: () => {
      const identifier = h.result().current[0].id + 100;
      h.emit('Start', [{ identifier, clientX: 12, clientY: 34 }]);
    },
  });
  const result = await runSimulatorGameplayBenchmark(
    { ...options(join(await temporary(t), 'out')), nativeReleaseWitness: true },
    loss.dep,
  );
  assert.equal(result.nativeReleaseObserver.failure, 'native-release-duplicate-start');
  assert.equal(result.nativeReleaseObserver.released, true);
  assert.equal(result.cleanup.nativeReleaseObserverReleased, true);
  assert.equal(result.cleanup.nativeContactsReleased, false);
  assert.equal(result.cleanup.contactsReleased, false);
  assert.equal(result.terminalNativeRelease.outcome, 'native-evidence-invalid');
  assert.equal(result.nativeReleaseObserver.firstAnomaly.code, 'native-release-duplicate-start');
  assert.equal(result.nativeReleaseObserver.firstAnomaly.changedTouches.points[0].clientX, 12);
  assert.equal(result.nativeReleaseObserver.nativeReleased, false);
  assert.equal(result.success, false);
  assert.equal(result.failure.code, 'input-timeline-incomplete');
  assert.equal(result.analysis.status, 'partial');
  assert.deepEqual(result.inputDispatch, loss.result().input);
  assert.equal(result.inputCleanup.releaseConfirmed, false);
  assert.ok(Object.values(h.listeners).every((listeners) => listeners.size === 0));
});

test('an old mid-window native zero cannot attest a later terminal dispatch with missing native delivery', async (t) => {
  const h = realm({ strictWindow: true });
  const loss = terminalAckLoss(h, {
    deliver: false,
    beforeTerminal: async (startAt, timeline, dispatch) => {
      h.emit('Start', [{ identifier: 101, clientX: 1, clientY: 1 }]);
      h.setTime(startAt + timeline.durationMs - 1948);
      h.emit('End', [{ identifier: 101, clientX: 1, clientY: 1 }]);
      h.setTime(startAt + timeline.durationMs - 1000);
      await dispatch(
        timeline.events[0].contacts.map((contact) => ({ ...contact, x: contact.x + 1 })),
      );
    },
  });
  const result = await runSimulatorGameplayBenchmark(
    { ...options(join(await temporary(t), 'out')), nativeReleaseWitness: true },
    loss.dep,
  );
  assert.equal(result.success, false);
  assert.equal(result.cleanup.nativeContactsReleased, false);
  assert.equal(result.terminalNativeRelease.outcome, 'native-release-unproven');
  assert.equal(result.terminalNativeRelease.samples[0].terminalTiming.matched, false);
  assert.ok(
    result.terminalNativeRelease.samples[0].terminalTiming.eventPageMs <
      result.terminalNativeRelease.samples[0].terminalTiming.earliestPageMs - 1900,
  );
  assert.equal(loss.result().cancelCount, 2, 'Stale zero must not suppress final cleanup');
  assert.equal(result.analysis.status, 'partial');
  assert.deepEqual(result.inputDispatch, loss.result().input);
});

test('an event inside the terminal clock uncertainty cannot qualify release', async (t) => {
  const h = realm({ rejectEmptyCancel: true, nativeEndDelayMs: 5 }),
    send = h.cdp.send.bind(h.cdp);
  h.cdp.send = async (method, params) => {
    if (
      method === 'Runtime.evaluate' &&
      params.expression.includes('__gameplayBenchmark.arm(value)')
    )
      h.setTime(h.now() + 20);
    return send(method, params);
  };
  const loss = terminalAckLoss(h, { beforeResult: () => h.setTime(h.now() + 50) });
  const result = await runSimulatorGameplayBenchmark(
    { ...options(join(await temporary(t), 'out')), nativeReleaseWitness: true },
    loss.dep,
  );
  const timing = result.terminalNativeRelease.samples[0].terminalTiming;
  assert.ok(timing.eventPageMs > timing.earliestPageMs);
  assert.ok(timing.eventPageMs < timing.latestPageMs);
  assert.equal(timing.matched, false);
  assert.equal(result.cleanup.nativeContactsReleased, false);
  assert.equal(loss.result().cancelCount, 2);
  assert.equal(result.analysis.status, 'partial');
});

test('opt-in diagnostics keep the input-only window and exclude an otherwise complete run from performance acceptance', async (t) => {
  const h = realm({ strictWindow: true, nativeEndDelayMs: 5 }),
    dep = dependencies(h);
  dep.execute = async (timeline, dispatch, { startAt }) => {
    h.setTime(startAt);
    await dispatch(timeline.events[0].contacts);
    h.setTime(startAt + timeline.durationMs);
    await dispatch([]);
    return {
      success: true,
      expectedEvents: timeline.events.length,
      sentEvents: timeline.events.length,
      acknowledgedEvents: timeline.events.length,
      droppedEvents: 0,
      unsettledEvents: 0,
      events: [
        {
          scheduledMs: timeline.durationMs,
          sentMs: timeline.durationMs,
          acknowledgedMs: timeline.durationMs + 5,
        },
      ],
    };
  };
  const result = await runSimulatorGameplayBenchmark(
    { ...options(join(await temporary(t), 'out')), nativeReleaseWitness: true },
    dep,
  );
  assert.equal(result.success, true, JSON.stringify(result.failure));
  assert.equal(result.analysis.status, 'complete');
  assert.equal(result.analysis.diagnostic, 'native-release-witness');
  assert.equal(result.analysis.target.strict60Cadence.met, false);
  assert.equal(result.analysis.target.hardwarePerformanceQualified, false);
  assert.equal(result.terminalNativeRelease.outcome, 'native-released-acknowledged');
  assert.equal(result.cleanup.nativeReleaseObserverReleased, true);
});

test('native zero alone does not skip cleanup after World replacement or a non-boolean landing', async (t) => {
  for (const replacedWorld of [true, false]) {
    const h = realm({ rejectEmptyCancel: true, landingValue: replacedWorld ? true : 'true' });
    const loss = terminalAckLoss(h, {
      beforeResult: () => {
        if (replacedWorld) h.renderer.lastCompletion.worldIdentity = 'world-replaced';
      },
    });
    const result = await runSimulatorGameplayBenchmark(
      { ...options(join(await temporary(t), 'out')), nativeReleaseWitness: true },
      loss.dep,
    );
    assert.equal(result.success, false);
    assert.equal(loss.result().cancelCount, 2);
    assert.equal(
      result.terminalNativeRelease.outcome,
      replacedWorld ? 'native-evidence-invalid' : 'native-release-unproven',
    );
    if (replacedWorld)
      assert.equal(result.terminalNativeRelease.samples[0].failure.code, 'game-identity-changed');
    assert.equal(result.cleanup.nativeReleaseObserverReleased, true);
  }
});

test('an early interruption releases the diagnostic listener after abort/drain without post-window inspection', async (t) => {
  const h = realm(),
    expressions = [],
    send = h.cdp.send.bind(h.cdp);
  h.cdp.send = async (method, params) => {
    if (method === 'Runtime.evaluate')
      expressions.push({ at: h.now(), expression: params.expression });
    return send(method, params);
  };
  const result = await runSimulatorGameplayBenchmark(
    { ...options(join(await temporary(t), 'out')), nativeReleaseWitness: true },
    dependencies(h, { failInput: true }),
  );
  assert.equal(result.failure.code, 'input-timeline-incomplete');
  assert.equal(result.analysis.status, 'partial');
  assert.equal(result.terminalNativeRelease, undefined);
  assert.equal(result.cleanup.nativeReleaseObserverReleased, true);
  const timingCalls = expressions.filter((row) => row.at >= h.result().armed.startMs);
  assert.equal(timingCalls.length, 2);
  assert.match(timingCalls[0].expression, /observer.abort\(\)/);
  assert.match(timingCalls[1].expression, /"action":"release"/);
  assert.ok(Object.values(h.listeners).every((listeners) => listeners.size === 0));
});

test('a still-pending input command forbids native-only cancellation suppression', async (t) => {
  const h = realm({ rejectEmptyCancel: true }),
    dep = dependencies(h),
    send = h.cdp.send.bind(h.cdp);
  let cancelCount = 0,
    settleEnd,
    terminal;
  h.cdp.send = async (method, params) => {
    if (method === 'Input.dispatchTouchEvent' && params.type === 'touchCancel') cancelCount++;
    const result = await send(method, params);
    if (method === 'Input.dispatchTouchEvent' && params.type === 'touchEnd')
      return new Promise((resolve) => {
        settleEnd = resolve;
      });
    return result;
  };
  dep.execute = async (timeline, dispatch, { startAt }) => {
    h.setTime(startAt);
    await dispatch(timeline.events[0].contacts);
    h.setTime(startAt + timeline.durationMs);
    terminal = dispatch([]);
    await Promise.resolve();
    await assert.rejects(dispatch.release(), { code: 'cdp-command-rejected' });
    return { success: false, failure: 'unsettled input', unsettledEvents: 1 };
  };
  const result = await runSimulatorGameplayBenchmark(
    { ...options(join(await temporary(t), 'out')), nativeReleaseWitness: true },
    dep,
  );
  settleEnd({});
  await terminal;
  assert.equal(cancelCount, 2);
  assert.equal(result.terminalNativeRelease.samples[0].touch.nativeReleased, true);
  assert.equal(result.terminalNativeRelease.samples[0].wire.pendingWireCommands, 1);
  assert.equal(result.terminalNativeRelease.outcome, 'native-release-unproven');
  assert.equal(result.inputCleanup.releaseConfirmed, false);
  assert.equal(result.analysis.status, 'partial');
});

test('post-window async observations must resolve through landing before drain', async (t) => {
  const h = realm({ landingReads: 3, rejectEmptyCancel: true });
  const result = await runSimulatorGameplayBenchmark(
    options(join(await temporary(t), 'out')),
    dependencies(h),
  );
  assert.equal(result.success, true, JSON.stringify(result.failure));
  const reads = h.log.filter((row) => row.kind === 'resolved-player');
  assert.deepEqual(
    reads.map((row) => row.grounded),
    [false, false, false, true],
  );
  assert.equal(result.releaseWitness.player.grounded, true);
  assert.equal(result.after.player.grounded, true);
  assert.ok(h.log.indexOf(reads.at(-1)) < h.log.findIndex((row) => row.kind === 'drain'));
});

test('truthy non-boolean grounded values cannot admit a release witness', async (t) => {
  const h = realm({ landingValue: 'true' });
  const result = await runSimulatorGameplayBenchmark(
    options(join(await temporary(t), 'out')),
    dependencies(h),
  );
  assert.equal(result.success, false);
  assert.equal(result.failure.code, 'post-window-release-timeout');
  assert.equal(result.releaseWitness.player.grounded, 'true');
  assert.equal(h.result().drained, false);
});

test('CDP rejection keeps the native message and detail for input-cleanup diagnosis', async () => {
  const OriginalWebSocket = globalThis.WebSocket;
  const nativeError = {
    code: -32602,
    message: 'Must send a TouchStart first to start a new touch.',
    data: 'touchCancel',
  };
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(bytes) {
      const request = JSON.parse(bytes);
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ id: request.id, error: nativeError }),
          }),
        ),
      );
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.dispatchEvent(new Event('close')));
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const cdp = await connectCdp('ws://offline-fixture');
    await assert.rejects(
      cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }),
      (error) =>
        error.code === 'cdp-command-rejected' &&
        error.message === nativeError.message &&
        assert.deepEqual(error.detail.nativeError, nativeError) === undefined,
    );
    assert.equal(await cdp.close(), true);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});
