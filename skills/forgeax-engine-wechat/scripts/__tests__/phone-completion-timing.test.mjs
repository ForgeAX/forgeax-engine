import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { analyzeCompletionTiming } from '../analyze_phone_completion.mjs';
import { buildCompletionTimingFixture } from '../build_completion_timing_fixture.mjs';
import {
  createControlledCompletionFixture,
  runControlledCompletionScenarios,
} from '../completion_timing_fixture.mjs';
import { installPhoneCompletionTiming } from '../phone_completion_timing.mjs';

const sourceRoot = new URL('../../../../', import.meta.url);
const toolRoot = process.env.FORGEAX_TOOL_ROOT
  ? pathToFileURL(`${process.env.FORGEAX_TOOL_ROOT.replace(/\/$/, '')}/`)
  : sourceRoot;
const require = createRequire(await realpath(new URL('node_modules/tsup/dist/index.js', toolRoot)));
const { transform } = require('esbuild');
const originalSource = await readFile(
  new URL('packages/rhi-wgpu/src/internal/native-completion.ts', sourceRoot),
  'utf8',
);
const code = (await transform(originalSource, { loader: 'ts', format: 'cjs', target: 'es2022' }))
  .code;
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
function createDriver(target, now) {
  const exports = {};
  const realm = {
    module: { exports },
    exports,
    setTimeout: (...args) => target.setTimeout(...args),
    Date: { now },
  };
  vm.runInNewContext(code, realm);
  return realm.module.exports.driveNativeCompletion;
}
const setup = (options) => createControlledCompletionFixture(createDriver, options);
test('shared controlled realm scenarios preserve composition, Promise identity and restoration', async () => {
  const result = await runControlledCompletionScenarios(createDriver);
  assert.equal(result.status, 'passed');
  assert.equal(result.scenarios.length, 3);
});
test('late original timer followed by immediate ready is distinct from native pending', async () => {
  const f = setup();
  let polls = 0,
    frees = 0;
  const p = f.driver(
    () => ({
      poll() {
        polls++;
        return true;
      },
      free() {
        frees++;
      },
    }),
    Promise.resolve(),
  );
  await f.fire(20);
  await p;
  const r = (await f.observer.drain()).completionTiming;
  const lane = analyzeCompletionTiming(r).tickets[0];
  assert.deepEqual(f.delays, [0]);
  assert.equal(polls, 1);
  assert.equal(frees, 1);
  assert.deepEqual(lane.signals, {
    timerLate: true,
    nativePendingObserved: false,
    orderedDeliveryDelayed: false,
    rejected: false,
  });
  assert.equal(f.target.setTimeout, f.originalTimer);
  assert.equal(r.coverage.restored, true);
});
test('false polls preserve exact original 0/1ms scheduling and are not late timers', async () => {
  const f = setup();
  const answers = [false, false, true];
  let frees = 0;
  const p = f.driver(
    () => ({
      poll() {
        return answers.shift();
      },
      free() {
        frees++;
      },
    }),
    Promise.resolve(),
  );
  await f.fire(0);
  await f.fire(1);
  await f.fire(2);
  await p;
  const r = (await f.observer.drain()).completionTiming;
  const lane = analyzeCompletionTiming(r).tickets[0];
  assert.deepEqual(f.delays, [0, 1, 1]);
  assert.equal(frees, 1);
  assert.equal(lane.falsePollCount, 2);
  assert.deepEqual(lane.signals, {
    timerLate: false,
    nativePendingObserved: true,
    orderedDeliveryDelayed: false,
    rejected: false,
  });
});
test('ready native request can await the original FIFO predecessor without extra polls', async () => {
  const f = setup();
  let release;
  const previous = new Promise((r) => {
    release = r;
  });
  let settled = false;
  const p = f.driver(() => ({ poll: () => true, free() {} }), previous);
  p.then(() => {
    settled = true;
  });
  await f.fire(0);
  assert.equal(settled, false);
  f.at(30);
  release();
  await p;
  await flush();
  const lane = analyzeCompletionTiming((await f.observer.drain()).completionTiming).tickets[0];
  assert.equal(lane.readyToDriverResolvedMs, 30);
  assert.deepEqual(f.delays, [0]);
  assert.deepEqual(lane.signals, {
    timerLate: false,
    nativePendingObserved: false,
    orderedDeliveryDelayed: true,
    rejected: false,
  });
});
test('native throws, unavailable completion and bounded overflow remain explicit', async () => {
  const f = setup({ capacity: 16 });
  let n = 0;
  const failure = new Error('original-native-failure');
  const p = f.driver(
    () => ({
      poll() {
        if (++n > 8) throw failure;
        return false;
      },
      free() {},
    }),
    Promise.resolve(),
  );
  p.catch(() => {});
  for (let i = 0; i < 9; i++) await f.fire(i);
  await assert.rejects(p, (e) => e === failure);
  const r = (await f.observer.drain()).completionTiming;
  assert.equal(r.count, 16);
  assert.ok(r.overflow.dropped > 0);
  assert.equal(analyzeCompletionTiming(r).completeCoverage, false);
  assert.equal(f.target.setTimeout, f.originalTimer);
});
test('observes existing native GL status adaptation and restores the native method', async () => {
  const f = setup();
  let waits = 0,
    queries = 0,
    received;
  const nativeWait = function (_sync, flags, timeout) {
    assert.equal(this, context);
    assert.equal(flags, 0);
    assert.equal(timeout, 0);
    waits++;
    return 0x911c;
  };
  const context = { clientWaitSync: nativeWait };
  const host = {
    surfaces: [{}],
    readWasm: () => Promise.resolve(new Uint8Array()),
    instantiate(imports) {
      const fn = imports['./wgpu_wasm_bg.js'].__wbg_getSyncParameter_test;
      received = () => {
        const value = fn(context, {}, 0x9114);
        return value === 0x9118 && context.clientWaitSync({}, 0, 0) === 0x911c;
      };
      return Promise.resolve({ instance: { exports: {} } });
    },
  };
  await f.api.wrapHost(host).instantiate({
    './wgpu_wasm_bg.js': {
      __wbg_getSyncParameter_test() {
        queries++;
        return 0x9118;
      },
    },
  });
  const p = f.driver(() => ({ poll: () => received(), free() {} }), Promise.resolve());
  await f.fire(0);
  await p;
  const r = (await f.observer.drain()).completionTiming;
  assert.equal(queries, 1);
  assert.equal(waits, 1);
  assert.equal(context.clientWaitSync, nativeWait);
  assert.equal(r.coverage.syncImports, 1);
  assert.equal(r.coverage.restoredContexts, 1);
  assert.ok(r.events.some((e) => e.kind === 'client-wait-return' && e.value === 0x911c));
});
test('boundary tickets/timers and raw import indices remain partial and uninterpreted', () => {
  const capture = {
    schemaVersion: 'forgeax-phone-completion-timing/1',
    startMs: 0,
    endMs: 10,
    capacity: 16,
    coverage: { clockErrors: 0, unpairedSchedules: 0, syncImports: 1, restored: true },
    overflow: { dropped: 0 },
    events: [
      { ticket: 1, kind: 'timer-fire', timer: 10, atMs: 2, scheduledAtMs: -5, value: 0 },
      { ticket: 1, kind: 'sync-query-return', atMs: 2, value: 0x9118 },
      { ticket: 1, kind: 'poll-return', atMs: 2, value: 1 },
      { ticket: 1, kind: 'driver-resolved', atMs: 2 },
      { ticket: 2, kind: 'request-start', atMs: 3 },
      { ticket: 2, kind: 'timer-schedule', timer: 11, atMs: 3, scheduledAtMs: 3, value: 0 },
    ],
  };
  capture.events = capture.events.map((row) => ({
    timer: 0,
    value: null,
    scheduledAtMs: null,
    ...row,
  }));
  const result = analyzeCompletionTiming(capture);
  assert.equal(result.tickets[0].boundaryIncomplete, true);
  assert.deepEqual(result.tickets[0].incompleteTimerIds, [10]);
  assert.deepEqual(result.tickets[0].rawSyncImportReturnValues, [0x9118]);
  assert.equal(result.tickets[0].zeroTimeoutWaitsTimedOut, 0);
  assert.equal(result.tickets[1].boundaryIncomplete, true);
  assert.deepEqual(result.tickets[1].incompleteTimerIds, [11]);
  assert.equal(result.tickets[1].readyToDriverResolvedMs, null);
});

test('unknown native import ABI forwards all arguments and reports ineligible coverage', async () => {
  const f = setup();
  let received;
  const context = {
    clientWaitSync() {
      return 0x911c;
    },
  };
  const original = function (...args) {
    received = { receiver: this, args };
    return 17;
  };
  const host = {
    readWasm() {},
    instantiate(...args) {
      return args;
    },
  };
  const wrapped = f.api.wrapHost(host);
  const tail = { tail: true };
  const [imports, forwarded] = wrapped.instantiate(
    { './wgpu_wasm_bg.js': { __wbg_getSyncParameter_test: original } },
    tail,
  );
  assert.equal(forwarded, tail);
  const args = [context, {}, 0x9114, 'extra'];
  const receiver = {};
  assert.equal(imports['./wgpu_wasm_bg.js'].__wbg_getSyncParameter_test.apply(receiver, args), 17);
  assert.equal(received.receiver, receiver);
  assert.deepEqual(received.args, args);
  const capture = await f.observer.drain();
  assert.equal(capture.completionTiming.coverage.abiErrors, 1);
});

test('failed timer installation rolls back observer composition', () => {
  const observer = {
    observeOptions: (v) => v,
    arm: () => ({ startMs: 0, endMs: 10 }),
    drain: async () => ({}),
  };
  const methods = { ...observer },
    target = {};
  Object.defineProperty(target, 'setTimeout', { value() {}, writable: false, configurable: false });
  assert.throws(() => installPhoneCompletionTiming(observer, { now: () => 0, target }), TypeError);
  assert.deepEqual(observer, methods);
});

test('standalone game-realm fixture bundles actual driver without Node or global timers', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'forgeax-controlled-completion-'));
  try {
    const out = join(temp, 'fixture');
    const manifest = await buildCompletionTimingFixture({
      engineSource: fileURLToPath(sourceRoot),
      toolRoot: fileURLToPath(toolRoot),
      out,
    });
    const originalTimer = () => {
      throw new Error('Game global timer must never run');
    };
    const realm = { setTimeout: originalTimer };
    vm.runInNewContext(await readFile(join(out, 'completion-fixture.js'), 'utf8'), realm);
    await assert.rejects(realm.__forgeaxControlledCompletion.run(), /Pause and drain/);
    const result = await realm.__forgeaxControlledCompletion.run({ gamePaused: true });
    assert.equal(result.status, 'passed');
    assert.equal(result.driverSourceSha256, manifest.driverSourceSha256);
    assert.equal(realm.setTimeout, originalTimer);
    assert.equal(result.scenarios.length, 3);
    const autoRealm = { setTimeout: originalTimer };
    vm.runInNewContext(await readFile(join(out, 'game.js'), 'utf8'), autoRealm);
    await new Promise((resolve) => setImmediate(resolve));
    const auto = autoRealm.__forgeaxControlledCompletionResult;
    assert.equal(auto.status, 'passed');
    assert.equal(auto.driverSourceSha256, manifest.driverSourceSha256);
    assert.equal(auto.executionRealm, 'standalone-minigame-no-app-or-gpu');
    assert.equal(auto.scenarios.length, 3);
    assert.equal(autoRealm.setTimeout, originalTimer);
    assert.equal(manifest.standaloneGame.entry, 'game.js');
    const failureRealm = {
      Float64Array: class {
        constructor() {
          throw new Error('controlled-storage-failure');
        }
      },
    };
    vm.runInNewContext(await readFile(join(out, 'game.js'), 'utf8'), failureRealm);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failureRealm.__forgeaxControlledCompletionResult.status, 'failed');
    assert.match(
      failureRealm.__forgeaxControlledCompletionResult.error,
      /controlled-storage-failure/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
