import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { bundlePhoneDiagnostic } from './bundle_phone_gl_link.mjs';

const prefix = await bundlePhoneDiagnostic('startup');
const source = { manifestSha256: 'a'.repeat(64), entrySha256: 'b'.repeat(64) };
function ready(completed, presented, changes = {}) {
  return { phase: 'ready', state: 'alive', generation: 1, completed, presented,
    frame: { frameId: completed + 1, deviceGeneration: 0 },
    lastCompletion: { frameId: completed, deviceGeneration: 0, presentation: 'ready' }, ...changes };
}
function fixture(initial, options = {}, methods = {}, configureConsole, configureError, configureWx, configureContext) {
  let time = 0, next = 0, state = initial;
  const timers = new Map(), handlers = {}, requests = [], saved = [], logs = [], consoleCalls = [];
  const consoleObject = { info: (...args) => logs.push(args), error(...args) {
    consoleCalls.push({ receiver: this, args }); return 'original-console-result';
  } };
  configureConsole?.(consoleObject);
  const originalErrorDescriptor = Object.getOwnPropertyDescriptor(consoleObject, 'error');
  const wx = {
    env: { USER_DATA_PATH: '/private' },
    getFileSystemManager: () => ({ mkdirSync() {}, writeFileSync(path, body) { saved.push({ path, body }); } }),
    request(request) {
      if (JSON.parse(request.data).kind !== 'forgeax-phone-startup-checkpoint')
        assert.equal(Object.keys(handlers).length, 0, 'owned events must be released before terminal transfer');
      requests.push(request);
      return { abort() {} };
    },
  };
  configureWx?.(wx);
  for (const kind of ['Error', 'UnhandledRejection', 'Hide']) {
    wx['on' + kind] = callback => { handlers[kind] = callback; };
    wx['off' + kind] = callback => { if (handlers[kind] === callback) delete handlers[kind]; };
  }
  const context = {
    wx, Date: { now: () => time },
    console: consoleObject,
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    __forgeaxGameInspection: { ...methods, renderer() { return typeof state === 'function' ? state() : state; } },
  };
  const realmError = runInNewContext('Error', context);
  configureContext?.(context);
  configureError?.(realmError);
  const originalStackDescriptor = Object.getOwnPropertyDescriptor(realmError, 'stackTraceLimit');
  runInNewContext(prefix.replace('__FORGEAX_PROBE_OPTIONS__', JSON.stringify({ source, runId: 'c'.repeat(32), deadlineMs: 20000, pollMs: 250, ...options })), context);
  return { context, handlers, timers, requests, saved, logs, consoleCalls, originalErrorDescriptor, realmError, originalStackDescriptor,
    state(value) { state = value; },
    report() { return JSON.parse(saved[0].body); },
    advance(end) {
      let task;
      while ((task = [...timers].sort((a, b) => a[1].at - b[1].at)[0]) && task[1].at <= end) {
        timers.delete(task[0]); time = task[1].at; task[1].callback();
      }
      time = end;
    },
  };
}

const panicText = "panicked at third_party/wgpu/wgpu-core/src/storage.rs:113:24:\nTexture is no longer alive";

test('keyboard diagnosis waits a bounded ready window and releases before terminal export', () => {
  const f = fixture(ready(1, 1), { observeKeyboard: true, deadlineMs: 120000 },
    { ui: () => ({ ok: true, value: { focused: 'height' } }) }, undefined, undefined,
    wx => { wx.showKeyboard = () => 7; wx.hideKeyboard = () => {}; });
  f.state(ready(70, 70)); f.advance(500);
  assert.equal(f.saved.length, 0);
  assert.equal(f.context.wx.showKeyboard(), 7);
  f.advance(60000);
  assert.equal(f.report().reason, 'scene-presented');
  assert.equal(f.report().keyboard.events[0].operation, 'showKeyboard');
  assert.equal(f.report().keyboard.ended, true);
});

test('retains native weak-reference capability absence without installing a substitute', () => {
  const f = fixture({ phase: 'scene' }, {}, {}, undefined, undefined, undefined,
    context => { context.WeakRef = undefined; context.FinalizationRegistry = undefined; });
  f.advance(20000);
  assert.deepEqual(f.report().runtimeFeatures, { weakRef: 'undefined', finalizationRegistry: 'undefined' });
  assert.equal(f.context.WeakRef, undefined);
  assert.equal(f.context.FinalizationRegistry, undefined);
});

test('opt-in native phase UI updates before timers and restores the original logger', () => {
  const loading = [];
  let hidden = 0;
  const f = fixture({ phase: 'graphics' }, { showStartupProgress: true }, {}, undefined, undefined,
    wx => { wx.showLoading = value => loading.push(value.title); wx.hideLoading = () => { hidden++; }; });
  f.context.console.info('[forgeax.wechat.startup]', JSON.stringify({ generation: 1, phase: 'graphics' }));
  assert.equal(loading.at(-1), 'cccccc:graphics');
  assert.equal(f.logs.at(-1)[0], '[forgeax.wechat.startup]');
  const replacement = () => {};
  f.context.console.info = replacement;
  f.advance(20000);
  assert.equal(f.context.console.info, replacement, 'preserve a later logger owner');
  assert.equal(hidden, 1);
  assert.equal(f.report().nativePhaseUi.updates, 2);
});

test('native phase UI composes and restores the existing Codec asset trace sink', () => {
  const loading = [], events = [];
  const prior = event => { events.push(event.phase); return 'prior-result'; };
  const f = fixture({ phase: 'scene' }, { showStartupProgress: true }, {}, undefined, undefined,
    wx => { wx.showLoading = value => loading.push(value.title); wx.hideLoading = () => {}; },
    context => { context.__forgeaxAssetLoadTrace = prior; });
  assert.equal(f.context.__forgeaxAssetLoadTrace({ phase: 'codec.basis.wasm.factory.start' }), 'prior-result');
  assert.equal(loading.at(-1), 'cccccc:factory-start');
  assert.deepEqual(events, ['codec.basis.wasm.factory.start']);
  f.advance(20000);
  assert.equal(f.context.__forgeaxAssetLoadTrace, prior);
});

test('native phase UI identifies a fresh diagnostic run of the same publication', () => {
  const loading = [];
  const runId = '123abc00000000000000000000000000';
  const f = fixture({ phase: 'scene' }, { showStartupProgress: true, runId }, {}, undefined, undefined,
    wx => { wx.showLoading = value => loading.push(value.title); wx.hideLoading = () => {}; });
  assert.equal(loading[0], '123abc:observer');
  f.advance(20000);
  assert.equal(f.report().runId, runId);
});

test('native phase UI retains the latest phase and marks its bounded display limit', () => {
  const loading = [];
  const f = fixture({ phase: 'scene' }, { showStartupProgress: true }, {}, undefined, undefined,
    wx => { wx.showLoading = value => loading.push(value.title); wx.hideLoading = () => {}; });
  for (let i = 0; i < 80; i++) {
    f.context.console.info('[forgeax.wechat.startup]', i % 2 ? 'scene' : 'graphics');
  }
  f.context.console.info('[forgeax.wechat.startup]', 'ready');
  assert.equal(loading.length, 32);
  assert.equal(loading.at(-1), 'cccccc:phase-cap');
  f.advance(20000);
  assert.equal(f.report().nativePhaseUi.lastPhase, 'ready');
  assert.equal(f.report().nativePhaseUi.status, 'capped');
});

test('opt-in result UI shows the retained startup cause after observation has ended', () => {
  const modals = [];
  const f = fixture({ phase: 'failed', startupError: { code: 'asset-fetch-failed' } },
    { showFrameResult: true }, {}, undefined, undefined,
    wx => { wx.showModal = value => modals.push(value); });
  assert.equal(modals.length, 1);
  assert.equal(Object.keys(f.handlers).length, 0);
  const result = JSON.parse(modals[0].content);
  assert.equal(result.reason, 'startup-failed');
  assert.equal(result.phase, 'failed');
  assert.equal(result.startupError.code, 'asset-fetch-failed');
  assert.equal(f.report().reason, 'startup-failed');
});

test('startup diagnosis includes native package failures, plugin waits and bounded asset traces without UI flags', () => {
  let nativeRequest;
  const fibers = { fibers: [{ name: 'game-3d/scene', state: 'loading', missingServices: [] }], truncated: false };
  const f = fixture({ phase: 'scene' }, {}, { plugins: () => fibers }, undefined, undefined,
    wx => { wx.loadSubpackage = options => { nativeRequest = options; }; });
  f.context.wx.loadSubpackage({ name: 'payload' });
  const native = Object.defineProperty({}, 'errMsg', { get: () => 'module not found' });
  nativeRequest.fail(native);
  f.context.__forgeaxAssetLoadTrace({ phase: 'asset.decode.begin', guid: 'original-guid' });
  f.advance(2000);
  for (let i = 0; i < 70; i++) f.context.__forgeaxAssetLoadTrace({ phase: 'package.slot.admitted', packageUrl: 'https://forgeax.package/a.pack.json', detail: { index: i } });
  f.advance(20000);
  const report = f.report();
  assert.equal(report.packageIo.recent[0].error.value.errMsg, 'module not found');
  assert.deepEqual(report.observation.plugins, fibers);
  assert.equal(report.assetTrace.recent.length, 64);
  assert.equal(report.assetTrace.dropped, 7);
  assert.equal(report.assetTrace.maximumEventGap.elapsedMs, 2000);
  assert.equal(report.assetTrace.maximumEventGap.before.phase, 'asset.decode.begin');
  assert.equal(report.assetTrace.maximumEventGap.after.phase, 'package.slot.admitted');
  assert.equal(report.assetTrace.packageReads.rows.length, 1);
  assert.equal(report.assetTrace.packageReads.rows[0].admitted, 70);
  assert.equal(report.assetTrace.recent.at(-1).detail.index, 69);
  assert.equal(f.context.__forgeaxAssetLoadTrace, undefined);
});

test('source-bound checkpoints precede the terminal report and stop on completion', () => {
  const f = fixture({ phase: 'scene' }, { reportUrl: 'http://127.0.0.1:19143/checkpoints' });
  f.advance(15000);
  assert.equal(f.requests.length, 3);
  const first = JSON.parse(f.requests[0].data);
  assert.equal(first.kind, 'forgeax-phone-startup-checkpoint');
  assert.equal(first.sequence, 1);
  assert.equal(first.runId, 'c'.repeat(32));
  assert.equal(first.finishedAt, undefined);
  assert.equal(first.reason, undefined);
  assert.equal(first.sceneFrames.passed, false);
  assert.equal(f.saved.length, 0, 'periodic transfer does not create native artifact directories');
  f.advance(20000);
  assert.equal(f.requests.length, 4);
  assert.equal(JSON.parse(f.requests[3].data).reason, 'deadline');
  f.advance(30000);
  assert.equal(f.requests.length, 4);
});

test('checkpoint request failures remain visible in the bounded terminal receipt', () => {
  const f = fixture({ phase: 'scene' }, { deadlineMs: 200000, reportUrl: 'http://127.0.0.1:19143/checkpoints' });
  f.advance(5000);
  f.requests[0].fail({ errMsg: 'request:fail connection refused' });
  f.advance(200000);
  const report = f.report();
  assert.equal(report.reason, 'deadline');
  assert.equal(report.checkpoints.attempted, 32);
  assert.equal(report.checkpoints.transfers.length, 32);
  assert.equal(report.checkpoints.transfers[0].transfer.status, 'failed');
  assert.equal(report.checkpoints.transfers[0].transfer.error, 'request:fail connection refused');
  assert.equal(report.checkpoints.transfers[1].transfer.status, 'timeout');
  assert.equal(f.requests.length, 33);
});

test('the explicit dependency-free package control terminates without scene acceptance', () => {
  const state = { phase: 'package-entry-control', state: 'initializing' };
  for (const mode of ['entry', 'data', 'empty']) {
    const f = fixture(state, { packageControl: mode });
    assert.equal(f.saved.length, 1);
    assert.equal(f.report().reason, 'package-entry-control');
    assert.equal(f.report().packageControl, mode);
    assert.equal(f.report().sceneFrames.passed, false);
    assert.equal(f.report().observation.renderer.phase, 'package-entry-control');
  }
  const ordinary = fixture(state);
  assert.equal(ordinary.saved.length, 0, 'ordinary startup does not infer control mode from a phase');
});

test('ordinary startup retains bounded WASM instantiation timing without a progress UI', async () => {
  const result = Promise.resolve({ module: 'native-other-module' });
  const owner = { instantiate: () => result };
  const f = fixture({ phase: 'scene' }, {}, {}, undefined, undefined, undefined,
    context => { context.WXWebAssembly = owner; });
  assert.equal(owner.instantiate('payload/wasm/rapier3d.wasm.br', {}), result);
  await result;
  await new Promise(resolve => setImmediate(resolve));
  f.advance(20000);
  assert.deepEqual(f.report().wasmLoads.events, [
    { path: 'payload/wasm/rapier3d.wasm.br', phase: 'load', at: 0 },
    { path: 'payload/wasm/rapier3d.wasm.br', phase: 'done', at: 0 },
  ]);
  assert.equal(f.report().wasmLoads.limit, 32);
  const bounded = fixture({ phase: 'scene' }, {}, {}, undefined, undefined, undefined,
    context => { context.WXWebAssembly = { instantiate: () => result }; });
  const loads = [];
  for (let i = 0; i < 20; i++) loads.push(bounded.context.WXWebAssembly.instantiate('payload/wasm/rapier3d.wasm.br', {}));
  await Promise.all(loads);
  await new Promise(resolve => setImmediate(resolve));
  bounded.advance(20000);
  assert.equal(bounded.report().wasmLoads.events.length, 32);
  assert.equal(bounded.report().wasmLoads.dropped, 8);
});

test('an unavailable result dialog cannot replace the original startup failure', () => {
  const f = fixture({ phase: 'failed', startupError: { code: 'original-failure' } },
    { showFrameResult: true }, {}, undefined, undefined,
    wx => { wx.showModal = () => { throw Error('native dialog unavailable'); }; });
  assert.equal(f.report().observation.renderer.startupError.code, 'original-failure');
});
const wasmStack = '    at wgpu_core::storage::Storage::get (wasm://wasm/wgpu_wasm.wasm-015fe636:3617609:1)\n    at wasm-function[3210]:0x373426';
const panicMessage = panicText + '\n\nStack:\n\nError\n    at error (https://private-host.invalid/game.js?token=private-query:1:2)\n' + wasmStack + '\n\n';

test('bundled startup lifetime is explicit, source-bound and stops before report transfer', async () => {
  for (const enabled of [false, true]) {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const native = { instance: { exports: Object.freeze({ memory, rhiwgpuqueue_submit() {},
      rhiwgpuqueue_writeBuffer() {}, __wbg_rhiwgpucommandencoder_free() {} }) }, module: {} };
    const owner = { instantiate: async () => native }, original = owner.instantiate;
    const f = fixture({ phase: 'scene' }, { observeWasmLifetime: enabled,
      reportUrl: 'http://127.0.0.1:19143/startup-test' }, {}, undefined, undefined, undefined,
    context => { context.WXWebAssembly = owner; context.FinalizationRegistry = undefined; });
    const exports = (await owner.instantiate('wgpu.wasm', { './wgpu_wasm_bg.js': {} })).instance.exports;
    exports.rhiwgpuqueue_submit(); exports.__wbg_rhiwgpucommandencoder_free(48, 1);
    memory.grow(1); f.advance(2000); f.handlers.Hide();
    const report = f.report(), observed = report.nativeWasmErrors;
    assert.deepEqual(report.source, source);
    assert.equal(owner.instantiate, original);
    assert.equal(exports.rhiwgpuqueue_submit, native.instance.exports.rhiwgpuqueue_submit);
    if (enabled) {
      assert.equal(observed.lifetime.finalizationRegistry.type, 'undefined');
      const lifetime = observed.instances[0].lifetime;
      assert.equal(lifetime.sampler, 'stopped');
      assert.deepEqual(lifetime.samples.map(row => row.at), [0, 1000, 2000]);
      assert.equal(lifetime.samples[2].memory.byteLength, 131072);
      assert.equal(lifetime.samples[2].calls.submit, 1);
      assert.equal(lifetime.samples[2].frees.finalizer, 1);
    } else {
      assert.equal(observed.lifetime, undefined);
      assert.equal(report.nativeGlErrors.lifetime, undefined);
      assert.equal(report.lifetimeSerialization, undefined);
    }
    const stopped = JSON.stringify(f.context.__forgeaxPhoneStartupReport.nativeWasmErrors);
    exports.rhiwgpuqueue_submit(); f.advance(10000);
    assert.equal(JSON.stringify(f.context.__forgeaxPhoneStartupReport.nativeWasmErrors), stopped);
    assert.equal(f.requests[0].data, f.saved[0].body);
  }
});

test('lifetime passively counts late GL fences inside and outside synchronous submit with fixed enum bins', async () => {
  const calls = [], sync = new Proxy({}, { get() { throw new Error('never inspect or retain sync'); } });
  const failure = new Error('native query threw');
  let exports, queryValue = 0x9118, waitValue = 0x911b, fenceValue = sync, throwQuery = false;
  const gl = {
    fenceSync(condition, flags) { calls.push(['fence', this, condition, flags]); return fenceValue; },
    deleteSync(value) { assert.equal(value, sync); calls.push(['delete']); },
    getSyncParameter(value, pname) { assert.equal(value, sync); calls.push(['query', pname]); if (throwQuery) throw failure; return queryValue; },
    clientWaitSync(value, flags, timeout) { assert.equal(value, sync); calls.push(['wait', flags, timeout]); return waitValue; },
  };
  const native = { instance: { exports: Object.freeze({
    memory: new WebAssembly.Memory({ initial: 1 }), rhiwgpuqueue_writeBuffer() {},
    rhiwgpuqueue_submit(nested) {
      assert.equal(gl.fenceSync(0x9117, 0), fenceValue);
      assert.equal(gl.getSyncParameter(sync, 0x9114), queryValue);
      if (nested) exports.rhiwgpuqueue_submit(false);
      gl.deleteSync(sync);
    },
  }) }, module: {} };
  const owner = { instantiate: async () => native };
  const f = fixture({ phase: 'scene' }, { observeWasmLifetime: true, deadlineMs: 600000 }, {}, undefined, undefined,
    wx => { wx.createCanvas = () => ({ getContext: () => gl }); }, context => { context.WXWebAssembly = owner; });
  f.context.wx.createCanvas().getContext('webgl2');
  exports = (await owner.instantiate('wgpu.wasm', { './wgpu_wasm_bg.js': {} })).instance.exports;
  for (let i = 0; i < 6005; i++) exports.rhiwgpuqueue_submit(false);
  queryValue = 0x9119; exports.rhiwgpuqueue_submit(true);
  throwQuery = true;
  assert.throws(() => exports.rhiwgpuqueue_submit(false), error => error === failure);
  throwQuery = false;
  gl.getSyncParameter(sync, 0x9114); // Depth must have restored after the throw.
  queryValue = 'private-status'; gl.getSyncParameter(sync, 0x9114);
  gl.getSyncParameter(sync, 0x9113); // Not SYNC_STATUS.
  for (waitValue of [0x911a, 0x911b, 0x911c, 0x911d, 'private-wait']) gl.clientWaitSync(sync, 0, 0);
  fenceValue = null; assert.equal(gl.fenceSync(0x9117, 0), null); gl.deleteSync(sync);
  assert.equal(calls.length, 6007 * 3 + 2 + 3 + 5 + 2, 'no extra query/wait or maintenance calls');
  f.advance(2000); f.handlers.Hide();
  const report = f.report(), lifetime = report.nativeGlErrors.contexts[0].lifetime;
  assert.equal(report.nativeGlErrors.lifetime.qualification, 'diagnostic-only');
  assert.deepEqual(lifetime.insideSubmit.fenceSync, { calls: 6008, nonNull: 6008, null: 0, other: 0, throws: 0 });
  assert.deepEqual(lifetime.insideSubmit.deleteSync, { calls: 6007, throws: 0 });
  assert.deepEqual(lifetime.insideSubmit.getSyncParameter, { calls: 6008, signaled: 2, unsignaled: 6005, other: 0, throws: 1 });
  assert.deepEqual(lifetime.outsideSubmit.getSyncParameter, { calls: 2, signaled: 1, unsignaled: 0, other: 1, throws: 0 });
  assert.deepEqual(lifetime.outsideSubmit.clientWaitSync, { calls: 5, alreadySignaled: 1, timeoutExpired: 1,
    conditionSatisfied: 1, waitFailed: 1, other: 1, throws: 0 });
  assert.equal(lifetime.outsideSubmit.fenceSync.null, 1);
  assert.equal(lifetime.sampler, 'stopped');
  assert.equal(lifetime.samples[2].insideSubmit.deleteSync.calls, 6007);
  assert.equal(report.nativeGlErrors.contexts[0].fenceResults.getSyncParameter.observed, 256,
    'legacy first-256 observer remains unchanged');
  assert.ok(!f.saved[0].body.includes('private-status')); assert.ok(!f.saved[0].body.includes('private-wait'));
});

test('GL lifetime samples remain bounded and release stops retained wrappers while preserving replacements', () => {
  const gl = { fenceSync() { return {}; }, getSyncParameter() { return 0x9119; } };
  const f = fixture({ phase: 'scene' }, { observeWasmLifetime: true, deadlineMs: 600000 }, {}, undefined, undefined,
    wx => { wx.createCanvas = () => ({ getContext: () => gl }); });
  f.context.wx.createCanvas().getContext('webgl2');
  gl.fenceSync();
  const wrapper = gl.getSyncParameter, replacement = () => 0x9118;
  f.advance(130000);
  gl.getSyncParameter = replacement;
  f.handlers.Hide();
  const report = f.report(), lifetime = report.nativeGlErrors.contexts[0].lifetime;
  assert.equal(lifetime.samples.length, report.nativeGlErrors.lifetime.limits.maxSamplesPerContext);
  assert.equal(lifetime.samples.length, 120); assert.equal(lifetime.droppedSamples, 11);
  assert.equal(lifetime.samples[0].at, 11000); assert.equal(lifetime.sampler, 'stopped');
  assert.equal(gl.getSyncParameter, replacement);
  const stopped = JSON.stringify(f.context.__forgeaxPhoneStartupReport.nativeGlErrors);
  wrapper({}, 0x9114); f.advance(150000);
  assert.equal(JSON.stringify(f.context.__forgeaxPhoneStartupReport.nativeGlErrors), stopped);
});

test('large terminal errors keep their original bounds while lifetime samples fit the startup receiver envelope', async () => {
  const native = { instance: { exports: Object.freeze({ memory: new WebAssembly.Memory({ initial: 1 }),
    rhiwgpuqueue_submit() {}, rhiwgpuqueue_writeBuffer() {} }) }, module: {} };
  const owner = { instantiate: async () => native };
  const f = fixture({ phase: 'scene' }, { observeWasmLifetime: true, deadlineMs: 600000 }, {}, undefined, undefined,
    wx => { wx.createCanvas = () => ({ getContext: () => ({ fenceSync() { return {}; } }) }); },
    context => { context.WXWebAssembly = owner; });
  for (let i = 0; i < 4; i++) f.context.wx.createCanvas().getContext('webgl2').fenceSync();
  for (let i = 0; i < 2; i++) {
    const exports = (await owner.instantiate('wgpu.wasm', { './wgpu_wasm_bg.js': {} })).instance.exports;
    exports.rhiwgpuqueue_submit();
  }
  f.advance(599000);
  f.context.console.error(panicMessage);
  f.state({ phase: 'failed', startupError: { a: '\0'.repeat(70000), b: '\0'.repeat(70000),
    c: '\0'.repeat(70000), d: '\0'.repeat(70000) } });
  f.advance(599250);
  const report = f.report();
  assert.equal(report.reason, 'startup-failed');
  assert.ok(Buffer.byteLength(f.saved[0].body) < 2 * 1024 * 1024);
  assert.equal(report.lifetimeSerialization.status, 'trimmed');
  assert.ok(report.lifetimeSerialization.droppedSamples > 0);
  assert.equal(report.serialization.limits.maxTotalChars, 262144);
  assert.equal(report.observation.renderer.startupError.a.prefix.length, 65536);
  assert.equal(report.rustPanics.records[0].text, panicText);
  assert.equal(report.nativeGlErrors.contexts[0].lifetime.outsideSubmit.fenceSync.nonNull, 1);
  assert.equal(report.nativeWasmErrors.instances[0].lifetime.exports[0].calls, 1);
});

test('retains the first native GL exception before a later panic and preserves calls and owned cleanup', () => {
  const calls = [], first = new Error('native upload rejected; token="private-value"');
  let failure;
  const prototype = { bufferSubData(...args) { calls.push({ receiver: this, args }); if (failure) throw failure; return 17; } };
  const gl = Object.create(prototype), canvas = { getContext: () => gl };
  const originalCanvas = Object.getOwnPropertyDescriptor(canvas, 'getContext');
  const f = fixture({ phase: 'scene' }, {}, {}, undefined, undefined, wx => { wx.createCanvas = () => canvas; });
  const resultCanvas = f.context.wx.createCanvas();
  assert.equal(resultCanvas, canvas);
  assert.equal(canvas.getContext('webgl2'), gl);
  const bytes = new Uint8Array([1,2,3,4]);
  assert.equal(gl.bufferSubData(7, 0, bytes), 17);
  assert.equal(calls[0].receiver, gl); assert.equal(calls[0].args[2], bytes);
  failure = first;
  assert.throws(() => gl.bufferSubData(7, 0, bytes), error => error === first);
  failure = new Error('later native failure');
  assert.throws(() => gl.bufferSubData(7, 0, bytes), error => error === failure);
  f.context.console.error(panicMessage);
  assert.equal(f.saved.length, 0, 'GL observation does not replace the terminal gate');
  f.handlers.Error('unreachable');
  const native = f.report().nativeGlErrors;
  assert.equal(native.first.method, 'bufferSubData');
  assert.equal(native.first.message, 'native upload rejected; token=[redacted]');
  assert.equal(native.laterThrows, 1);
  assert.equal(native.contexts[0].installed, 1);
  assert.equal(native.contexts[0].restored, 1);
  assert.equal(native.factory.status, 'restored');
  assert.equal(Object.hasOwn(gl, 'bufferSubData'), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(canvas, 'getContext'), originalCanvas);
  assert.equal(f.report().rustPanics.records[0].text, panicText);
  assert.ok(!f.saved[0].body.includes('private-value'));
});

test('native GL observation reports restricted properties and never invokes accessors or overwrites replacements', () => {
  let getterCalls = 0;
  const gl = { bufferData() {} };
  Object.defineProperty(gl, 'bufferSubData', { value() {}, writable: false, configurable: false });
  Object.defineProperty(gl, 'drawArrays', { get() { getterCalls++; throw new Error('do not invoke'); }, configurable: true });
  const f = fixture({ phase: 'scene' }, {}, {}, undefined, undefined, wx => {
    wx.createCanvas = () => ({ getContext: () => gl });
  });
  f.context.wx.createCanvas().getContext('webgl2');
  const replacement = () => 'other owner'; gl.bufferData = replacement;
  f.handlers.Hide();
  const facts = f.report().nativeGlErrors.contexts[0];
  assert.equal(getterCalls, 0);
  assert.equal(gl.bufferData, replacement);
  assert.equal(facts.replaced, 1);
  assert.ok(facts.failures.some(row => row.method === 'bufferData' && row.reason === 'owned-method-replaced'));
  assert.ok(facts.failures.some(row => row.method === 'bufferSubData' && row.reason === 'property-write-failed'));
  assert.ok(facts.failures.some(row => row.method === 'drawArrays' && row.reason === 'accessor-unavailable'));
  const absent = fixture({ phase: 'scene' }); absent.handlers.Hide();
  assert.equal(absent.report().nativeGlErrors.factory.status, 'unavailable');
});

test('first GL error text and discovery remain bounded under a hostile failure and maximum ordinary snapshot', () => {
  let getters = 0;
  const error = { message: '\0'.repeat(70000), toJSON() { throw new Error('do not invoke'); } };
  Object.defineProperty(error, 'stack', { get() { getters++; throw new Error('do not invoke'); } });
  const gl = { bufferSubData() { throw error; } };
  for (let i = 0; i < 400; i++) gl['method' + i] = () => {};
  const f = fixture({ phase: 'scene' }, {}, {}, undefined, undefined, wx => { wx.createCanvas = () => ({ getContext: () => gl }); });
  f.context.wx.createCanvas().getContext('webgl2');
  for (let i = 0; i < 100; i++) assert.throws(() => gl.bufferSubData(), value => value === error);
  for (let i = 0; i < 16; i++) f.context.console.error('panicked at test.rs:1:1:\n' + '\0'.repeat(10000));
  f.state({ phase: 'failed', startupError: { a: '\0'.repeat(70000), b: '\0'.repeat(70000), c: '\0'.repeat(70000), d: '\0'.repeat(70000) } });
  f.advance(250);
  const native = f.report().nativeGlErrors;
  assert.equal(getters, 0);
  assert.equal(native.first.message.length, 2048);
  assert.equal(native.first.truncated.message, true);
  assert.equal(native.first.originalStackStatus, 'accessor-unavailable');
  assert.equal(native.laterThrows, 99);
  assert.equal(native.contexts[0].installed, 256);
  assert.equal(native.contexts[0].discovery, 'method-limit');
  assert.ok(Buffer.byteLength(f.saved[0].body) < 2 * 1024 * 1024);
});

test('bounds native fence result types and enums without retaining handles or arbitrary values', () => {
  let result;
  const gl = { getSyncParameter: () => result, clientWaitSync: () => result };
  const f = fixture({ phase: 'scene' }, {}, {}, undefined, undefined, wx => { wx.createCanvas = () => ({ getContext: () => gl }); });
  f.context.wx.createCanvas().getContext('webgl2');
  const handle = { token: 'private-handle' };
  result = 'private-string'; assert.equal(gl.getSyncParameter(handle, 0x9114), result);
  result = true; assert.equal(gl.getSyncParameter(handle, 0x9114), true);
  result = 0x9119; assert.equal(gl.getSyncParameter(handle, 0x9114), result);
  result = 999; gl.getSyncParameter(handle, 0x9113); // Not SYNC_STATUS.
  result = 0x911a;
  for (let i = 0; i < 1000; i++) assert.equal(gl.clientWaitSync(handle, 0, 0), result);
  f.handlers.Hide();
  const rows = f.report().nativeGlErrors.contexts[0].fenceResults;
  assert.equal(rows.getSyncParameter.observed, 3);
  assert.deepEqual(rows.getSyncParameter.values, [{ type: 'string', count: 1 },
    { type: 'boolean', value: true, count: 1 }, { type: 'number', value: 0x9119, count: 1 }]);
  assert.equal(rows.clientWaitSync.observed, 256);
  assert.deepEqual(rows.clientWaitSync.values, [{ type: 'number', value: 0x911a, count: 256 }]);
  assert.ok(!f.saved[0].body.includes('private-string')); assert.ok(!f.saved[0].body.includes('private-handle'));
});

test('explicit fence probe pairs the same sync only after ready scene progress and preserves the original query result', () => {
  const calls = [], sync = {};
  let signaled = false;
  const gl = { getSyncParameter(handle, pname) { calls.push(['query', handle, pname]); return signaled ? 0x9119 : 0x9118; },
    clientWaitSync(handle, flags, timeout) { calls.push(['wait', handle, flags, timeout]); signaled = true; return 0x911a; } };
  const f = fixture(ready(100, 50), { minimumSceneFrames: 1000, probeFenceStatus: true }, {}, undefined, undefined,
    wx => { wx.createCanvas = () => ({ getContext: () => gl }); });
  f.context.wx.createCanvas().getContext('webgl2');
  gl.getSyncParameter(sync, 0x9114);
  assert.equal(calls.filter(row => row[0] === 'wait').length, 0);
  f.state(ready(110, 60)); f.advance(250);
  for (let i = 0; i < 10; i++) {
    signaled = false;
    assert.equal(gl.getSyncParameter(sync, 0x9114), 0x9118);
    f.advance(250 + (i + 1) * 100);
  }
  f.handlers.Hide();
  const probe = f.report().nativeGlErrors.contexts[0].fenceProbe;
  assert.equal(probe.pairs.length, 8);
  assert.ok(probe.pairs.every(row => row.before.value === 0x9118 && row.wait.value === 0x911a && row.after.value === 0x9119));
  const waits = calls.filter(row => row[0] === 'wait');
  assert.equal(waits.length, 8); assert.ok(waits.every(row => row[1] === sync && row[2] === 0 && row[3] === 0));
  assert.ok(probe.intervention.includes('same native sync'));
});

test('delayed fence probes begin after the ready baseline and record synchronous depth without enabling lifetime', async () => {
  const calls = [], sync = new Proxy({}, { get() { throw new Error('do not inspect sync'); } });
  const gl = { getSyncParameter(handle, pname) { calls.push(['query', handle, pname]); return 0x9118; },
    clientWaitSync(handle, flags, timeout) { calls.push(['wait', handle, flags, timeout]); return 0x911b; } };
  let exports;
  const owner = { instantiate: async () => ({ instance: { exports: Object.freeze({
    rhiwgpuqueue_writeBuffer() {}, rhiwgpuqueue_submit(nested) {
      if (nested) return exports.rhiwgpuqueue_submit(false);
      return gl.getSyncParameter(sync, 0x9114);
    },
  }) }, module: {} }) };
  const f = fixture({ phase: 'scene' }, { minimumSceneFrames: 10000, probeFenceStatus: true,
    fenceProbeDelayMs: 10000, fenceProbeIntervalMs: 1000, deadlineMs: 60000 }, {}, undefined, undefined,
    wx => { wx.createCanvas = () => ({ getContext: () => gl }); }, context => { context.WXWebAssembly = owner; });
  f.context.wx.createCanvas().getContext('webgl2');
  exports = (await owner.instantiate('wgpu.wasm', { './wgpu_wasm_bg.js': {} })).instance.exports;
  f.advance(4750); f.state(ready(100, 50)); f.advance(5000);
  f.state(ready(110, 60)); f.advance(5250);
  gl.getSyncParameter(sync, 0x9114); f.advance(14999); gl.getSyncParameter(sync, 0x9114);
  assert.equal(calls.filter(row => row[0] === 'wait').length, 0);
  f.advance(15000); assert.equal(exports.rhiwgpuqueue_submit(true), 0x9118);
  f.advance(15999); assert.equal(gl.getSyncParameter(sync, 0x9114), 0x9118);
  assert.equal(calls.filter(row => row[0] === 'wait').length, 1);
  for (let i = 1; i < 10; i++) {
    f.advance(15000 + i * 1000);
    assert.equal(i % 2 ? gl.getSyncParameter(sync, 0x9114) : exports.rhiwgpuqueue_submit(false), 0x9118);
  }
  f.handlers.Hide();
  const report = f.report(), probe = report.nativeGlErrors.contexts[0].fenceProbe;
  assert.equal(probe.delayMs, 10000); assert.equal(probe.minimumIntervalMs, 1000);
  assert.deepEqual(probe.pairs.map(row => row.at), [15000,16000,17000,18000,19000,20000,21000,22000]);
  assert.deepEqual(probe.pairs.map(row => row.submitDepth), [2,0,1,0,1,0,1,0]);
  assert.ok(probe.pairs.every(row => row.observationId === 1 && row.before.value === 0x9118 &&
    row.wait.value === 0x911b && row.after.value === 0x9118));
  assert.equal(calls.length, 13 + 8 * 2, 'each admitted probe adds only one same-sync wait and requery');
  assert.ok(calls.filter(row => row[0] === 'wait').every(row => row[1] === sync && row[2] === 0 && row[3] === 0));
  assert.equal(report.nativeWasmErrors.lifetime, undefined); assert.equal(report.nativeGlErrors.lifetime, undefined);
});

test('fence probes assign bounded weak sync identities and make non-object identity unavailable', () => {
  const first = { privateToken: 'private-first-sync' }, second = { privateToken: 'private-second-sync' };
  const gl = { getSyncParameter() { return 0x9118; }, clientWaitSync() { return 0x911b; } };
  const f = fixture(ready(100, 50), { minimumSceneFrames: 1000, probeFenceStatus: true }, {}, undefined, undefined,
    wx => { wx.createCanvas = () => ({ getContext: () => gl }); });
  f.context.wx.createCanvas().getContext('webgl2');
  f.state(ready(110, 60));
  for (const [i, handle] of [first, first, second, 17].entries()) {
    f.advance(250 + i * 100); assert.equal(gl.getSyncParameter(handle, 0x9114), 0x9118);
  }
  f.handlers.Hide();
  const pairs = f.report().nativeGlErrors.contexts[0].fenceProbe.pairs;
  assert.deepEqual(pairs.map(row => row.observationId), [1,1,2,undefined]);
  assert.equal(pairs[3].observationIdStatus, 'non-object');
  assert.ok(!f.saved[0].body.includes('private-first-sync')); assert.ok(!f.saved[0].body.includes('private-second-sync'));
});

test('retains the first Rust panic and original WASM caller lines without general console or input collection', () => {
  const f = fixture({ phase: 'scene' }, { reportUrl: 'http://127.0.0.1:19143/startup-test', minimumSceneFrames: 60 });
  const receiver = {}, privateArgument = { input: 'private-input', get stack() { throw new Error('do not read'); } };
  f.context.console.error('form input private-user-value', privateArgument);
  f.context.console.error(new Error('not a panic'), privateArgument);
  assert.equal(f.context.console.error.call(receiver, panicMessage, privateArgument), 'original-console-result');
  assert.equal(f.consoleCalls.length, 3);
  assert.equal(f.consoleCalls[2].receiver, receiver);
  assert.equal(f.consoleCalls[2].args[0], panicMessage);
  assert.equal(f.consoleCalls[2].args[1], privateArgument);
  assert.equal(f.saved.length, 0, 'console observation does not replace the existing terminal gate');
  const trapped = { code: 'webgpu-runtime-error', message: 'unreachable' };
  f.state({ phase: 'ready', state: 'alive', lastError: trapped }); f.advance(250);
  const report = f.report(), row = report.rustPanics.records[0];
  assert.equal(report.reason, 'startup-failed');
  assert.equal(report.sceneFrames.passed, false);
  assert.equal(row.text, panicText);
  assert.equal(row.wasmStack, wasmStack);
  assert.equal(report.rustPanics.records.length, 1);
  assert.equal(report.rustPanics.hook, 'restored');
  assert.deepEqual(report.observation.renderer.lastError, trapped);
  assert.equal(f.requests[0].data, f.saved[0].body);
  for (const secret of ['private-input', 'private-user-value', 'private-query', 'private-host']) assert.ok(!f.saved[0].body.includes(secret));
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.context.console, 'error'), f.originalErrorDescriptor);
  f.context.console.error(panicMessage);
  assert.equal(f.context.__forgeaxPhoneStartupReport.rustPanics.records.length, 1);
});

test('bounds panic floods, preserves the first cause and reports truncation and dropped records', () => {
  const f = fixture({ phase: 'scene' });
  f.context.console.error(panicMessage);
  f.context.console.error(panicText + '\n\nStack:\n\n' + (wasmStack + '\n').repeat(200));
  const huge = 'panicked at src/example.rs:1:1:\n' + 'x'.repeat(70000) + '\n\nStack:\n\n' + wasmStack.repeat(100);
  for (let i = 0; i < 19; i++) f.context.console.error(huge);
  f.handlers.Error('unreachable');
  const panics = f.report().rustPanics;
  assert.equal(panics.records.length, 16);
  assert.equal(panics.dropped, 5);
  assert.equal(panics.records[0].text, panicText);
  assert.equal(panics.records[0].wasmStack, wasmStack);
  assert.equal(panics.records[1].truncated.wasmStack, true);
  assert.equal(panics.records[2].truncated.inspection, true);
  assert.equal(panics.records[2].truncated.text, true);
  assert.ok(panics.records.every(row => row.text.length + row.wasmStack.length <= 18432));
  assert.ok(panics.retainedChars <= panics.limits.maxTotalChars);
  assert.equal(f.consoleCalls.length, 21);
  assert.ok(Buffer.byteLength(f.saved[0].body) < 128 * 1024);
});

test('redacts identified secrets and input values in panic text while retaining Rust locations and WASM offsets', () => {
  const f = fixture({ phase: 'scene' });
  f.context.console.error('panicked at src/example.rs:20:1:\nlabel="scene-color"; width=3200; height=1440; value=19;\npassword=private-password; token="private-token"; input=\'private-input\'; defaultValue="private-value"; Authorization: Bearer private-bearer\nhttps://user:private-url-password@host.invalid/a?secret=private-query#private-fragment\n\nStack:\n\n' + wasmStack);
  f.handlers.Hide();
  const row = f.report().rustPanics.records[0];
  assert.ok(row.text.includes('src/example.rs:20:1'));
  assert.ok(row.text.includes('label="scene-color"; width=3200; height=1440; value=19;'));
  assert.equal(row.wasmStack, wasmStack);
  assert.ok(row.redacted > 0);
  for (const secret of ['private-password', 'private-token', 'private-input', 'private-value', 'private-bearer', 'private-url-password', 'private-query', 'private-fragment']) assert.ok(!row.text.includes(secret), secret);
});

test('console throws, frozen descriptors and later replacement preserve the original console semantics', () => {
  const sentinel = new Error('original-console-throw');
  let calls = 0;
  const throwing = fixture({ phase: 'scene' }, {}, {}, target => { target.error = () => { calls++; throw sentinel; }; });
  assert.throws(() => throwing.context.console.error(panicMessage), error => error === sentinel);
  assert.equal(calls, 1);
  throwing.handlers.Error('native error');
  assert.equal(throwing.report().rustPanics.records.length, 1);
  assert.deepEqual(Object.getOwnPropertyDescriptor(throwing.context.console, 'error'), throwing.originalErrorDescriptor);
  const frozen = fixture({ phase: 'scene' }, {}, {}, target => { Object.defineProperty(target, 'error', { writable: false, configurable: false }); });
  frozen.context.console.error(panicMessage); frozen.advance(20000);
  assert.equal(frozen.report().rustPanics.hook, 'unavailable');
  assert.equal(frozen.report().rustPanics.records.length, 0);
  const replaced = fixture(ready(100, 50), { minimumSceneFrames: 60 });
  const replacement = () => 'another owner';
  replaced.context.console.error = replacement;
  replaced.state(ready(170, 110)); replaced.advance(250);
  assert.equal(replaced.context.console.error, replacement);
  assert.equal(replaced.report().rustPanics.hook, 'replaced');
  assert.equal(replaced.report().sceneFrames.passed, true);
});

test('raises the real V8 Error stack to 64 frames and restores its exact original descriptor', () => {
  const f = fixture({ phase: 'scene' }, {}, {}, undefined, Error => { Error.stackTraceLimit = 10; });
  const actualStack = () => runInNewContext('(function recurse(depth) { return depth ? recurse(depth - 1) : new Error().stack; })(80)', f.context);
  assert.equal(f.realmError.stackTraceLimit, 64);
  assert.equal(actualStack().split('\n').length - 1, 64);
  f.handlers.Error('original native error');
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.realmError, 'stackTraceLimit'), f.originalStackDescriptor);
  assert.equal(actualStack().split('\n').length - 1, 10);
  assert.deepEqual(f.report().rustPanics.stackTraceLimit, {
    requested: 64, status: 'restored', original: f.originalStackDescriptor, effective: 64,
  });
});

test('stack depth capability failures and another owner replacement remain explicit without overwriting them', () => {
  const frozen = fixture({ phase: 'scene' }, {}, {}, undefined, Error => {
    Object.defineProperty(Error, 'stackTraceLimit', { value: 10, writable: false, configurable: false });
  });
  frozen.handlers.Hide();
  assert.equal(frozen.realmError.stackTraceLimit, 10);
  assert.equal(frozen.report().rustPanics.stackTraceLimit.status, 'unavailable');
  assert.equal(frozen.report().rustPanics.stackTraceLimit.reason, 'property-write-failed');
  const replaced = fixture(ready(100, 50), { minimumSceneFrames: 60 });
  replaced.realmError.stackTraceLimit = 32;
  replaced.state(ready(170, 110)); replaced.advance(250);
  assert.equal(replaced.realmError.stackTraceLimit, 32);
  assert.equal(replaced.report().rustPanics.stackTraceLimit.status, 'replaced');
  assert.equal(replaced.report().sceneFrames.passed, true);
  const absent = fixture({ phase: 'scene' }, {}, {}, undefined, Error => { delete Error.stackTraceLimit; });
  absent.handlers.Hide();
  assert.equal(Object.hasOwn(absent.realmError, 'stackTraceLimit'), false);
  assert.equal(absent.report().rustPanics.stackTraceLimit.reason, 'unsupported');
  let getterCalls = 0;
  const accessor = fixture({ phase: 'scene' }, {}, {}, undefined, Error => {
    Object.defineProperty(Error, 'stackTraceLimit', { get() { getterCalls++; return 10; }, configurable: true });
  });
  accessor.handlers.Hide();
  assert.equal(getterCalls, 0);
  assert.equal(accessor.report().rustPanics.stackTraceLimit.reason, 'accessor-unavailable');
  assert.deepEqual(Object.getOwnPropertyDescriptor(accessor.realmError, 'stackTraceLimit'), accessor.originalStackDescriptor);
  for (const value of [128, Infinity]) {
    const sufficient = fixture({ phase: 'scene' }, {}, {}, undefined, Error => { Error.stackTraceLimit = value; });
    sufficient.handlers.Hide();
    assert.equal(sufficient.realmError.stackTraceLimit, value);
    assert.equal(sufficient.report().rustPanics.stackTraceLimit.status, 'already-sufficient');
    assert.equal(sufficient.report().rustPanics.stackTraceLimit.original.value, value === Infinity ? 'Infinity' : value);
    assert.deepEqual(Object.getOwnPropertyDescriptor(sufficient.realmError, 'stackTraceLimit'), sufficient.originalStackDescriptor);
  }
  const descriptorReplaced = fixture({ phase: 'scene' });
  Object.defineProperty(descriptorReplaced.realmError, 'stackTraceLimit', { enumerable: !descriptorReplaced.originalStackDescriptor.enumerable });
  const otherDescriptor = Object.getOwnPropertyDescriptor(descriptorReplaced.realmError, 'stackTraceLimit');
  descriptorReplaced.handlers.Hide();
  assert.equal(descriptorReplaced.report().rustPanics.stackTraceLimit.status, 'replaced');
  assert.deepEqual(Object.getOwnPropertyDescriptor(descriptorReplaced.realmError, 'stackTraceLimit'), otherDescriptor);
});

test('retains a full 64-frame WASM caller stack and bounds a panic flood within the existing receiver envelope', () => {
  const stack = Array.from({ length: 64 }, (_, index) => '    at wgpu_wasm.wasm.render_owner::long_resource_call_' + index +
    ' (wasm://wasm/wgpu_wasm.wasm-015fe636:wasm-function[' + index + ']:0x3be994)').join('\n');
  const f = fixture({ phase: 'scene' });
  for (let i = 0; i < 20; i++) f.context.console.error(panicText + '\n\nStack:\n\n' + stack);
  f.state({ phase: 'failed', startupError: { detail: {
    a: '\0'.repeat(70000), b: '\0'.repeat(70000), c: '\0'.repeat(70000), d: '\0'.repeat(70000),
  } } }); f.advance(250);
  const panics = f.report().rustPanics;
  assert.equal(panics.records[0].wasmStack, stack);
  assert.equal(panics.records[0].wasmStack.split('\n').length, 64);
  assert.equal(panics.records[0].truncated.wasmStack, false);
  assert.ok(panics.retainedChars <= 65536);
  assert.equal(panics.records.reduce((sum, row) => sum + row.text.length + row.wasmStack.length, 0), panics.retainedChars);
  assert.ok(panics.records.length <= 16 && panics.dropped > 0);
  assert.ok(panics.records.some(row => row.truncated.total));
  assert.ok(Buffer.byteLength(f.saved[0].body) < 2 * 1024 * 1024);
});

test('a large ordinary error snapshot cannot evict the separately bounded first panic', () => {
  const f = fixture({ phase: 'scene' });
  f.context.console.error(panicMessage);
  f.state({ phase: 'failed', startupError: { detail: { a: 'x'.repeat(70000),
    b: 'x'.repeat(70000), c: 'x'.repeat(70000), d: 'x'.repeat(70000), e: 'x'.repeat(70000) } } });
  f.advance(250);
  assert.ok(f.report().serialization.issues.length > 0);
  assert.equal(f.report().rustPanics.records[0].text, panicText);
  assert.equal(f.report().rustPanics.records[0].wasmStack, wasmStack);
  assert.equal(f.report().rustPanics.hook, 'restored');
});

test('retains actual startup Error cause and complete structured plugin detail without mutating the error', () => {
  const cause = Object.assign(new Error('Plugin rejected caf\u00e9'), {
    code: 'plugin-startup-failed', detail: { plugin: 'game', failures: [{ expected: 'active', actual: 'failed', detail: { code: 'asset-missing', guid: 'original-guid' } }] },
  });
  const error = Object.assign(new Error('WeChat Host startup failed', { cause }), { detail: { appErrors: [cause] } });
  const before = Object.getOwnPropertyDescriptors(error);
  const state = { state: 'alive', phase: 'failed', generation: 1, completed: 0, presented: 0, startupError: error };
  const f = fixture(state);
  const report = f.report();
  assert.equal(report.reason, 'startup-failed');
  assert.deepEqual(report.source, source);
  assert.equal(report.observation.renderer.startupError.name, 'Error');
  assert.equal(report.observation.renderer.startupError.message, error.message);
  assert.equal(report.observation.renderer.startupError.cause.code, cause.code);
  assert.deepEqual(report.observation.renderer.startupError.cause.detail, cause.detail);
  assert.deepEqual(report.observation.renderer.startupError.detail.appErrors[0].detail, cause.detail);
  assert.deepEqual(Object.getOwnPropertyDescriptors(error), before);
  assert.equal(state.startupError, error);
  assert.equal(f.requests.length, 0, 'transfer is opt-in');
  assert.equal(f.timers.size, 0);
  assert.deepEqual(Object.keys(f.handlers), []);
});

test('sends exact terminal bytes/hash once and keeps original errors/results unchanged', () => {
  const f = fixture({ phase: 'scene', state: 'alive', generation: 2 }, { reportUrl: 'http://127.0.0.1:19143/startup-test' });
  const error = new Error('original native error');
  const original = f.handlers.Error;
  original(error);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.data, f.saved[0].body);
  assert.equal(request.header['X-Forgeax-Report-Bytes'], String(Buffer.byteLength(request.data)));
  assert.equal(request.header['X-Forgeax-Report-Sha256'], createHash('sha256').update(request.data).digest('hex'));
  assert.equal(f.report().observation.event.message, error.message);
  request.success({ statusCode: 200, data: { status: 'saved', bytes: Buffer.byteLength(request.data), sha256: request.header['X-Forgeax-Report-Sha256'] } });
  assert.equal(f.context.__forgeaxPhoneStartupReport.transfer.status, 'sent');
  original(new Error('late callback'));
  f.advance(30000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.saved.length, 1);
  assert.equal(f.timers.size, 0);
});

test('bounds cyclic, oversized and accessor values explicitly without invoking getters or toJSON', () => {
  let getters = 0;
  const detail = { text: 'x'.repeat(70000), toJSON() { throw new Error('must not call toJSON'); } };
  detail.self = detail;
  Object.defineProperty(detail, 'secret', { get() { getters++; throw new Error('must not call getter'); } });
  const f = fixture({ phase: 'failed', startupError: { code: 'plugin-startup-failed', detail } });
  const report = f.report(), result = report.observation.renderer.startupError.detail;
  assert.equal(getters, 0);
  assert.equal(result.text.$forgeaxDiagnostic, 'string-limit');
  assert.equal(result.text.length, 70000);
  assert.equal(result.text.prefix.length, 65536);
  assert.equal(result.self.$forgeaxDiagnostic, 'cycle');
  assert.equal(result.secret.$forgeaxDiagnostic, 'accessor-unavailable');
  assert.equal(result.toJSON.$forgeaxDiagnostic, 'function');
  assert.ok(report.serialization.issues.length >= 4);
  assert.ok(Buffer.byteLength(f.saved[0].body) < 2 * 1024 * 1024);
});

test('ready requires an actual presentation and records startup phases from the same owner', () => {
  const f = fixture({ phase: 'subpackage-loading', state: 'initializing' });
  f.state({ phase: 'scene', state: 'alive', generation: 1, presented: 0 }); f.advance(250);
  f.state(ready(4, 0)); f.advance(500);
  assert.equal(f.saved.length, 0);
  f.state(ready(5, 1)); f.advance(750);
  assert.equal(f.report().reason, 'scene-presented');
  assert.equal(f.report().sceneFrames.minimum, 1);
  assert.equal(f.report().sceneFrames.observed, 1);
  assert.equal(f.report().sceneFrames.passed, true);
  assert.deepEqual(f.report().transitions.map(row => row.phase), ['subpackage-loading', 'scene', 'ready']);
  assert.equal(f.timers.size, 0);
});

test('requires sixty new scene completions after one ready generation baseline', () => {
  const f = fixture(ready(200, 100), { minimumSceneFrames: 60 });
  assert.equal(f.saved.length, 0, 'old successful receipts do not pass a fresh observation');
  f.state(ready(300, 100, { lastCompletion: { frameId: 300, deviceGeneration: 0, presentation: 'pending' } }));
  f.advance(250);
  f.state(ready(359, 159)); f.advance(500);
  f.advance(1000);
  assert.equal(f.saved.length, 0, 'polls and UI-only completions are not scene receipts');
  f.state(ready(360, 160)); f.advance(1250);
  const report = f.report();
  assert.equal(report.reason, 'scene-presented');
  assert.deepEqual(report.sceneFrames, { minimum: 60, observed: 60, passed: true,
    generation: 1, deviceGeneration: 0, startedAt: 0,
    completedStart: 200, presentedStart: 100, completedEnd: 360, presentedEnd: 160 });
  assert.equal(f.timers.size, 0);
  assert.deepEqual(Object.keys(f.handlers), []);
});

test('a pending final completion cannot qualify a scene even after sixty earlier presentations', () => {
  const f = fixture(ready(100, 50), { minimumSceneFrames: 60 });
  f.state(ready(170, 110, { lastCompletion: { frameId: 170, deviceGeneration: 0, presentation: 'pending' } }));
  f.advance(250);
  assert.equal(f.saved.length, 0);
  f.advance(20000);
  assert.equal(f.report().reason, 'deadline');
  assert.equal(f.report().sceneFrames.passed, false);
});

test('invalidated generation, readiness and counters cannot pass a sixty-frame observation', () => {
  for (const [next, reason] of [
    [ready(170, 110, { generation: 2 }), 'generation-changed'],
    [ready(170, 110, { frame: { frameId: 171, deviceGeneration: 1 } }), 'generation-changed'],
    [ready(170, 110, { phase: 'scene' }), 'scene-left-ready'],
    [ready(170, 110, { state: 'lost' }), 'scene-left-ready'],
    [ready(110, 49), 'frame-counters-regressed'],
    [ready(170, 171), 'invalid-frame-counters'],
    [ready(170, Number.NaN), 'invalid-frame-counters'],
    [ready(170, 110, { lastError: { code: 'actual-frame-failure' } }), 'startup-failed'],
  ]) {
    const f = fixture(ready(100, 50), { minimumSceneFrames: 60 });
    f.state(next); f.advance(250);
    assert.equal(f.report().reason, reason);
    assert.equal(f.report().sceneFrames.passed, false);
    assert.equal(f.timers.size, 0);
  }
  const f = fixture(ready(100, 50), { minimumSceneFrames: 60 });
  f.context.__forgeaxGameInspection = { renderer: () => ready(170, 110) };
  f.advance(250);
  assert.equal(f.report().reason, 'generation-changed');
  const hidden = fixture(ready(100, 50), { minimumSceneFrames: 60 });
  hidden.handlers.Hide();
  assert.equal(hidden.report().reason, 'host-hidden');
  assert.equal(hidden.report().sceneFrames.passed, false);
});

test('reads an explicitly selected projection once from the same ready owner and retains capture absence', async () => {
  const calls = [];
  const value = { guid: 'actual-vase-guid', entity: 19, generation: 4, vertexCount: 480, aabb: [0, 0, 0, 1, 2, 1] };
  const f = fixture(ready(100, 50), { minimumSceneFrames: 60, inspectionReads: ['game-3d.runtime-vase'] }, {
    async read(id) { calls.push(id); return value; },
  });
  f.state(ready(170, 110)); f.advance(250);
  await new Promise(resolve => setImmediate(resolve));
  f.advance(500);
  const report = f.report();
  assert.equal(report.reason, 'scene-presented');
  assert.deepEqual(calls, ['game-3d.runtime-vase']);
  assert.deepEqual(report.observation.reads[0].value, value);
  assert.equal(report.observation.reads[0].status, 'fulfilled');
  assert.deepEqual(report.observation.capture, { available: false, reason: 'recorder-not-enabled' });
  assert.equal(report.observation.readContext.generation, 1);
  assert.equal(report.observation.readContext.afterCompletion.frameId, 170);
  assert.equal(f.timers.size, 0);
});

test('projection timeout and errors remain bounded evidence, and cannot hide an owner replacement', async () => {
  const f = fixture(ready(100, 50), { minimumSceneFrames: 60, inspectionReads: ['slow', 'failed'] }, {
    read(id) { if (id === 'failed') throw new Error('actual projection error'); return new Promise(() => {}); },
  });
  f.state(ready(170, 110)); f.advance(250);
  assert.equal(f.saved.length, 0);
  f.advance(5250);
  const rows = f.report().observation.reads;
  assert.equal(rows[0].status, 'timed-out');
  assert.equal(rows[1].status, 'failed');
  assert.equal(rows[1].error.message, 'actual projection error');
  assert.equal(f.timers.size, 0);
  let resolveRead;
  const changed = fixture(ready(100, 50), { minimumSceneFrames: 60, inspectionReads: ['vase'] }, {
    read() { return new Promise(resolve => { resolveRead = resolve; }); },
  });
  changed.state(ready(170, 110)); changed.advance(250);
  changed.context.__forgeaxGameInspection = { renderer: () => ready(170, 110) };
  changed.advance(500);
  resolveRead({ stale: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(changed.report().reason, 'generation-changed');
  assert.equal(changed.report().sceneFrames.passed, false);
  assert.equal(changed.report().observation.reads[0].status, 'pending');
});

test('missing inspection, stalled startup and inspection exceptions have explicit terminal results', () => {
  for (const [state, reason] of [[undefined, 'inspection-unavailable'], [{ phase: 'scene' }, 'deadline'],
    [() => { throw new Error('inspection exploded'); }, 'inspection-failed']]) {
    const f = fixture(state);
    f.advance(20000);
    assert.equal(f.report().reason, reason);
    assert.equal(f.saved.length, 1);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(Object.keys(f.handlers), []);
  }
});

test('unhandled rejection retains event reason and backgrounding ends only the diagnostic', () => {
  for (const kind of ['UnhandledRejection', 'Hide']) {
    const state = { phase: 'scene', generation: 1 };
    const f = fixture(state);
    f.handlers[kind]({ reason: { code: 'plugin-startup-failed', detail: { original: true } } });
    assert.equal(f.report().reason, kind === 'Hide' ? 'host-hidden' : 'wx.onUnhandledRejection');
    if (kind === 'UnhandledRejection') assert.equal(f.report().observation.event.reason.detail.original, true);
    assert.deepEqual(state, { phase: 'scene', generation: 1 });
    assert.equal(f.timers.size, 0);
  }
});

for (const scenario of ['failure', 'sixty-frames', 'rust-panic']) test('bundled ' + scenario + ' observer reaches the actual Python loopback receiver with exact source-bound bytes', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-startup-report-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const out = join(directory, 'received');
  const receiver = spawn('python3', [fileURLToPath(new URL('./receive_phone_gl_report.py', import.meta.url)),
    '--port', String(port), '--path', '/startup-test', '--out', out, '--kind', 'forgeax-phone-startup',
    '--manifest-sha256', source.manifestSha256, '--entry-sha256', source.entrySha256, '--deadline', '5']);
  let stdout = '', stderr = '';
  const closed = new Promise(resolve => receiver.on('close', code => resolve(code)));
  receiver.stderr.on('data', data => { stderr += data; });
  try {
    await new Promise((resolve, reject) => {
      receiver.stdout.on('data', data => { stdout += data; if (stdout.includes('"listening"')) resolve(); });
      receiver.once('error', reject);
      receiver.once('exit', () => reject(new Error('receiver exited before listening: ' + stderr)));
    });
    let sent, callback;
    const transferred = new Promise(resolve => { callback = resolve; });
    const original = new Error('Owner error', { cause: { code: 'plugin-startup-failed', detail: { plugin: 'game', text: 'caf\u00e9 \u4e2d\u6587' } } });
    let state = scenario === 'failure' ? { phase: 'failed', startupError: original } : ready(100, 50);
    const originalConsoleError = () => {};
    const context = {
      console: { info() {}, error: originalConsoleError }, setTimeout, clearTimeout,
      __forgeaxGameInspection: { renderer: () => state },
      wx: { request(options) {
        sent = options.data;
        const request = httpRequest(options.url, { method: options.method,
          headers: { ...options.header, 'Content-Length': Buffer.byteLength(sent) } }, response => {
          let body = '';
          response.on('data', bytes => { body += bytes; });
          response.on('end', () => {
            options.success({ statusCode: response.statusCode, data: JSON.parse(body) }); callback();
          });
        });
        request.on('error', error => { options.fail(error); callback(); });
        request.end(sent);
        return { abort() { request.destroy(); } };
      } },
    };
    runInNewContext(prefix.replace('__FORGEAX_PROBE_OPTIONS__', JSON.stringify({ source, runId: 'c'.repeat(32), deadlineMs: 20000,
      minimumSceneFrames: 60, pollMs: 10, reportUrl: 'http://127.0.0.1:' + port + '/startup-test' })), context);
    if (scenario === 'sixty-frames') state = ready(170, 110);
    if (scenario === 'rust-panic') {
      context.console.error(panicMessage);
      state = ready(120, 70, { lastError: { code: 'webgpu-runtime-error', message: 'unreachable' } });
    }
    await transferred;
    assert.equal(await closed, 0, stderr);
    const received = await readFile(join(out, 'report.json'), 'utf8');
    assert.equal(received, sent);
    assert.equal(context.__forgeaxPhoneStartupReport.transfer.status, 'sent');
    assert.equal(context.console.error, originalConsoleError);
    if (scenario === 'failure') assert.deepEqual(JSON.parse(received).observation.renderer.startupError.cause, original.cause);
    else if (scenario === 'sixty-frames') {
      assert.equal(JSON.parse(received).reason, 'scene-presented');
      assert.equal(JSON.parse(received).sceneFrames.observed, 60);
      assert.equal(JSON.parse(received).sceneFrames.passed, true);
    } else {
      const report = JSON.parse(received);
      assert.equal(report.reason, 'startup-failed');
      assert.equal(report.sceneFrames.passed, false);
      assert.equal(report.rustPanics.records[0].text, panicText);
      assert.equal(report.rustPanics.records[0].wasmStack, wasmStack);
      assert.equal(report.rustPanics.hook, 'restored');
    }
    assert.equal(JSON.parse(await readFile(join(out, 'result.json'), 'utf8')).sha256,
      createHash('sha256').update(sent).digest('hex'));
  } finally {
    if (receiver.exitCode === null) receiver.kill();
    await closed;
    await rm(directory, { recursive: true });
  }
});
