import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { watchNativeStages } from '../../../packages/audio-webaudio/bench/music/native-stage.mjs';
import { preparationProcess } from '../../../packages/audio-webaudio/bench/music/quiet-admission.mjs';

test('quiet inventory distinguishes terminal launch arguments from active preparation', () => {
  assert.equal(
    preparationProcess('/opt/homebrew/bin/tmux new-session env PATH=/Users/owner/.cargo/bin codex')
      .heavy,
    undefined,
  );
  for (const command of [
    '/Users/owner/.cargo/bin/cargo build --jobs=1',
    '/usr/bin/clang++ -c source.cc',
    'node scripts/build-shared-inputs.mjs --root project',
    'node node_modules/typescript/bin/tsc -b',
    'node packages/audio-webaudio/bench/music/run.mjs --native-only',
    'pnpm build:engine',
  ])
    assert.ok(preparationProcess(command).heavy, command);
});

test('prepared Music owners reject unleased native execution before accessing inputs', () => {
  const env = { ...process.env, FORGEAX_LOCAL_GPU_LEASE: '1' };
  delete env.FORGEAX_LOCAL_GPU_LEASE_HELD;
  for (const entry of ['run.mjs', 'sdk-consumer.mjs']) {
    const path = fileURLToPath(
      new URL(`../../../packages/audio-webaudio/bench/music/${entry}`, import.meta.url),
    );
    const result = spawnSync(process.execPath, [path, '--native-only'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /native music requires the maintained local-gpu-lease.mjs --timeout-ms process owner/,
    );
    assert(!result.stdout.includes('[local-gpu] queued'));
    assert(!result.stderr.includes('ENOENT'));
  }
});

test('original native deadline retires once and retains async cleanup failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows = [];
  let complete;
  const expired = new Promise((resolve) => {
    complete = resolve;
  });
  const watcher = watchNativeStages(
    (row) => rows.push(row),
    async (row) => {
      complete(row);
      throw new Error('retained cleanup failure');
    },
  );
  await assert.rejects(watcher.receive({ id: 1, budgetMs: 1, status: 'begin' }), /invalid/);
  await watcher.receive({
    id: 2,
    budgetMs: 10000,
    status: 'begin',
    probe: 'cancelled',
    stage: 'ready',
  });
  await watcher.receive({
    id: 2,
    budgetMs: 10000,
    status: 'complete',
    probe: 'cancelled',
    stage: 'ready',
  });
  await watcher.receive({
    id: 3,
    budgetMs: 10000,
    status: 'begin',
    probe: 'pending',
    stage: 'dispose',
  });
  t.mock.timers.tick(10000);
  const row = await expired;
  assert.equal(row.id, 3);
  assert.equal(row.status, 'deadline');
  assert.equal(row.budgetMs, 10000);
  watcher.dispose();
  await assert.rejects(watcher.settled(), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(String(error.errors[0]), /retained cleanup failure/);
    return true;
  });
  assert.equal(rows.length, 3);
  assert(rows.every((row) => typeof row.observedAt === 'string'));
});

test('a receipt finishing after disposal cannot arm another original-budget deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  let entered;
  let expired = 0;
  const writing = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const watcher = watchNativeStages(
    async () => {
      entered();
      await held;
    },
    () => {
      expired++;
    },
  );
  const receive = watcher.receive({
    id: 1,
    budgetMs: 10000,
    status: 'begin',
    probe: 'closed',
    stage: 'dispose',
  });
  await writing;
  watcher.dispose();
  release();
  await receive;
  t.mock.timers.tick(10100);
  await watcher.settled();
  assert.equal(expired, 0);
});

test('an unfinished receipt cannot postpone the original native deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const deadlines = [];
  const watcher = watchNativeStages(
    () => held,
    (row) => deadlines.push(row),
  );
  const receive = watcher.receive({
    id: 1,
    budgetMs: 10000,
    status: 'begin',
    probe: 'held-receipt',
    stage: 'dispose',
  });
  try {
    t.mock.timers.tick(10100);
    await Promise.resolve();
    assert.equal(deadlines.length, 1);
    assert.equal(deadlines[0].budgetMs, 10000);
    assert.equal(deadlines[0].status, 'deadline');
  } finally {
    watcher.dispose();
    release();
    await receive;
    await watcher.settled();
  }
});

test('every App transport wait publishes an existing native stage before blocking', async () => {
  const source = await readFile(
    new URL('../../../packages/audio-webaudio/bench/music/evidence.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('async function app(');
  const end = source.indexOf('\nasync function audible(', start);
  assert(start >= 0 && end > start, 'App evidence owner must remain locatable');
  const app = source.slice(start, end);
  assert.doesNotMatch(
    app,
    /\bawait\s+(?:wait|sleep)\s*\(/,
    'a blocking App await must publish its stage through observed()',
  );
  for (const stage of [
    'ordinary-score-load',
    'audio-context-ready',
    'app-early-window',
    'app-early-receipt',
    'app-late-window',
    'app-late-receipt',
    'app-deferred-receipt',
    'app-bar-receipt',
    'app-envelope-settle',
    'app-rebuild-fault',
    'app-context-close',
  ])
    assert.match(app, new RegExp(`await observed\\(probe, '${stage}'`), stage);
});
