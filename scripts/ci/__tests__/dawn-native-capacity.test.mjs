import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAWN_GATE_GROUPS, DAWN_GATE_SHARDS } from '../dawn-gate-roster.mjs';
import {
  dawnGroupEnvironment,
  dawnNativeConcurrency,
  dawnNativeExecutionOrder,
  dawnOrdinaryInvocations,
  dawnVitestArgs,
  executeDawnGroups,
} from '../run-dawn-gate.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('lane four runs Default GBuffer GI in its dedicated locked graphics process', () => {
  const file = 'packages/runtime/src/__tests__/default-gbuffer-gi.dawn.test.ts';
  const owner = DAWN_GATE_GROUPS.find(({ id }) => id === 'default-gbuffer-gi');
  assert.ok(DAWN_GATE_SHARDS[3].includes(owner.id));
  assert.deepEqual(owner.files, [file]);
  assert.equal(owner.lockedGraphics, true);
  assert.equal(owner.nativeProcessSlots, 2);
  const env = dawnGroupEnvironment(owner, {}, 2, 2);
  assert.equal(env.LP_NUM_THREADS, '1');
  assert.equal(env.FORGEAX_SHADER_COMPILE_WORKERS, '1');
  assert.equal(env.GALLIVM_PERF, 'nopt');
  const args = dawnVitestArgs(owner, { ordinaryWorkers: 2 });
  assert.ok(args.includes(file));
  assert.ok(args.includes('--maxWorkers=1'));
  assert.ok(args.includes('--no-file-parallelism'));
  assert.ok(args.includes('--isolate'));
  assert.ok(!args.some((argument) => argument.startsWith('--shard=')));
});

test('Screen Probe Support and Default GBuffer GI require locked graphics in CI', () => {
  const required = DAWN_GATE_GROUPS.filter((group) => group.lockedGraphics);
  assert.deepEqual(required.map(({ id }) => id).sort(), [
    'default-gbuffer-gi',
    'screen-probe-support',
  ]);
  for (const group of required) {
    assert.equal(group.nativeProcessSlots, 2);
    assert.throws(
      () => dawnGroupEnvironment(group, { GITHUB_ACTIONS: 'true' }, 2, 2),
      /requires the locked Lavapipe bundle in GitHub CI/,
    );
  }
});

test('daily Dawn lane four drains the exclusive cohort before using two bounded workers', () => {
  const owner = DAWN_GATE_GROUPS.find(({ id }) => id === 'ordinary-4');
  const core = { FORGEAX_CI_CORE_VALIDATION: '1', FORGEAX_DAWN_LIGHTWEIGHT: '1' };
  const env = dawnGroupEnvironment(owner, core, 2, 2);
  const phases = dawnOrdinaryInvocations(owner, env, 2);
  assert.deepEqual(
    phases.map((entry) => entry.env.FORGEAX_DAWN_ORDINARY_MEMORY_PHASE),
    ['exclusive', 'bounded'],
  );
  for (const [index, phase] of phases.entries()) {
    const args = dawnVitestArgs(phase.group, { ordinaryWorkers: 2 });
    assert.ok(args.includes('--shard=4/4'));
    assert.ok(args.includes(`--maxWorkers=${index + 1}`));
    assert.equal(phase.env.LP_NUM_THREADS, '2');
    assert.equal(phase.env.MALLOC_ARENA_MAX, '2');
    assert.equal(phase.env.FORGEAX_SHADER_COMPILE_WORKERS, '1');
  }
  assert.equal(phases[0].env.FORGEAX_DAWN_SERIAL_ORDINARY, '2');
  assert.equal(phases[1].env.FORGEAX_DAWN_SERIAL_ORDINARY, undefined);
  assert.equal(
    dawnOrdinaryInvocations(owner, { ...env, FORGEAX_DAWN_LIGHTWEIGHT: '0' }, 2).length,
    1,
  );
  assert.equal(dawnOrdinaryInvocations(owner, env, 1).length, 1);
});

test('runs World Card bounds in a serial native fork with bounded software compilation', () => {
  const file = 'packages/render/src/__tests__/raytracing/world-card-bounds.dawn.test.ts';
  const owner = DAWN_GATE_GROUPS.find(({ id }) => id === 'world-card-bounds');
  assert.ok(owner);
  assert.ok(DAWN_GATE_SHARDS[1].includes(owner.id));
  assert.deepEqual(
    DAWN_GATE_GROUPS.filter((group) => group.files.includes(file)),
    [owner],
  );
  assert.equal(owner.nativeProcessSlots, 2);
  const env = dawnGroupEnvironment(owner, {}, 2, 2);
  assert.equal(env.LP_NUM_THREADS, '1');
  assert.equal(env.GALLIVM_PERF, 'nopt');
  const args = dawnVitestArgs(owner, { ordinaryWorkers: 2 });
  assert.ok(args.includes(file));
  assert.ok(args.includes('--maxWorkers=1'));
  assert.ok(args.includes('--isolate'));
});

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
    'gi-6',
    'heavy-1',
    'heavy-2',
    'heavy-3',
    'heavy-4',
    'modeling-s6',
    'nested-discard',
    'rect-source',
    'renderer',
    'shadow-fields',
    'specular-aa',
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
  const uncapped = { LP_NUM_THREADS: '8', FORGEAX_SHADER_COMPILE_WORKERS: '7' };
  for (const id of ['modeling-show', 'surface-pipelines', 'gi-2', 'path-tracer']) {
    const group = DAWN_GATE_GROUPS.find((entry) => entry.id === id);
    assert.equal(group?.nativeProcessSlots, 2);
    assert.equal(
      dawnGroupEnvironment(group, uncapped, 2, 2).LP_NUM_THREADS,
      id === 'gi-2' ? '1' : '8',
    );
    assert.equal(dawnGroupEnvironment(group, uncapped, 2, 2).FORGEAX_SHADER_COMPILE_WORKERS, '7');
  }
});

test('memory-intensive GI owners keep exclusive admission and bounded workers in CI and Focus', () => {
  const environment = { LP_NUM_THREADS: '8', FORGEAX_SHADER_COMPILE_WORKERS: '7' };
  for (const id of ['gi-3', 'gi-4', 'gi-5', 'screen-probe']) {
    const group = DAWN_GATE_GROUPS.find((entry) => entry.id === id);
    assert.equal(group?.nativeProcessSlots, 2);
    for (const concurrency of [1, 2]) {
      const bounded = dawnGroupEnvironment(group, environment, 2, concurrency);
      assert.equal(bounded.LP_NUM_THREADS, id === 'gi-5' ? '1' : '4');
      assert.equal(bounded.FORGEAX_SHADER_COMPILE_WORKERS, '1');
      assert.equal(
        dawnGroupEnvironment(group, { LP_NUM_THREADS: '1' }, 2, concurrency).LP_NUM_THREADS,
        '1',
      );
    }
  }
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
