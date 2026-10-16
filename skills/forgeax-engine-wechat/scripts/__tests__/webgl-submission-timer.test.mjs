import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebglSubmissionTimer } from '../measure_webgl_submission.mjs';

function context({ extension = true, bits = 64, result = 1234, disjoint = false, pending = false } = {}) {
  const calls = [], query = {}, ext = { TIME_ELAPSED_EXT: 1, QUERY_COUNTER_BITS_EXT: 2, GPU_DISJOINT_EXT: 3 };
  let active = pending ? {} : null;
  return {
    calls, CURRENT_QUERY: 4, QUERY_RESULT_AVAILABLE: 5, QUERY_RESULT: 6, NO_ERROR: 0,
    getExtension: () => extension ? ext : null,
    getQuery: (_, parameter) => parameter === 2 ? bits : active,
    getParameter: () => disjoint,
    createQuery: () => { calls.push('create'); return query; },
    isContextLost: () => false,
    beginQuery: (_, q) => { assert.equal(active, null); active = q; calls.push('begin'); },
    endQuery: () => { assert.equal(active, query); active = null; calls.push('end'); },
    flush: () => calls.push('flush'),
    getError: () => 0,
    getQueryParameter: (_, parameter) => parameter === 5 ? true : result,
    deleteQuery: q => { assert.equal(q, query); calls.push('delete'); },
  };
}

test('one query encloses synchronous submission and is reused only after its result', async () => {
  const gl = context(), timer = createWebglSubmissionTimer(gl);
  for (let frame = 0; frame < 2; frame++) {
    const result = await timer.measure(() => { gl.calls.push('submit'); return frame; });
    assert.equal(result.value, frame); assert.equal(result.gpuNanoseconds, 1234);
    assert.ok(result.submissionCpuMs >= 0);
  }
  timer.dispose(); timer.dispose();
  assert.deepEqual(gl.calls, ['create', 'begin', 'submit', 'end', 'flush', 'begin', 'submit', 'end', 'flush', 'delete']);
  await assert.rejects(timer.measure(() => {}), { code: 'timer-disposed' });
});

test('callback errors close the query and preserve the original failure', async () => {
  const gl = context(), timer = createWebglSubmissionTimer(gl), original = Error('submission failed');
  await assert.rejects(timer.measure(() => { throw original; }), error => error === original);
  assert.deepEqual(gl.calls, ['create', 'begin', 'end']); timer.dispose();
});

test('missing/zero-bit capability allocates no query and fabricates no zero timing', () => {
  for (const options of [{ extension: false }, { bits: 0 }]) {
    const gl = context(options), timer = createWebglSubmissionTimer(gl);
    assert.equal(timer.status, 'unavailable'); assert.deepEqual(gl.calls, []); timer.dispose();
  }
});

test('disjoint, nested, invalid and async submissions fail closed', async () => {
  for (const [options, code] of [[{ disjoint: true }, 'gpu-disjoint'], [{ pending: true }, 'query-owned-elsewhere'], [{ result: 0 }, 'invalid-query-result']]) {
    const gl = context(options), timer = createWebglSubmissionTimer(gl);
    await assert.rejects(timer.measure(() => 1), { code }); timer.dispose();
  }
  const gl = context(), timer = createWebglSubmissionTimer(gl);
  await assert.rejects(timer.measure(async () => 1), { code: 'submission-must-be-synchronous' });
  timer.dispose();
});

test('a disjoint discovered while reading the result invalidates that result', async () => {
  const gl = context(), read = gl.getQueryParameter;
  gl.getQueryParameter = (query, parameter) => {
    if (parameter === gl.QUERY_RESULT) gl.getParameter = () => true;
    return read(query, parameter);
  };
  const timer = createWebglSubmissionTimer(gl);
  await assert.rejects(timer.measure(() => 1), { code: 'gpu-disjoint' }); timer.dispose();
});
