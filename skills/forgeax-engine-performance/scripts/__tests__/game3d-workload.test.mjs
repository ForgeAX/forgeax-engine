import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitGame3dWorkload, assertGame3dWorkloadStable, game3dWorkloadReceipt } from '../game3d_workload.mjs';

const ready = () => ({ busy: false, guid: 'published-runtime-vase', generation: 1, entity: 1048577,
  values: { height: 2.4, radius: 0.75, sides: 32 }, vertexCount: 495, aabb: [-0.75, 0, -0.75, 0.75, 2.4, 0.75] });

test('detaches the actual producer receipt and rejects a preserved old mesh after generation failure', () => {
  const state = ready(), receipt = game3dWorkloadReceipt(state);
  state.values.height = 3; state.aabb[0] = -3;
  assert.equal(receipt.values.height, 2.4);
  assert.equal(receipt.aabb[0], -0.75);
  assert.throws(() => game3dWorkloadReceipt({ ...ready(), error: 'producer rejected publication' }), /generation failed/);
  assert.throws(() => game3dWorkloadReceipt({ ...ready(), error: '' }), /generation failed/);
  for (const change of [
    state => { state.vertexCount = 0; },
    state => { state.generation = undefined; },
    state => { state.entity = undefined; },
    state => { state.aabb[0] = NaN; },
    state => { state.aabb[0] = 10; },
    state => { state.values.sides = 16; },
  ]) { const state = ready(); change(state); assert.throws(() => game3dWorkloadReceipt(state)); }
});

test('waits only for live producer busy state and never retries a terminal generation error', async () => {
  let time = 0, reads = 0;
  const play = { state: async () => ++reads < 3 ? { ...ready(), busy: true } : ready(), wait: async ms => { time += ms; } };
  assert.equal((await admitGame3dWorkload(play, { now: () => time })).generation, 1);
  assert.equal(reads, 3);
  reads = 0;
  play.state = async () => { reads++; return { ...ready(), error: 'publication-conflict' }; };
  await assert.rejects(admitGame3dWorkload(play, { now: () => time }), error => {
    assert.equal(error.workload.state.error, 'publication-conflict'); return true;
  });
  assert.equal(reads, 1);
  play.state = async () => ({ ...ready(), busy: true });
  await assert.rejects(admitGame3dWorkload(play, { timeoutMs: 250, now: () => time }), /deadline/);
});

test('rejects a new generation or changed geometry at capture completion', async () => {
  const receipt = game3dWorkloadReceipt(ready());
  const play = { state: async () => ready() };
  assert.deepEqual(await assertGame3dWorkloadStable(play, receipt), receipt);
  play.state = async () => ({ ...ready(), generation: 2 });
  await assert.rejects(assertGame3dWorkloadStable(play, receipt), /changed during/);
  play.state = async () => ({ ...ready(), aabb: [-0.7, 0, -0.75, 0.75, 2.4, 0.75] });
  await assert.rejects(assertGame3dWorkloadStable(play, receipt), error => {
    assert(error.workload.state); return true;
  });
});
