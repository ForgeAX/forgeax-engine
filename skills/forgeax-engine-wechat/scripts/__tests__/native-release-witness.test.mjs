import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { nativeReleaseWitness } from '../fixtures/gameplay-benchmark/native-release-witness.mjs';

// Public-event lifecycle contracts only; this realm is not native-device evidence.
function realm() {
  const listeners = Object.fromEntries(
    ['Start', 'Move', 'End', 'Cancel'].map((n) => [n, new Set()]),
  );
  const wx = {};
  for (const name of Object.keys(listeners)) {
    wx[`onTouch${name}`] = (listener) => listeners[name].add(listener);
    wx[`offTouch${name}`] = (listener) => listeners[name].delete(listener);
  }
  const game = { wx, __forgeaxGameInspection: {}, __gameplayBenchmark: {} };
  const context = vm.createContext({ GameGlobal: { __gameContextWindow: game }, performance });
  const call = (action, token = 'run-1') =>
    JSON.parse(
      JSON.stringify(
        vm.runInContext(`(${nativeReleaseWitness})(${JSON.stringify({ action, token })})`, context),
      ),
    );
  const emit = (name, changed, active) => {
    const points = (ids) => ids.map((identifier) => ({ identifier }));
    for (const listener of listeners[name])
      listener({ changedTouches: points(changed), touches: points(active), timeStamp: 100 });
  };
  return { listeners, wx, game, context, call, emit };
}

test('public End callbacks prove 2 → 1 → 0 native contacts independently of CDP IDs', () => {
  const h = realm();
  assert.equal(h.call('install').installed, true);
  h.emit('Start', [101, 205, 309], [101, 205, 309]);
  h.emit('End', [101], [205, 309]);
  assert.equal(h.call('snapshot').nativeReleased, false);
  h.emit('End', [205], [309]);
  h.emit('End', [309], []);
  const s = h.call('snapshot');
  assert.equal(s.nativeReleased, true);
  assert.equal(s.failure, null);
  assert.deepEqual(
    s.events.map((row) => row.active.length),
    [3, 2, 1, 0],
  );
  assert.deepEqual(s.events.at(-1).changed, [309]);
  assert.equal(s.events.at(-1).nativeTimestamp, 100);
  assert.equal(h.listeners.Move.size, 0);
});

test('no Start, an unended Start and an End without Start never prove release', () => {
  const h = realm();
  h.call('install');
  assert.equal(h.call('snapshot').nativeReleased, false);
  assert.equal(h.call('snapshot').starts, 0);
  h.emit('Start', [101], [101]);
  assert.equal(h.call('snapshot').nativeReleased, false);
  h.call('release');
  h.call('install');
  h.emit('End', [101], []);
  assert.equal(h.call('snapshot').nativeReleased, false);
  assert.equal(h.call('snapshot').failure, 'native-end-without-start');
});

test('a bounded ring evicts history without losing final active-contact evidence', () => {
  const h = realm();
  h.call('install');
  for (let i = 0; i < 1000; i++) {
    h.emit('Start', [101], [101]);
    h.emit('End', [101], []);
  }
  const s = h.call('snapshot');
  assert.equal(s.events.length, 16);
  assert.equal(s.eventCount, 2000);
  assert.equal(s.discardedEvents, 1984);
  assert.equal(s.nativeReleased, true);
  assert.equal(s.failure, null);
});

test('the first duplicate Start retains its raw touch fields and prior active IDs permanently', () => {
  const h = realm();
  h.call('install');
  h.emit('Start', [2], [2]);
  const event = {
    changedTouches: [{ identifier: 2, clientX: 12.5, clientY: 34, pageX: 12.5, pageY: 34 }],
    touches: [{ identifier: 2, clientX: 12.5, clientY: 34 }],
    timeStamp: 1234.5,
  };
  for (const listener of h.listeners.Start) listener(event);
  const first = h.call('snapshot');
  assert.equal(first.failure, 'native-release-duplicate-start');
  assert.equal(first.nativeReleased, false);
  assert.equal(first.eventCount, 1, 'The invalid callback does not become accepted history');
  assert.equal(first.firstAnomaly.code, 'native-release-duplicate-start');
  assert.equal(first.firstAnomaly.phase, 'Start');
  assert.deepEqual(first.firstAnomaly.priorActive, [2]);
  assert.deepEqual(first.firstAnomaly.changedTouches.points, event.changedTouches);
  assert.equal(first.firstAnomaly.nativeTimestamp, 1234.5);
  assert.ok(Number.isFinite(first.firstAnomaly.pageNowMs));
  assert.ok(Number.isFinite(first.firstAnomaly.atUtcMs));
  event.changedTouches[0].clientX = 999;
  h.emit('End', [2], []);
  h.emit('Start', [3], [3]);
  assert.deepEqual(h.call('snapshot').firstAnomaly, first.firstAnomaly);
  const released = h.call('release');
  assert.equal(released.released, true);
  assert.equal(released.nativeReleased, false);
  assert.equal(released.failure, 'native-release-duplicate-start');
  assert.deepEqual(released.firstAnomaly, first.firstAnomaly);
});

test('first-anomaly payload storage has bounded contacts and explicit truncation', () => {
  const h = realm();
  h.call('install');
  const points = Array.from({ length: 100 }, () => ({
    identifier: 'x'.repeat(10000),
    clientX: 1,
    clientY: 2,
  }));
  for (const listener of h.listeners.Start) listener({ changedTouches: points, touches: points });
  const first = h.call('snapshot').firstAnomaly;
  assert.equal(first.changedTouches.length, 100);
  assert.equal(first.changedTouches.truncated, true);
  assert.equal(first.changedTouches.points.length, 8);
  assert.equal(first.touches.points.length, 8);
  assert.equal(first.changedTouches.points[0].identifier.length, 10000);
  assert.equal(first.changedTouches.points[0].identifier.prefix.length, 128);
  assert.ok(JSON.stringify(first).length < 6000);
});

test('malformed, oversized, duplicate and inconsistent native batches fail closed', () => {
  const cases = [
    { changedTouches: [{ identifier: 1 }] },
    { changedTouches: [{ identifier: '1' }], touches: [] },
    { changedTouches: Array.from({ length: 9 }, (_, identifier) => ({ identifier })), touches: [] },
    { changedTouches: [{ identifier: 1 }, { identifier: 1 }], touches: [{ identifier: 1 }] },
    { changedTouches: [{ identifier: 1 }], touches: [] },
  ];
  for (const event of cases) {
    const h = realm();
    h.call('install');
    for (const listener of h.listeners.Start) listener(event);
    h.emit('Start', [101], [101]);
    h.emit('End', [101], []);
    const s = h.call('snapshot');
    assert.ok(s.failure);
    assert.equal(s.nativeReleased, false);
    assert.ok(s.active.length <= 8);
  }
});

test('stale tokens, replaced realm/API/inspection owner cannot attest current input', () => {
  for (const change of [
    (h) => {
      h.context.GameGlobal.__gameContextWindow = { ...h.game };
    },
    (h) => {
      h.game.wx = { ...h.wx };
    },
    (h) => {
      h.wx.onTouchEnd = () => {};
    },
    (h) => {
      h.game.__forgeaxGameInspection = {};
    },
    (h) => {
      h.game.__gameplayBenchmark = {};
    },
    (h) => {
      h.context.performance = { now: () => 0 };
    },
  ]) {
    const h = realm();
    h.call('install');
    h.emit('Start', [101], [101]);
    h.emit('End', [101], []);
    assert.equal(h.call('snapshot', 'stale').failure.code, 'native-release-witness-replaced');
    change(h);
    assert.equal(h.call('snapshot').nativeReleased, false);
    assert.equal(h.call('snapshot').failure, 'native-release-owner-changed');
    assert.equal(h.call('release').released, true);
    assert.ok(Object.values(h.listeners).every((listeners) => listeners.size === 0));
  }
});

test('release removes only its own listeners; native Cancel and cleanup failure remain distinct', () => {
  const h = realm(),
    external = () => {};
  h.listeners.End.add(external);
  h.call('install');
  assert.equal(h.call('install').failure.code, 'native-release-witness-already-present');
  h.emit('Start', [101], [101]);
  h.emit('Cancel', [101], []);
  assert.equal(h.call('snapshot').nativeReleased, true);
  const result = h.call('release');
  assert.equal(result.released, true);
  assert.equal(
    result.nativeReleased,
    false,
    'A retired subscription is not current input evidence',
  );
  assert.deepEqual([...h.listeners.End], [external]);
  assert.equal(h.context.__forgeaxNativeReleaseWitness, undefined);
  h.wx.offTouchEnd = () => {
    throw new Error('native removal failed');
  };
  h.call('install');
  assert.equal(h.call('release').released, false);
  assert.equal(h.call('snapshot').failure, 'native-release-observer-cleanup-failed');
});

test('partial installation removes acquired subscriptions and aggregate contacts remain bounded', () => {
  const h = realm();
  const subscribe = h.wx.onTouchEnd;
  h.wx.onTouchEnd = (listener) => {
    subscribe(listener);
    throw new Error('registration failed');
  };
  assert.equal(h.call('install').failure.code, 'native-release-install-failed');
  assert.ok(Object.values(h.listeners).every((listeners) => listeners.size === 0));
  assert.equal(h.context.__forgeaxNativeReleaseWitness, undefined);
  h.wx.onTouchEnd = subscribe;
  assert.equal(h.call('install', '').failure.code, 'native-release-token-invalid');
  h.call('install');
  h.emit('Start', [1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8]);
  h.emit('Start', [9], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(h.call('snapshot').failure, 'native-release-active-list-mismatch');
  assert.equal(h.call('snapshot').active.length, 8);
  assert.equal(h.call('snapshot').nativeReleased, false);
});
