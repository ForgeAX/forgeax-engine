import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAWN_GATE_GROUPS } from '../dawn-gate-roster.mjs';
import {
  dawnGroupEnvironment,
  dawnNativeConcurrency,
  dawnNativeExecutionOrder,
  executeDawnGroups,
} from '../run-dawn-gate.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('only admitted daily two-worker execution pairs measured native owners', () => {
  const core = { FORGEAX_CI_CORE_VALIDATION: '1', FORGEAX_DAWN_LIGHTWEIGHT: '1' };
  assert.equal(dawnNativeConcurrency(core, 2), 2);
  for (const env of [
    {},
    { ...core, FORGEAX_DAWN_LIGHTWEIGHT: '0' },
    { ...core, FORGEAX_CI_CORE_VALIDATION: '0' },
  ])
    assert.equal(dawnNativeConcurrency(env, 2), 1);
  assert.equal(dawnNativeConcurrency(core, 1), 1);
  const measured = DAWN_GATE_GROUPS.filter((group) => group.nativeProcessSlots === 1);
  assert.deepEqual(measured.map((group) => group.id).sort(), [
    'compact-1',
    'compact-2',
    'compact-3',
    'direct-light',
    'feature-depth',
    'gi-1',
    'gi-2',
    'gi-3',
    'gi-4',
    'gi-5',
    'gi-6',
    'heavy-1',
    'heavy-2',
    'heavy-3',
    'heavy-4',
    'modeling-s6',
    'modeling-show',
    'nested-discard',
    'rect-source',
    'renderer',
    'screen-probe',
    'shadow-fields',
    'specular-aa',
    'surface-pipelines',
    'transmission',
    'vfx-depth',
  ]);
  for (const group of measured) {
    assert.equal(dawnGroupEnvironment(group, { LP_NUM_THREADS: '8' }, 2, 2).LP_NUM_THREADS, '4');
    assert.equal(dawnGroupEnvironment(group, { LP_NUM_THREADS: '8' }, 2, 1).LP_NUM_THREADS, '8');
    assert.equal(dawnGroupEnvironment(group, { LP_NUM_THREADS: '1' }, 2, 2).LP_NUM_THREADS, '1');
    assert.equal(dawnGroupEnvironment(group, {}, 2, 2).LP_NUM_THREADS, '4');
  }
  assert.equal(
    dawnGroupEnvironment({ id: 'unmeasured' }, { LP_NUM_THREADS: '8' }, 2, 2).LP_NUM_THREADS,
    '8',
  );
});

test('invalid capacity fails before starting any native process', async () => {
  let started = false;
  const run = async () => {
    started = true;
  };
  await assert.rejects(executeDawnGroups([], run, { nativeConcurrency: 3 }), /concurrency/);
  await assert.rejects(executeDawnGroups([{ id: 'invalid', nativeProcessSlots: 0 }], run), /slots/);
  assert.equal(started, false);
});

test('native pairs drain before unknown owners and the original two-worker ordinary phase', async () => {
  const gates = Object.fromEntries(['a', 'b', 'unknown', 'ordinary'].map((id) => [id, deferred()]));
  const started = [];
  const groups = [
    { id: 'a', nativeProcessSlots: 1 },
    { id: 'ordinary', vitestShard: '1/4' },
    { id: 'b', nativeProcessSlots: 1 },
    { id: 'unknown' },
  ];
  const task = executeDawnGroups(
    groups,
    async (group) => {
      started.push(group.id);
      await gates[group.id].promise;
    },
    { nativeConcurrency: 2 },
  );
  await new Promise(setImmediate);
  assert.deepEqual(started, ['a', 'b']);
  gates.a.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(started, ['a', 'b'], 'unknown memory footprint needs both slots');
  gates.b.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(started, ['a', 'b', 'unknown']);
  gates.unknown.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(started, ['a', 'b', 'unknown', 'ordinary']);
  gates.ordinary.resolve();
  assert.deepEqual(await task, []);
});

test('a failed pair stops new admission and waits for its already running peer', async () => {
  const peer = deferred();
  const failure = new Error('native falsifier');
  const started = [];
  let settled = false;
  const task = executeDawnGroups(
    ['a', 'b', 'c'].map((id) => ({ id, nativeProcessSlots: 1 })),
    async ({ id }) => {
      started.push(id);
      if (id === 'a') throw failure;
      await peer.promise;
    },
    { nativeConcurrency: 2 },
  ).then((result) => {
    settled = true;
    return result;
  });
  await new Promise(setImmediate);
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(settled, false);
  peer.resolve();
  const result = await task;
  assert.equal(result.length, 1);
  assert.equal(result[0].group, 'a');
  assert.equal(result[0].error, failure);
  assert.deepEqual(started, ['a', 'b']);
});

test('serial diagnostics retain the original interleaved order and continue-on-failure evidence', async () => {
  const groups = [{ id: 'a' }, { id: 'ordinary', vitestShard: '1/4' }, { id: 'b' }];
  const started = [];
  const failures = await executeDawnGroups(
    groups,
    async ({ id }) => {
      started.push(id);
      if (id === 'a') throw new Error('retained failure');
    },
    { nativeConcurrency: 1, continueOnFailure: true },
  );
  assert.deepEqual(started, ['a', 'ordinary', 'b']);
  assert.equal(failures.length, 1);
});

test('paired backfill starts long native work before short tails without delaying the first wave', () => {
  const groups = [
    { id: 'capture' },
    { id: 'ordinary', vitestShard: '1/4' },
    { id: 'reserved' },
    { id: 'tiny' },
    { id: 'long' },
    { id: 'unmeasured' },
    { id: 'reserved-tail', placementReserveSeconds: 300 },
  ];
  const original = [...groups];
  const ordered = dawnNativeExecutionOrder(
    groups,
    new Map([
      ['tiny', 10],
      ['long', 200],
    ]),
  );
  assert.deepEqual(
    ordered.map((group) => group.id),
    ['capture', 'reserved', 'reserved-tail', 'long', 'tiny', 'unmeasured', 'ordinary'],
  );
  assert.deepEqual(groups, original);
  assert.equal(ordered[0], groups[0]);
  assert.equal(ordered.at(-1), groups[1]);
});
