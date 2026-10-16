import assert from 'node:assert/strict';
import test from 'node:test';
import { installPhoneGameplayGpu } from '../phone_gameplay_gpu.mjs';

// A real immutable WASM export table: submit returns 7, present traps, memory survives.
async function nativeFixture() {
  const name = (value) => [value.length, ...Buffer.from(value)];
  const section = (id, bytes) => [id, bytes.length, ...bytes];
  return WebAssembly.instantiate(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, 0x60, 0, 1, 0x7f]),
      ...section(3, [2, 0, 0]),
      ...section(5, [1, 0, 1]),
      ...section(7, [
        3,
        ...name('rhiwgpuqueue_submit'),
        0,
        0,
        ...name('rhiwgpusurfacetexture_present'),
        0,
        1,
        ...name('memory'),
        2,
        0,
      ]),
      ...section(10, [2, 4, 0, 0x41, 7, 0x0b, 3, 0, 0, 0x0b]),
    ]),
  );
}

function context(options = {}) {
  const calls = [],
    state = { disjoint: false, ...options };
  const extension = { TIME_ELAPSED_EXT: 1, QUERY_COUNTER_BITS_EXT: 2, GPU_DISJOINT_EXT: 3 };
  let active = null;
  const gl = {
    CURRENT_QUERY: 4,
    QUERY_RESULT_AVAILABLE: 5,
    QUERY_RESULT: 6,
    getExtension(name) {
      assert.equal(name, 'EXT_disjoint_timer_query_webgl2');
      return state.available === false ? null : extension;
    },
    getQuery: (_, key) => (key === 2 ? 64 : active),
    getParameter: () => state.disjoint,
    isContextLost: () => false,
    createQuery: () => ({}),
    beginQuery(_, query) {
      assert.equal(active, null);
      active = query;
      calls.push('begin');
    },
    endQuery() {
      assert.ok(active);
      active = null;
      calls.push('end');
    },
    getQueryParameter(_, key) {
      calls.push('read-query');
      return key === 5 ? true : 123456;
    },
    deleteQuery() {
      if (state.deleteFails) throw new Error('delete failed');
      calls.push('delete');
    },
    flush: () => assert.fail('No diagnostic flush'),
    finish: () => assert.fail('No diagnostic finish'),
    getError: () => assert.fail('No diagnostic error-state consumption'),
  };
  return { state, calls, gl, surfaces: [{ getContext: () => gl }] };
}

test('composes the original Host and real WASM exports without bypassing initialization or changing RHI caps', async () => {
  const native = await nativeFixture(),
    c = context(),
    imports = {},
    bytes = Promise.resolve(new Uint8Array([1]));
  let clock = 0,
    instantiateCalls = 0;
  const caps = Object.freeze({ timestampQuery: false });
  const host = Object.freeze({
    surfaces: c.surfaces,
    readWasm() {
      assert.equal(this, host);
      return bytes;
    },
    instantiate(value) {
      assert.equal(this, host);
      assert.equal(value, imports);
      instantiateCalls++;
      return Promise.resolve(native);
    },
  });
  const descriptors = Object.getOwnPropertyDescriptors(native.instance.exports);
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const gpu = installPhoneGameplayGpu({ now: () => clock++, capacity: 4 });
  try {
    const projectedHost = gpu.wrapHost(host);
    assert.equal(projectedHost.surfaces, c.surfaces);
    assert.equal(projectedHost.readWasm(), bytes);
    const projected = await projectedHost.instantiate(imports);
    assert.equal(instantiateCalls, 1);
    assert.equal(projected.module, native.module);
    assert.equal(projected.instance.exports.memory, native.instance.exports.memory);
    assert.equal(gpu.start().clock, 'platform.now');
    assert.equal(projected.instance.exports.rhiwgpuqueue_submit(), 7);
    assert.throws(
      () => projected.instance.exports.rhiwgpusurfacetexture_present(),
      WebAssembly.RuntimeError,
    );
    assert.equal(
      c.calls.includes('read-query'),
      false,
      'No query readback while capture is active',
    );
    const stopped = gpu.stop();
    assert.deepEqual(
      stopped.samples.map((row) => row.operation),
      ['submit', 'present'],
    );
    assert.equal(stopped.samples[1].nativeThrew, true);
    assert.equal(stopped.samples[0].nativeCpuMs, 1);
    const report = await gpu.collect();
    assert.equal(report.schemaVersion, 'forgeax-phone-gameplay-gpu/1');
    assert.equal(report.changesRhiCapabilities, false);
    assert.equal(report.cleanFpsEvidence, false);
    assert.deepEqual(
      report.samples.map((row) => row.gpuNanoseconds),
      [123456, 123456],
    );
    assert.deepEqual(caps, { timestampQuery: false });
    const disposed = gpu.dispose();
    assert.equal(disposed.cleanup.status, 'complete');
    assert.equal(disposed.cleanup.deletedQueries, 4);
    assert.equal(
      projected.instance.exports.rhiwgpuqueue_submit,
      native.instance.exports.rhiwgpuqueue_submit,
    );
    assert.deepEqual(Object.getOwnPropertyDescriptors(native.instance.exports), descriptors);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(globalThis, 'performance'),
      performanceDescriptor,
    );
  } finally {
    gpu.dispose();
  }
});

test('unavailable and disjoint results stay unavailable, with native CPU time still observable', async () => {
  for (const options of [{ available: false }, { disjoint: true }]) {
    const native = await nativeFixture(),
      c = context(options);
    const gpu = installPhoneGameplayGpu({ now: () => 42, capacity: 2 });
    try {
      const projected = gpu.project(native, c.surfaces);
      gpu.start();
      assert.equal(projected.instance.exports.rhiwgpuqueue_submit(), 7);
      gpu.stop();
      const report = await gpu.collect();
      assert.equal(report.samples[0].gpuNanoseconds, null);
      assert.equal(report.samples[0].status, 'unavailable');
      assert.equal(
        report.samples[0].reason,
        options.disjoint ? 'gpu-disjoint' : 'timer-extension-unavailable',
      );
      assert.equal(report.samples[0].nativeCpuMs, 0);
      assert.equal(report.changesRhiCapabilities, false);
    } finally {
      gpu.dispose();
    }
  }
});

test('Host synchronous throws and promise rejections preserve the original failure object', async () => {
  const failure = new Error('original instantiate failure');
  const gpu = installPhoneGameplayGpu({ now: () => 1, capacity: 2 });
  try {
    for (const synchronous of [false, true]) {
      const host = {
        instantiate() {
          if (synchronous) throw failure;
          return Promise.reject(failure);
        },
      };
      const wrapped = gpu.wrapHost(host);
      if (synchronous)
        assert.throws(
          () => wrapped.instantiate({}),
          (error) => error === failure,
        );
      else await assert.rejects(wrapped.instantiate({}), (error) => error === failure);
    }
    assert.equal(gpu.snapshot().coverage.setupAttempts, 0);
  } finally {
    gpu.dispose();
  }
});

test('dispose during pending instantiate returns original native object and allocates no queries', async () => {
  const native = await nativeFixture();
  let resolve;
  const host = {
    instantiate: () =>
      new Promise((done) => {
        resolve = done;
      }),
  };
  const gpu = installPhoneGameplayGpu({ now: () => 1, capacity: 2 });
  const pending = gpu.wrapHost(host).instantiate({});
  const disposed = gpu.dispose();
  resolve(native);
  assert.equal(await pending, native);
  assert.equal(disposed.coverage.allocatedQueries, 0);
  assert.equal(disposed.cleanup.status, 'complete');
});

test('query cleanup failure is explicit and never reported as released', async () => {
  const native = await nativeFixture(),
    c = context({ deleteFails: true });
  const gpu = installPhoneGameplayGpu({ now: () => 1, capacity: 2 });
  gpu.project(native, c.surfaces);
  const report = gpu.dispose();
  assert.equal(report.cleanup.status, 'partial');
  assert.equal(report.cleanup.allocatedQueries, 2);
  assert.equal(report.cleanup.deletedQueries, 0);
  assert.equal(report.coverage.observationErrors, 2);
});

test('a phone diagnostic requires an explicit normalized clock', () => {
  assert.throws(() => installPhoneGameplayGpu(), /Platform.now/);
  assert.equal('__forgeaxPhoneGameplayGpuQueries' in globalThis, false);
});
