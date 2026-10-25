import assert from 'node:assert/strict';
import test from 'node:test';
import { observeNativeWasmErrors } from './phone_native_wasm_errors.js';

const imports = { './wgpu_wasm_bg.js': {} };
function result(exports = {}) {
  return { instance: { exports: Object.freeze({
    rhiwgpuqueue_submit() {}, rhiwgpuqueue_writeBuffer() {},
    memory: new WebAssembly.Memory({ initial: 1, maximum: 2 }), ...exports,
  }) }, module: {} };
}
// Real WASM unreachable, two ordinary wgpu-named function exports, one memory.
// No import can be responsible for this trap.
function trapBytes() {
  const name = value => [value.length, ...Buffer.from(value)];
  const section = (id, bytes) => [id, bytes.length, ...bytes];
  return new Uint8Array([0,97,115,109,1,0,0,0,
    ...section(1, [1,0x60,0,0]), ...section(3, [1,0]), ...section(5, [1,1,1,2]),
    ...section(7, [3, ...name('rhiwgpuqueue_submit'),0,0,
      ...name('rhiwgpuqueue_writeBuffer'),0,0, ...name('memory'),2,0]),
    ...section(10, [1,3,0,0,0x0b])]);
}

test('retains an actual direct WASM trap and its original stack before later errors; native exports stay immutable', async () => {
  const native = await WebAssembly.instantiate(trapBytes(), imports);
  const originalDescriptor = Object.getOwnPropertyDescriptor(native.instance.exports, 'rhiwgpuqueue_submit');
  const owner = { instantiate: async () => native }, factoryDescriptor = Object.getOwnPropertyDescriptor(owner, 'instantiate');
  const observer = observeNativeWasmErrors(owner);
  const projected = await owner.instantiate('wgpu.wasm', imports);
  assert.equal(projected.module, native.module);
  assert.equal(projected.instance.exports.memory, native.instance.exports.memory);
  native.instance.exports.memory.grow(1);
  let first;
  try { projected.instance.exports.rhiwgpuqueue_submit(); } catch (error) { first = error; }
  assert.ok(first instanceof WebAssembly.RuntimeError);
  assert.equal(first.message, 'unreachable');
  assert.ok(observer.report.first.stack.includes('wasm-function[0]'));
  assert.equal(observer.report.first.operation, 'rhiwgpuqueue_submit');
  assert.equal(observer.report.instances[0].initialMemory.byteLength, 65536);
  assert.equal(observer.report.first.memory.byteLength, 131072);
  assert.ok(['data', 'native-error-accessor'].includes(observer.report.first.stackStatus));
  assert.throws(() => projected.instance.exports.rhiwgpuqueue_writeBuffer(), WebAssembly.RuntimeError);
  assert.equal(observer.report.laterThrows, 1);
  assert.equal(observer.report.first.operation, 'rhiwgpuqueue_submit');
  observer.release(); observer.release();
  assert.equal(observer.report.instances[0].restored, 2);
  assert.equal(projected.instance.exports.rhiwgpuqueue_submit, native.instance.exports.rhiwgpuqueue_submit);
  assert.deepEqual(Object.getOwnPropertyDescriptor(native.instance.exports, 'rhiwgpuqueue_submit'), originalDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(owner, 'instantiate'), factoryDescriptor);
});

test('preserves original function receiver, arguments, returned object and thrown identity before a secondary park', async () => {
  const calls = [], token = {}, receiver = {}, first = new Error('original cause'), park = new Error('Parking not supported');
  let failure;
  const native = result({ rhiwgpuqueue_submit(...args) { calls.push({ receiver: this, args }); if (failure) throw failure; return token; } });
  const owner = { instantiate: async () => native }, observer = observeNativeWasmErrors(owner);
  const projected = (await owner.instantiate('wgpu.wasm', imports)).instance.exports;
  assert.equal(projected.rhiwgpuqueue_submit.call(receiver, token), token);
  assert.equal(calls[0].receiver, receiver); assert.equal(calls[0].args[0], token);
  failure = first; assert.throws(() => projected.rhiwgpuqueue_submit(), error => error === first);
  failure = park; assert.throws(() => projected.rhiwgpuqueue_submit(), error => error === park);
  assert.equal(observer.report.first.message, 'original cause');
  assert.equal(observer.report.laterThrows, 1);
  observer.release();
});

test('skips unrelated WASM without changing its promise and preserves original instantiate rejection or synchronous throw', async () => {
  const sentinel = new Error('instantiate failed');
  for (const sync of [false, true]) {
    const owner = { instantiate() { if (sync) throw sentinel; return Promise.reject(sentinel); } };
    const observer = observeNativeWasmErrors(owner);
    if (sync) assert.throws(() => owner.instantiate('wgpu.wasm', imports), value => value === sentinel);
    else await assert.rejects(owner.instantiate('wgpu.wasm', imports), value => value === sentinel);
    assert.equal(observer.report.first.operation, 'instantiate');
    observer.release();
  }
  const promise = Promise.resolve(result()), owner = { instantiate: () => promise };
  const observer = observeNativeWasmErrors(owner);
  assert.equal(owner.instantiate('ui.wasm', { ui: {} }), promise);
  assert.equal(observer.report.instances.length, 0);
  observer.release();
});

test('optional module progress retains unrelated Promise identity and native rejection', async () => {
  const events = [], value = result();
  const promise = Promise.resolve(value), owner = { instantiate: () => promise };
  const observer = observeNativeWasmErrors(owner, { onInstantiate: (path, stage) => events.push([path, stage]) });
  assert.equal(owner.instantiate('basis.wasm', {}), promise);
  assert.equal(await promise, value);
  await Promise.resolve();
  assert.deepEqual(events, [['basis.wasm', 'load'], ['basis.wasm', 'done']]);
  observer.release();
  const error = new Error('native failure'), failed = Promise.reject(error);
  const secondOwner = { instantiate: () => failed };
  const second = observeNativeWasmErrors(secondOwner, { onInstantiate() { throw Error('observer failure'); } });
  assert.equal(secondOwner.instantiate('physics.wasm', {}), failed);
  await assert.rejects(failed, value => value === error);
  second.release();
});

test('a retired module progress observer ignores late native completion', async () => {
  let complete;
  const events = [], promise = new Promise(resolve => { complete = resolve; });
  const owner = { instantiate: () => promise };
  const observer = observeNativeWasmErrors(owner, { onInstantiate: (_path, stage) => events.push(stage) });
  assert.equal(owner.instantiate('basis.wasm', {}), promise);
  observer.release(); complete(result());
  await promise; await Promise.resolve();
  assert.deepEqual(events, ['load']);
});

test('reports unavailable factory descriptors and never invokes an arbitrary factory accessor', () => {
  let getters = 0;
  const accessor = Object.defineProperty({}, 'instantiate', { get() { getters++; throw new Error('do not call'); } });
  const frozen = Object.freeze({ instantiate() {} });
  for (const owner of [undefined, accessor, frozen]) {
    const observer = observeNativeWasmErrors(owner); observer.release();
    assert.equal(observer.report.factory.status, 'unavailable');
    assert.ok(observer.report.factory.reason);
  }
  assert.equal(getters, 0);
});

test('does not overwrite another owner replacing factory or projected function', async () => {
  const owner = { instantiate: async () => result() }, observer = observeNativeWasmErrors(owner);
  const projected = (await owner.instantiate('wgpu.wasm', imports)).instance.exports;
  const replacement = () => 19;
  projected.rhiwgpuqueue_submit = replacement; owner.instantiate = replacement;
  observer.release();
  assert.equal(projected.rhiwgpuqueue_submit, replacement); assert.equal(owner.instantiate, replacement);
  assert.equal(observer.report.factory.status, 'replaced');
  assert.equal(observer.report.instances[0].replaced, 1);
  assert.deepEqual(observer.report.instances[0].failures, [{ method: 'rhiwgpuqueue_submit', reason: 'owned-method-replaced' }]);
});

test('bounds first-error floods and skips arbitrary stack getters and toJSON', async () => {
  let getters = 0;
  const error = { message: 'token="private-value";' + 'x'.repeat(70000), toJSON() { throw new Error('do not call'); } };
  Object.defineProperty(error, 'stack', { get() { getters++; throw new Error('do not call'); } });
  const owner = { instantiate: async () => result({ rhiwgpuqueue_submit() { throw error; } }) };
  const observer = observeNativeWasmErrors(owner);
  const projected = (await owner.instantiate('wgpu.wasm', imports)).instance.exports;
  for (let i = 0; i < 100; i++) assert.throws(() => projected.rhiwgpuqueue_submit(), value => value === error);
  assert.equal(getters, 0);
  assert.equal(observer.report.first.stackStatus, 'accessor-unavailable');
  assert.equal(observer.report.first.message.length, 2048);
  assert.equal(observer.report.first.truncated.inspection, true);
  assert.equal(observer.report.laterThrows, 99);
  assert.ok(!JSON.stringify(observer.report).includes('private-value'));
  observer.release();
});

test('a failing native Error.stack read is explicit and cannot replace the original thrown value', async () => {
  const original = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  const error = new WebAssembly.RuntimeError('unreachable');
  const owner = { instantiate: async () => result({ rhiwgpuqueue_submit() { throw error; } }) };
  const observer = observeNativeWasmErrors(owner);
  const projected = (await owner.instantiate('wgpu.wasm', imports)).instance.exports;
  try {
    Error.prepareStackTrace = () => { throw new Error('stack formatting failed'); };
    assert.throws(() => projected.rhiwgpuqueue_submit(), value => value === error);
    assert.equal(observer.report.first.stackStatus, 'native-stack-read-failed');
  } finally {
    if (original) Object.defineProperty(Error, 'prepareStackTrace', original); else delete Error.prepareStackTrace;
    observer.release();
  }
});

test('a pending instantiate after release returns its original instance without installing hooks', async () => {
  let resolve;
  const native = result(), owner = { instantiate: () => new Promise(done => { resolve = done; }) };
  const observer = observeNativeWasmErrors(owner);
  const pending = owner.instantiate('wgpu.wasm', imports);
  observer.release(); resolve(native);
  assert.equal(await pending, native);
  assert.equal(observer.report.instances.length, 0);
});

test('bounds instance and export discovery without partially adopting a native result', async () => {
  const values = Array.from({ length: 3 }, () => result());
  const owner = { instantiate: async () => values.shift() }, observer = observeNativeWasmErrors(owner);
  await owner.instantiate('wgpu.wasm', imports); await owner.instantiate('wgpu.wasm', imports);
  const third = values[0]; assert.equal(await owner.instantiate('wgpu.wasm', imports), third);
  assert.equal(observer.report.skippedInstances, 1); observer.release();
  const many = result(Object.fromEntries(Array.from({ length: 260 }, (_, i) => ['field' + i, i])));
  const large = { instantiate: async () => many }, bounded = observeNativeWasmErrors(large);
  assert.equal(await large.instantiate('wgpu.wasm', imports), many);
  assert.equal(bounded.report.instances[0].reason, 'export-limit'); bounded.release();
});

test('admits the canonical wasm-bindgen long closure name while keeping a finite name bound', async () => {
  const name = 'wasm_bindgen_' + 'closure_'.repeat(39);
  const native = result({ [name]: () => 31 });
  const owner = { instantiate: async () => native }, observer = observeNativeWasmErrors(owner);
  const projected = await owner.instantiate('wgpu.wasm', imports);
  assert.equal(observer.report.instances[0].status, 'projected');
  assert.equal(projected.instance.exports[name](), 31); observer.release();
  assert.equal(projected.instance.exports[name], native.instance.exports[name]);
});

test('lifetime is opt-in and counts calls, never assumed successes or retained results', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const token = new Proxy({}, { get() { throw new Error('do not inspect return values'); } });
  const names = ['rhiwgpudevice_createCommandEncoder', 'rhiwgpudevice_createTextureView',
    'rhiwgputexture_createView', 'rhiwgpucommandencoder_beginRenderPass',
    'rhiwgpucommandencoder_beginComputePass', 'rhiwgpucommandencoder_finish',
    'rhiwgpurenderpass_end', 'rhiwgpucomputepass_end', 'rhiwgputexture_destroy'];
  const native = result(Object.fromEntries(names.map(name => [name, () => token])));
  const disabledOwner = { instantiate: async () => native }, disabled = observeNativeWasmErrors(disabledOwner);
  await disabledOwner.instantiate('wgpu.wasm', imports);
  t.mock.timers.tick(2000);
  assert.equal(disabled.report.lifetime, undefined);
  assert.equal(disabled.report.instances[0].lifetime, undefined);
  disabled.release();
  const owner = { instantiate: async () => native }, observer = observeNativeWasmErrors(owner, { lifetime: true });
  try {
    const exports = (await owner.instantiate('wgpu.wasm', imports)).instance.exports;
    for (const name of names) assert.equal(exports[name](), token);
    exports.rhiwgpuqueue_submit(); exports.rhiwgpuqueue_writeBuffer();
    const lifetime = observer.report.instances[0].lifetime;
    assert.equal(observer.report.lifetime.finalizationRegistry.type, 'function');
    assert.equal(observer.report.lifetime.qualification, 'diagnostic-only');
    assert.equal(lifetime.exports.length, names.length + 1);
    assert.ok(lifetime.exports.every(row => row.calls === 1 && row.throws === 0 && !('success' in row)));
    native.instance.exports.memory.grow(1);
    t.mock.timers.tick(999);
    assert.equal(lifetime.samples.length, 1);
    t.mock.timers.tick(1);
    assert.equal(lifetime.samples.length, 2);
    assert.equal(lifetime.samples[0].memory.byteLength, 65536);
    assert.equal(lifetime.samples[1].memory.byteLength, 131072);
    assert.deepEqual(lifetime.samples[1].calls, { create: 3, begin: 2, finish: 1, end: 2, submit: 1, destroy: 1, free: 0 });
    assert.doesNotThrow(() => JSON.stringify(observer.report));
  } finally { observer.release(); }
});

test('lifetime free argument bins distinguish explicit and finalizer ABI without reading pointers or objects', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const native = result({ __wbg_rhiwgpucommandencoder_free() {} });
  const owner = { instantiate: async () => native }, observer = observeNativeWasmErrors(owner, { lifetime: true });
  try {
    const exports = (await owner.instantiate('wgpu.wasm', imports)).instance.exports;
    const opaque = { token: 'private-pointer', valueOf() { throw new Error('do not coerce'); } };
    exports.__wbg_rhiwgpucommandencoder_free(42, 0);
    exports.__wbg_rhiwgpucommandencoder_free(43, 1);
    exports.__wbg_rhiwgpucommandencoder_free(0, 1);
    exports.__wbg_rhiwgpucommandencoder_free(opaque, opaque);
    exports.__wbg_rhiwgpucommandencoder_free();
    exports.__wbg_rhiwgpucommandencoder_free(0, undefined);
    const row = observer.report.instances[0].lifetime.exports.find(row => row.kind === 'free');
    assert.deepEqual(row.freeArguments, { explicit: 1, finalizer: 2, missing: 1, other: 2,
      ptrZero: 2, ptrNonzero: 2, ptrOther: 2 });
    assert.equal(row.calls, 6);
    t.mock.timers.tick(1000);
    assert.deepEqual(observer.report.instances[0].lifetime.samples[1].frees,
      { explicit: 1, finalizer: 2, missing: 1, other: 2 });
    assert.ok(!JSON.stringify(observer.report).includes('private-pointer'));
  } finally { observer.release(); }
});

test('lifetime free pointers admit signed-i32 and u32 nonzero ABI expressions without retaining values', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const native = result({ __wbg_rhiwgpucommandencoder_free() {} });
  const owner = { instantiate: async () => native }, observer = observeNativeWasmErrors(owner, { lifetime: true });
  try {
    const exports = (await owner.instantiate('wgpu.wasm', imports)).instance.exports;
    for (const pointer of [-0x80000000, -1, 0x80000000, 0xffffffff]) exports.__wbg_rhiwgpucommandencoder_free(pointer, 1);
    for (const pointer of [-0x80000001, 0x100000000, -0.5, NaN]) exports.__wbg_rhiwgpucommandencoder_free(pointer, 1);
    exports.__wbg_rhiwgpucommandencoder_free(0, 0);
    const row = observer.report.instances[0].lifetime.exports.find(row => row.kind === 'free');
    assert.deepEqual(row.freeArguments, { explicit: 1, finalizer: 8, missing: 0, other: 0,
      ptrZero: 1, ptrNonzero: 4, ptrOther: 4 });
    assert.equal(row.calls, 9);
    assert.ok(!JSON.stringify(observer.report).includes('-2147483648'));
  } finally { observer.release(); }
});

test('lifetime samples and counters are bounded and release stops retained wrappers and owned timers', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const native = result(), owner = { instantiate: async () => native };
  const observer = observeNativeWasmErrors(owner, { lifetime: true });
  const exports = (await owner.instantiate('wgpu.wasm', imports)).instance.exports;
  const wrapper = exports.rhiwgpuqueue_submit, replacement = () => 19;
  const lifetime = observer.report.instances[0].lifetime, row = lifetime.exports[0];
  row.calls = Number.MAX_SAFE_INTEGER - 1;
  wrapper(); wrapper(); wrapper();
  assert.equal(row.calls, Number.MAX_SAFE_INTEGER);
  const max = observer.report.lifetime.limits.maxSamplesPerInstance;
  for (let i = 0; i < max + 10; i++) t.mock.timers.tick(1000);
  assert.equal(lifetime.samples.length, max);
  assert.equal(lifetime.droppedSamples, 11);
  assert.equal(lifetime.samples[0].at, 11000);
  exports.rhiwgpuqueue_submit = replacement; owner.instantiate = replacement;
  observer.release(); observer.release();
  assert.equal(lifetime.sampler, 'stopped');
  const saved = JSON.stringify(observer.report);
  row.calls = 0; wrapper(); assert.equal(row.calls, 0);
  row.calls = Number.MAX_SAFE_INTEGER;
  t.mock.timers.tick(10000);
  assert.equal(JSON.stringify(observer.report), saved);
  assert.equal(exports.rhiwgpuqueue_submit, replacement);
  assert.equal(owner.instantiate, replacement);
  assert.equal(exports.rhiwgpuqueue_writeBuffer, native.instance.exports.rhiwgpuqueue_writeBuffer);
});

test('lifetime preserves native receiver, arguments and thrown identity even when observation fails', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const receiver = {}, argument = {}, error = new WebAssembly.RuntimeError('unreachable');
  const native = result({ rhiwgpucommandencoder_finish(value) {
    assert.equal(this, receiver); assert.equal(value, argument); throw error;
  } });
  const owner = { instantiate: async () => native }, observer = observeNativeWasmErrors(owner, { lifetime: true });
  try {
    const exports = (await owner.instantiate('wgpu.wasm', imports)).instance.exports;
    const row = observer.report.instances[0].lifetime.exports.find(row => row.kind === 'finish');
    assert.throws(() => exports.rhiwgpucommandencoder_finish.call(receiver, argument), value => value === error);
    assert.equal(row.calls, 1); assert.equal(row.throws, 1);
    Object.freeze(row);
    assert.throws(() => exports.rhiwgpucommandencoder_finish.call(receiver, argument), value => value === error);
    assert.equal(observer.report.first.operation, 'rhiwgpucommandencoder_finish');
    assert.equal(observer.report.laterThrows, 1);
  } finally { observer.release(); }
});

test('lifetime submit depth covers synchronous reentry and restores on return, throw and in-call release', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let exports, observer, behavior;
  const depths = [], failure = new Error('native submit failed'), promise = Promise.resolve(17);
  const native = result({ rhiwgpuqueue_submit(level) {
    depths.push(observer.submitDepth());
    if (level) exports.rhiwgpuqueue_submit(level - 1);
    if (behavior === 'throw') throw failure;
    if (behavior === 'release') { observer.release(); depths.push(observer.submitDepth()); }
    return promise;
  } });
  const owner = { instantiate: async () => native };
  observer = observeNativeWasmErrors(owner, { lifetime: true });
  try {
    exports = (await owner.instantiate('wgpu.wasm', imports)).instance.exports;
    assert.equal(observer.submitDepth(), 0);
    assert.equal(exports.rhiwgpuqueue_submit(2), promise);
    assert.deepEqual(depths, [1, 2, 3]);
    assert.equal(observer.submitDepth(), 0, 'Promise lifetime is outside the synchronous boundary');
    behavior = 'throw';
    assert.throws(() => exports.rhiwgpuqueue_submit(1), error => error === failure);
    assert.equal(observer.submitDepth(), 0);
    behavior = 'release';
    assert.equal(exports.rhiwgpuqueue_submit(1), promise);
    assert.equal(observer.submitDepth(), 0);
    assert.deepEqual(depths.slice(-4), [1, 2, 0, 0]);
    const row = observer.report.instances[0].lifetime.exports.find(row => row.kind === 'submit');
    assert.equal(row.calls, 7); assert.equal(row.throws, 2);
  } finally { observer.release(); }
});
