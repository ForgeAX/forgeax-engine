import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { browserGameplayGpuSource, installBrowserGameplayGpu } from '../browser_gameplay_gpu.mjs';

function fixture(options = {}, glOptions = {}) {
  const calls = [],
    queries = [],
    foreign = {};
  let current = glOptions.owned ? foreign : null;
  const extension = { TIME_ELAPSED_EXT: 1, QUERY_COUNTER_BITS_EXT: 2, GPU_DISJOINT_EXT: 3 };
  const state = { lost: false, disjoint: false, available: true, result: 1234, ...glOptions };
  const gl = {
    CURRENT_QUERY: 4,
    QUERY_RESULT_AVAILABLE: 5,
    QUERY_RESULT: 6,
    getExtension: () => (state.extension === false ? null : extension),
    getQuery: (_, key) => (key === extension.QUERY_COUNTER_BITS_EXT ? (state.bits ?? 64) : current),
    getParameter: () => state.disjoint,
    isContextLost: () => state.lost,
    createQuery() {
      const query = {};
      queries.push(query);
      calls.push('create');
      return query;
    },
    beginQuery(_, query) {
      assert.equal(current, null);
      current = query;
      calls.push('begin');
    },
    endQuery() {
      assert.ok(current);
      assert.notEqual(current, foreign);
      current = null;
      calls.push('end');
    },
    getQueryParameter(_, parameter) {
      calls.push(parameter === 5 ? 'available' : 'result');
      if (parameter === 6 && state.disjointOnRead) state.disjoint = true;
      return parameter === 5 ? state.available : state.result;
    },
    deleteQuery(query) {
      assert.ok(queries.includes(query));
      calls.push('delete');
    },
    flush() {
      throw new Error('diagnostic must not flush');
    },
    finish() {
      throw new Error('diagnostic must not finish');
    },
    getError() {
      throw new Error('diagnostic must not consume GL error state');
    },
  };
  const context = { performance, setTimeout };
  runInNewContext(browserGameplayGpuSource({ capacity: 4, ...options }), context);
  const probe = context.__forgeaxGameplayGpu;
  const failure = new Error('native identity'),
    result = { native: 'unchanged' },
    receivers = [];
  const original = function (...args) {
    receivers.push({ receiver: this, args });
    calls.push('native');
    if (args[1] === failure) throw failure;
    return result;
  };
  const memory = new WebAssembly.Memory({ initial: 1 });
  const native = {
    module: {},
    instance: {
      exports: Object.freeze({
        rhiwgpuqueue_submit: original,
        rhiwgpusurfacetexture_present: original,
        memory,
        untouched: original,
      }),
    },
  };
  const projected = probe.project(native, [{ getContext: () => gl }]);
  return {
    probe,
    native,
    projected,
    gl,
    calls,
    state,
    result,
    failure,
    receivers,
    context,
    original,
  };
}

test('projection preserves all native values, synchronous results, receiver, arguments and traps', async () => {
  const f = fixture();
  try {
    assert.notEqual(f.projected.instance.exports, f.native.instance.exports);
    assert.equal(f.projected.module, f.native.module);
    assert.equal(f.projected.instance.exports.memory, f.native.instance.exports.memory);
    assert.equal(f.projected.instance.exports.untouched, f.original);
    assert.equal(Object.isFrozen(f.native.instance.exports), true);
    const receiver = {},
      args = [17, { payload: true }];
    const submit = f.projected.instance.exports.rhiwgpuqueue_submit;
    assert.equal(Reflect.apply(submit, receiver, args), f.result);
    f.probe.start();
    assert.equal(Reflect.apply(submit, receiver, args), f.result);
    assert.throws(
      () => submit(19, f.failure),
      (error) => error === f.failure,
    );
    f.probe.stop();
    assert.deepEqual(f.receivers[1], { receiver, args });
    assert.equal(f.calls.filter((name) => name === 'begin').length, 2);
    assert.equal(f.calls.filter((name) => name === 'end').length, 2);
    assert.equal(f.calls.includes('available'), false);
    const report = await f.probe.collect();
    assert.equal(report.samples[0].gpuNanoseconds, 1234);
    assert.equal(report.samples[1].nativeThrew, true);
    assert.equal(report.samples[1].nativePointer, 19);
    f.probe.dispose();
    assert.equal(f.projected.instance.exports.rhiwgpuqueue_submit, f.original);
    assert.equal(
      Reflect.apply(submit, receiver, args),
      f.result,
      'Cached wrapper also becomes passive',
    );
    assert.equal('__forgeaxGameplayGpu' in f.context, false);
  } finally {
    f.probe.dispose();
  }
});

test('bounded pool overflows without changing native calls; collection only follows stop', async () => {
  const f = fixture({ capacity: 2 });
  try {
    f.probe.start();
    await assert.rejects(f.probe.collect(), /Stop GPU diagnostic/);
    for (let i = 0; i < 3; i++)
      assert.equal(f.projected.instance.exports.rhiwgpuqueue_submit(i), f.result);
    const stopped = f.probe.stop();
    assert.equal(stopped.coverage.calls.submit, 3);
    assert.equal(stopped.coverage.overflow, 1);
    assert.equal(stopped.samples.length, 2);
    assert.equal(f.calls.includes('available'), false);
    await f.probe.collect();
    const disposed = f.probe.dispose();
    assert.equal(disposed.coverage.allocatedQueries, 2);
    assert.equal(disposed.coverage.deletedQueries, 2);
    f.probe.dispose();
    assert.equal(f.calls.filter((name) => name === 'delete').length, 2);
    assert.throws(() => f.probe.start(), /fresh installation/);
  } finally {
    f.probe.dispose();
  }
});

test('missing extension and zero counter bits report unavailable, never fabricated zero', async () => {
  for (const options of [{ extension: false }, { bits: 0 }]) {
    const f = fixture({}, options);
    try {
      const start = f.probe.start();
      assert.equal(start.capability.status, 'unavailable');
      f.projected.instance.exports.rhiwgpuqueue_submit(1);
      f.probe.stop();
      const report = await f.probe.collect();
      assert.equal(report.coverage.allocatedQueries, 0);
      assert.equal(report.samples[0].gpuNanoseconds, null);
      assert.equal(report.samples[0].reason, start.capability.reason);
    } finally {
      f.probe.dispose();
    }
  }
});

test('foreign query is untouched, and context loss/disjoint invalidate original window', async () => {
  for (const [options, reason] of [
    [{ owned: true }, 'query-owned-elsewhere'],
    [{ lost: true }, 'context-lost'],
    [{ disjoint: true }, 'gpu-disjoint'],
    [{ disjointOnRead: true }, 'gpu-disjoint'],
  ]) {
    const f = fixture({}, options);
    try {
      f.probe.start();
      f.projected.instance.exports.rhiwgpuqueue_submit(1);
      f.projected.instance.exports.rhiwgpusurfacetexture_present(2);
      f.probe.stop();
      const report = await f.probe.collect();
      assert.ok(
        report.samples.every(
          (row) =>
            row.status === 'unavailable' && row.gpuNanoseconds === null && row.reason === reason,
        ),
      );
      if (options.owned) assert.equal(f.calls.includes('end'), false);
    } finally {
      f.probe.dispose();
    }
  }
});

test('missing results and teardown preserve unavailable evidence and release every query', async () => {
  for (const collect of [true, false]) {
    const f = fixture({}, { available: false });
    f.probe.start();
    f.projected.instance.exports.rhiwgpuqueue_submit(1);
    f.probe.stop();
    if (collect) await f.probe.collect({ timeoutMs: 0 });
    const report = f.probe.dispose();
    assert.equal(
      report.samples[0].reason,
      collect ? 'query-result-timeout' : 'disposed-before-result',
    );
    assert.equal(report.samples[0].gpuNanoseconds, null);
    assert.equal(report.coverage.deletedQueries, 4);
  }
});

test('diagnostic GL errors do not replace the original return or thrown native object', async () => {
  const f = fixture();
  try {
    f.gl.getParameter = () => {
      throw new Error('diagnostic read failure');
    };
    f.probe.start();
    assert.equal(f.projected.instance.exports.rhiwgpuqueue_submit(1), f.result);
    assert.throws(
      () => f.projected.instance.exports.rhiwgpuqueue_submit(2, f.failure),
      (error) => error === f.failure,
    );
    f.probe.stop();
    const report = await f.probe.collect();
    assert.equal(report.coverage.observationErrors, 2);
    assert.ok(report.samples.every((row) => row.reason === 'query-operation-failed'));
  } finally {
    f.probe.dispose();
  }
});

test('invalid installation bounds and ABI mismatches fail explicitly without native mutation', () => {
  assert.throws(
    () => runInNewContext(browserGameplayGpuSource({ capacity: 1 }), { performance, setTimeout }),
    /capacity/,
  );
  assert.throws(
    () =>
      runInNewContext(browserGameplayGpuSource({ globalName: 'invalid.name' }), {
        performance,
        setTimeout,
      }),
    /identifier/,
  );
  const context = { performance, setTimeout };
  runInNewContext(browserGameplayGpuSource({ capacity: 2 }), context);
  const probe = context.__forgeaxGameplayGpu,
    native = { instance: { exports: {} } };
  assert.equal(probe.project(native, [{}]), native);
  assert.equal(probe.snapshot().capability.reason, 'native-export-abi-mismatch');
  probe.dispose();
});

test('explicit normalized clock needs no browser performance global and is reported accurately', () => {
  let time = 40;
  const context = {
    setTimeout,
    options: { capacity: 2, now: () => time++, clock: 'platform.now' },
  };
  runInNewContext(`(${installBrowserGameplayGpu.toString()})(options)`, context);
  const probe = context.__forgeaxGameplayGpu;
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(probe.start())), {
      startMs: 40,
      clock: 'platform.now',
      capacity: 2,
      capability: { ...probe.snapshot().capability },
    });
    assert.equal(probe.stop().stopMs, 41);
    assert.equal(probe.snapshot().clock, 'platform.now');
  } finally {
    probe.dispose();
  }
});
