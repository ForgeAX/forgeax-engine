import assert from 'node:assert/strict';
import test from 'node:test';
import { observeBenchmarkReceipt } from '../receipt-observation.mjs';

test('completion-only waits for the original physical completion without timing observation', async () => {
  let finish;
  const receipt = { completed: new Promise(resolve => { finish = resolve; }) };
  const renderer = { observe() { throw new Error('Unexpected timing observer'); } };
  let settled = false;
  const result = observeBenchmarkReceipt(renderer, receipt).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  finish({ ok: true, value: undefined });
  assert.equal(await result, undefined);
});

test('physical completion failure remains a failure', async () => {
  const error = new Error('physical completion failed');
  await assert.rejects(observeBenchmarkReceipt({}, { completed: Promise.resolve({ ok: false, error }) }), error);
});

test('GPU diagnostics explicitly request and require complete timing facts', async () => {
  const timings = { status: 'complete', frame: { frameId: 4 } };
  const receipt = {};
  const renderer = { observe(actual, request) {
    assert.equal(actual, receipt);
    assert.deepEqual(request, { include: ['timings'] });
    return Promise.resolve({ ok: true, value: { timings } });
  } };
  assert.equal(await observeBenchmarkReceipt(renderer, receipt, true), timings);
  await assert.rejects(observeBenchmarkReceipt({ observe: async () => ({ ok: true, value: { timings: { status: 'unavailable' } } }) }, receipt, true), /complete timestamp/);
});
