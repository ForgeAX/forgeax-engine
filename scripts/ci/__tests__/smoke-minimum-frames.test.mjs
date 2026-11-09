import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  completeReadyFrame,
  drawReadyFrame,
  driveReadyAppFrames,
} from '../../test/ready-render-frame.mjs';
import * as smoke from '../run-dawn-smoke-roster.mjs';

const head = '0123456789abcdef0123456789abcdef01234567';
const digest = 'a'.repeat(64);
const identity = { gateId: 'budget/smoke', commandId: 'smoke' };
const line = (framesObserved, overrides = {}) =>
  `${smoke.RECEIPT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    ...identity,
    framesObserved,
    completed: true,
    ...overrides,
  })}`;

test('budget is default 60 or a strict safe integer at least 60', () => {
  assert.equal(smoke.parseSmokeFrameBudget(), 60);
  for (const value of [60, 300, '60', '300'])
    assert.equal(smoke.parseSmokeFrameBudget(value), Number(value));
  for (const value of [
    null,
    '',
    ' ',
    0,
    59,
    299.5,
    '300frames',
    '3e2',
    Infinity,
    NaN,
    true,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => smoke.parseSmokeFrameBudget(value), /frame|budget|integer/i);
});

test('CLI accepts an explicit external budget and rejects invalid requests', () => {
  assert.equal(smoke.parseCli(['--frames', '300']).frames, 300);
  for (const value of ['59', '300x', '1.5', ''])
    assert.throws(() => smoke.parseCli(['--frames', value]), /frame|budget|integer/i);
  assert.throws(() => smoke.parseCli(['--frames']), /frame|budget|integer/i);
});

test('external 300 rejects short, incomplete, duplicated and self-downgraded receipts', () => {
  const request = { ...identity, frames: 300 };
  assert.equal(smoke.parseObservedFrameReceipt(line(300), request).framesObserved, 300);
  for (const output of [
    line(60),
    line(299),
    line(300, { completed: false }),
    line(300, { framesExpected: 60 }),
    `${line(300)}\n${line(300)}`,
    'SMOKE_MIN_FRAMES=300',
  ])
    assert.throws(() => smoke.parseObservedFrameReceipt(output, request), /receipt|frame|minimum/i);
  assert.throws(
    () => smoke.parseObservedFrameReceipt('[smoke] frames observed=299\n[smoke] PASS', request),
    /frame|receipt/i,
  );
});

const entry = {
  package: '@forgeax/budget',
  path: 'apps/hello/budget/package.json',
  ...identity,
  oracle: 'frameReceipt',
  command: `${JSON.stringify(process.execPath)} -e '${`console.log(${JSON.stringify(smoke.RECEIPT_PREFIX)}+JSON.stringify({schemaVersion:1,gateId:"${identity.gateId}",commandId:"smoke",framesObserved:Number(process.env.SMOKE_MIN_FRAMES),completed:true}))`}'`,
};

for (const frames of [undefined, 300]) {
  test(`real child command receives ${frames ?? 'default 60'} without a graphics backend`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forgeax-budget-'));
    try {
      const result = await smoke.runEntry({
        entry,
        shardIndex: 0,
        reportPath: join(directory, 'shard.json'),
        timeoutMs: 10_000,
        frames,
      });
      assert.equal(result.status, 'pass');
      assert.equal(result.framesExpected, frames ?? 60);
      assert.equal(result.framesObserved, frames ?? 60);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

function evidence(frames = 300) {
  const resolved = {
    declared: [],
    runnable: [entry],
    independent: [],
    exclusions: [],
    declaredGateIds: [entry.gateId],
    runnableGateIds: [entry.gateId],
    independentGateIds: [],
    excludedGateIds: [],
  };
  const receipt = smoke.parseObservedFrameReceipt(line(frames), identity);
  const result = {
    ...entry,
    shardIndex: 0,
    exitCode: 0,
    signal: null,
    timedOut: false,
    unavailable: false,
    skipped: false,
    unavailableOrSkipped: false,
    framesObserved: frames,
    framesExpected: frames,
    status: 'pass',
    result: 'pass',
    failureReason: null,
    logPath: 'logs/budget.log',
    logSha256: digest,
    logBytes: 1,
    receipt,
    commandResults: [{ commandId: 'smoke', command: entry.command, exitCode: 0, status: 'pass' }],
  };
  const reports = [0, 1].map((shardIndex) =>
    smoke.buildShardReport({
      resolved,
      assigned: shardIndex === 0 ? [entry] : [],
      results: shardIndex === 0 ? [result] : [],
      head,
      expectedProductSha: head,
      rosterDigest: digest,
      shardIndex,
      shardCount: 2,
      frames,
    }),
  );
  return {
    reports,
    resolved,
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    shardCount: 2,
    frames: 300,
  };
}

test('aggregate admits only the external budget with complete exact-HEAD owner closure', () => {
  assert.equal(smoke.aggregateReports(evidence()).framesExpected, 300);
  assert.throws(() => smoke.aggregateReports(evidence(60)), /frame|budget/i);
  for (const [name, mutate] of [
    [
      'mixed budget',
      (e) => {
        e.reports[1].framesExpected = 60;
      },
    ],
    [
      'short receipt',
      (e) => {
        e.reports[0].runnableEntries[0].receipt = smoke.parseObservedFrameReceipt(
          line(299),
          identity,
        );
        e.reports[0].runnableEntries[0].framesObserved = 299;
      },
    ],
    [
      'missing receipt',
      (e) => {
        e.reports[0].runnableEntries[0].receipt = null;
      },
    ],
    [
      'incomplete',
      (e) => {
        e.reports[0].runnableEntries[0].receipt.completed = false;
      },
    ],
    [
      'missing owner',
      (e) => {
        e.reports[0].runnableEntries = [];
      },
    ],
    [
      'duplicate owner',
      (e) => {
        e.reports[0].runnableEntries.push(e.reports[0].runnableEntries[0]);
      },
    ],
    [
      'wrong HEAD',
      (e) => {
        e.reports[0].head = 'b'.repeat(40);
      },
    ],
    [
      'wrong expected HEAD',
      (e) => {
        e.reports[0].expectedProductSha = 'b'.repeat(40);
      },
    ],
  ]) {
    const e = evidence();
    mutate(e);
    assert.throws(() => smoke.aggregateReports(e), undefined, name);
  }
});

test('core fleet conserves every retained frame and semantic owner', () => {
  const resolved = smoke.resolveRunnableEntries({ roster: smoke.readRoster() });
  const entries = smoke.selectSmokeEntries(resolved, 'full');
  assert.deepEqual(
    entries
      .filter((entry) => entry.package === '@forgeax/hello-terrain')
      .map((entry) => [entry.gateId, entry.commandId, entry.oracle, entry.executionClass]),
    [['hello-terrain/smoke', 'smoke', 'frameReceipt', 'independent']],
  );
  assert.deepEqual(
    entries
      .filter((e) => e.package === '@forgeax/hello-transform-gizmo')
      .map((e) => e.gateId)
      .sort(),
    ['hello-transform-gizmo/browser', 'hello-transform-gizmo/smoke'],
  );
  assert.deepEqual(
    entries
      .filter((e) => e.package === '@forgeax/app-learn-render-6-pbr-4-transmission-refraction')
      .map((e) => [e.gateId, e.commandId, e.oracle])
      .sort(),
    [
      [
        'app-learn-render-6-pbr-4-transmission-refraction/features-a',
        'smoke:features-a',
        'assertion',
      ],
      [
        'app-learn-render-6-pbr-4-transmission-refraction/features-b',
        'smoke:features-b',
        'assertion',
      ],
      ['app-learn-render-6-pbr-4-transmission-refraction/frames', 'smoke:frames', 'frameReceipt'],
    ],
  );
  const reports = [0, 1, 2, 3].map((shardIndex) => {
    const assigned = smoke.partitionRunnableEntries(entries, { shardIndex });
    const results = assigned.map((e) => ({
      ...evidence().reports[0].runnableEntries[0],
      ...e,
      shardIndex,
      framesObserved: e.oracle === 'frameReceipt' ? 300 : null,
      receipt:
        e.oracle === 'frameReceipt'
          ? smoke.parseObservedFrameReceipt(
              line(300, { gateId: e.gateId, commandId: e.commandId }),
              { ...e, frames: 300 },
            )
          : null,
      commandResults: [{ commandId: e.commandId, command: e.command, exitCode: 0, status: 'pass' }],
    }));
    return smoke.buildShardReport({
      resolved,
      assigned,
      results,
      head,
      expectedProductSha: head,
      rosterDigest: digest,
      shardIndex,
      frames: 300,
      scope: 'full',
    });
  });
  const request = {
    reports,
    resolved,
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    frames: 300,
    scope: 'full',
  };
  assert.equal(smoke.aggregateReports(request).runnableResults.length, entries.length);
  assert.equal(
    reports.flatMap((r) => r.runnableEntries).filter((e) => e.receipt === null).length,
    6,
  );
  assert.throws(() => smoke.aggregateReports({ ...request, scope: 'sharded' }), /scope/);
  assert.throws(() => smoke.aggregateReports({ ...request, allowBlocked: true }), /blocked/);
  for (const mutate of [
    (r) => {
      r[0].runnableEntries.pop();
    },
    (r) => {
      r[0].runnableEntries.push(r[0].runnableEntries[0]);
    },
    (r) => {
      r[0].rosterDigest = 'b'.repeat(64);
    },
    (r) => {
      r[0].framesExpected = 60;
    },
    (r) => {
      r.flatMap((s) => s.runnableEntries).find((e) => e.receipt === null).framesObserved = 300;
    },
    (r) => {
      r.flatMap((s) => s.runnableEntries).find((e) => e.receipt === null).skipped = true;
    },
    (r) => {
      r[0].runnableEntries[0].commandResults[0].exitCode = 1;
    },
    (r) => {
      r[0].runnableEntries[0].timedOut = true;
    },
  ]) {
    const changed = structuredClone(reports);
    mutate(changed);
    assert.throws(() => smoke.aggregateReports({ ...request, reports: changed }));
  }
});

test('semantic owners retain assertions without fabricated frames or optional-provenance failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-semantic-'));
  try {
    const makeEntry = (output, gateId) => ({
      ...entry,
      gateId,
      oracle: 'composite',
      command: `${JSON.stringify(process.execPath)} -e '${`console.log(${JSON.stringify(output)})`}'`,
    });
    const run = (e) =>
      smoke.runEntry({
        entry: e,
        frames: 300,
        shardIndex: 0,
        reportPath: join(directory, 'shard.json'),
        timeoutMs: 10_000,
      });
    const good = await run(
      makeEntry(`${line(300)}\n{"wasmBindgen":"unavailable"}\n[smoke] PASS`, 'semantic/all'),
    );
    assert.equal(good.status, 'pass');
    assert.equal(good.receipt, null);
    assert.equal(good.framesObserved, null);
    const bad = await run(makeEntry('[smoke] SKIPPED', 'semantic/skip'));
    assert.equal(bad.status, 'fail');
    assert.notEqual(good.logPath, bad.logPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repaired owners derive their loop budgets and preserve independent sampling windows', () => {
  const source = (path) =>
    readFileSync(new URL(`../../../apps/${path}/scripts/smoke-dawn.mjs`, import.meta.url), 'utf8');
  for (const [path, variable] of [
    ['hello/cinder-fall', 'FRAMES'],
    ['hello/custom-shader', 'FRAME_COUNT'],
    ['hello/fbx-cube', 'SMOKE_MIN_FRAMES'],
    ['hello/boss-lightning', 'TARGET_FRAMES'],
    ['hello/fxaa', 'VALIDATION_FRAME_COUNT'],
    ['hello/transform-hierarchy', 'FLEET_FRAME_COUNT'],
    ['learn-render/5.advanced-lighting/7.bloom', 'SMOKE_MIN_FRAMES'],
    ['learn-render/6.pbr/4.render-target-reflection', 'MIN_FRAMES'],
    ['hello/bloom', 'REQUESTED_FRAMES'],
    ['hello/lod-occlusion', 'frameCount'],
  ]) {
    const text = source(path);
    const expression = text.match(new RegExp(`const ${variable} = ([^;]+);`))?.[1];
    assert.ok(expression, path);
    for (const frames of [60, 300])
      assert.equal(
        runInNewContext(expression, {
          smokeFrameBudget: (value = frames) => smoke.parseSmokeFrameBudget(value),
          process: { env: { SMOKE_MIN_FRAMES: String(frames) } },
        }),
        frames,
        path,
      );
  }
  assert.match(
    source('hello/entity-visibility'),
    /runVisibilityDawnSmoke\(\{ frames: Math\.max\(60, Number\.parseInt\(process\.env\.SMOKE_MIN_FRAMES/,
  );
  assert.match(source('hello/boss-lightning'), /frameLimit = benchmarkMode \? 90 : TARGET_FRAMES/);
  assert.match(source('hello/bloom'), /const SMOKE_MIN_FRAMES = 60;/);
  assert.match(source('hello/bloom'), /if \(!CAPTURE_GPU_TIMINGS && !FALSIFY_BLOOM\)/);
  assert.match(source('hello/fxaa'), /Math\.min\(framesNone, framesFxaa\)/);
});

test('aggregate re-parses the actual child log and rejects report-only completion claims', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-log-proof-'));
  try {
    const result = await smoke.runEntry({
      entry,
      shardIndex: 0,
      frames: 300,
      reportPath: join(directory, 'shard.json'),
      timeoutMs: 10_000,
    });
    const request = evidence();
    request.reports[0].runnableEntries = [result];
    request.reportDirectory = directory;
    assert.equal(smoke.aggregateReports(request).status, 'pass');
    const tampered = structuredClone(request);
    tampered.reports[0].runnableEntries[0].receipt.rawLineSha256 = 'f'.repeat(64);
    assert.throws(() => smoke.aggregateReports(tampered), /projection|digest/);
    writeFileSync(join(directory, result.logPath), line(60));
    assert.throws(() => smoke.aggregateReports(request), /log byte|log digest/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('optional setup prose cannot override complete frame or semantic evidence', async () => {
  const optional = '[postinstall] skipping optional fetch';
  assert.equal(
    smoke.hasUnavailableOrSkipped(`${line(300)}\n${optional}`, { hasReceipt: true }),
    false,
  );
  // Exact terminal formats from asi-world/tilemap and the transmission browser
  // owner. Owner tags remain open; setup prose is not a terminal status token.
  for (const verdict of [
    '[hello-tilemap smoke] env-deferred=no-adapter',
    '[learn-render 6.4 transmission-refraction] NOT-RUN: display unavailable',
    '[another-owner] SKIP: missing prerequisite',
    '[another-owner] SKIPPED',
  ])
    assert.equal(
      smoke.hasUnavailableOrSkipped(`${line(300)}\n${verdict}`, { hasReceipt: true }),
      true,
    );
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-optional-setup-'));
  try {
    const run = (kind, output) =>
      smoke.runEntry({
        entry: {
          ...entry,
          oracle: kind,
          command: `${JSON.stringify(process.execPath)} -e '${`console.log(${JSON.stringify(output)})`}'`,
        },
        frames: 300,
        shardIndex: 0,
        reportPath: join(directory, 'shard.json'),
        timeoutMs: 10_000,
      });
    for (const kind of ['assertion', 'composite']) {
      assert.equal((await run(kind, `${optional}\n[owner] PASS`)).status, 'pass');
      assert.equal((await run(kind, '[owner] SKIP: unavailable gate')).status, 'fail');
    }
    assert.notEqual((await run('frameReceipt', optional)).status, 'pass');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a receipt cannot mask an explicit skipped gate', () => {
  assert.equal(
    smoke.hasUnavailableOrSkipped(`${line(300)}\n[smoke] SKIPPED`, { hasReceipt: true }),
    true,
  );
  assert.equal(smoke.hasUnavailableOrSkipped('SKIP missing gate', { hasReceipt: true }), true);
  // Falsifier failures are interpreted by their complete command, not word scanning.
  assert.equal(
    smoke.hasUnavailableOrSkipped(`${line(300)}\n[smoke] FAIL - expected falsifier`, {
      hasReceipt: true,
    }),
    false,
  );
});

test('CI lightweight routing reaches only the TransformGizmo browser child', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-gizmo-routing-'));
  const previous = Object.fromEntries(
    ['CI', 'FORGEAX_BROWSER_CI_LIGHTWEIGHT'].map((key) => [key, process.env[key]]),
  );
  const probe = join(directory, 'probe.mjs');
  writeFileSync(
    probe,
    "console.log('lightweight=' + (process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT ?? 'unset')); console.log('[forgeax-smoke-receipt] ' + JSON.stringify({schemaVersion:1, gateId:process.argv[2], commandId:'smoke', framesObserved:Number(process.env.SMOKE_MIN_FRAMES), completed:true}));",
  );
  try {
    delete process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT;
    for (const [ci, gateId, expected] of [
      ['true', 'hello-transform-gizmo/browser', '1'],
      ['true', 'hello-transform-gizmo/smoke', 'unset'],
      ['true', 'hello-other/browser', 'unset'],
      ['false', 'hello-transform-gizmo/browser', 'unset'],
    ]) {
      process.env.CI = ci;
      const result = await smoke.runEntry({
        entry: {
          ...entry,
          gateId,
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)} ${JSON.stringify(gateId)}`,
        },
        shardIndex: 0,
        reportPath: join(directory, 'shard.json'),
        timeoutMs: 10000,
      });
      assert.equal(result.status, 'pass');
      assert.match(
        readFileSync(join(directory, result.logPath), 'utf8'),
        new RegExp(`lightweight=${expected}`),
      );
      assert.equal(result.framesObserved, 60);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function driver(presentations, completion = { ok: true }) {
  let listener;
  let ticks = 0;
  let disposed = false;
  const renderer = {
    subscribe(fn) {
      listener = fn;
      return () => {
        disposed = true;
      };
    },
  };
  const tick = () => {
    const presentation = presentations[ticks++];
    if (presentation === undefined) return false;
    listener({
      kind: 'frame-submitted',
      receipt: {
        presentation,
        completed: Promise.resolve(completion),
      },
    });
  };
  return { renderer, tick, state: () => ({ ticks, disposed }) };
}

test('App acceptance counts ready receipts, never preparation callbacks', async () => {
  const d = driver(['pending', 'ready', 'pending', 'ready']);
  assert.equal(await driveReadyAppFrames(d.renderer, d.tick, 2), 2);
  assert.deepEqual(d.state(), { ticks: 4, disposed: true });
});

test('App acceptance preserves completion failures and releases its listener', async () => {
  const error = new Error('native completion failed');
  const d = driver(['ready'], { ok: false, error });
  await assert.rejects(driveReadyAppFrames(d.renderer, d.tick), (actual) => actual === error);
  assert.equal(d.state().disposed, true);
});

test('missing App callbacks fail immediately and release their listener', async () => {
  const d = driver([]);
  await assert.rejects(driveReadyAppFrames(d.renderer, d.tick), /did not schedule/);
  assert.equal(d.state().disposed, true);
});

test('ready observation retries consume preparation receipts within the native unread bound', async () => {
  const request = {},
    domains = ['linear-hdr'],
    unread = new Set(),
    observed = [];
  let frames = 0;
  const renderer = {
    requestObservation(actual) {
      assert.equal(actual, domains);
      return unread.size < 4
        ? { ok: true }
        : { ok: false, error: new Error('four unread observations') };
    },
    draw(actual) {
      assert.equal(actual, request);
      const receipt = {
        frameId: ++frames,
        presentation: frames <= 6 ? 'pending' : 'ready',
        observationDomains: domains,
        completed: Promise.resolve({ ok: true }),
      };
      unread.add(receipt);
      return { ok: true, value: receipt };
    },
    async observe(receipt, options) {
      assert.deepEqual(options.include, domains);
      assert.equal((await receipt.completed).ok, true);
      assert.equal(unread.delete(receipt), true);
      observed.push(receipt.frameId);
      return { ok: true, value: {} };
    },
  };
  const receipt = await drawReadyFrame(renderer, request, domains);
  assert.equal(receipt.frameId, 7);
  assert.deepEqual(observed, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...unread], [receipt]);
  await renderer.observe(receipt, { include: domains });
  assert.equal(unread.size, 0);
});

test('preparation observation readback failure remains terminal', async () => {
  const error = new Error('preparation readback failed');
  let draws = 0;
  const renderer = {
    requestObservation: () => ({ ok: true }),
    draw: () => ({
      ok: true,
      value: {
        frameId: ++draws,
        observationDomains: ['linear-hdr'],
        presentation: 'pending',
        completed: Promise.resolve({ ok: true }),
      },
    }),
    observe: async () => ({ ok: false, error }),
  };
  await assert.rejects(drawReadyFrame(renderer, {}, ['linear-hdr']), (actual) => actual === error);
  assert.equal(draws, 1);
});

test('ready observation retries distinguish empty barriers and partial pending captures', async () => {
  const requested = ['linear-hdr', 'final-display'],
    captured = [[], ['final-display'], requested];
  const reads = [];
  let frames = 0;
  const renderer = {
    requestObservation: () => ({ ok: true }),
    draw() {
      const domains = captured[frames++];
      assert.ok(domains);
      return {
        ok: true,
        value: {
          frameId: frames,
          presentation: frames < 3 ? 'pending' : 'ready',
          observationDomains: domains,
          completed: Promise.resolve({ ok: true }),
        },
      };
    },
    async observe(receipt, options) {
      assert.notEqual(receipt.observationDomains.length, 0);
      assert.deepEqual(options.include, receipt.observationDomains);
      reads.push(receipt.frameId);
      return { ok: true, value: {} };
    },
  };
  const receipt = await drawReadyFrame(renderer, {}, requested);
  assert.equal(receipt.frameId, 3);
  assert.deepEqual(reads, [2]);
  await renderer.observe(receipt, { include: requested });
  assert.deepEqual(reads, [2, 3]);
});

test('pending scene preparation waits for its Engine signal without another submission', async () => {
  let release;
  const preparationCompleted = new Promise((resolve) => {
    release = resolve;
  });
  let ready = false;
  let draws = 0;
  const result = completeReadyFrame(async () => {
    draws++;
    return {
      completed: Promise.resolve({ ok: true }),
      preparationCompleted,
      presentation: ready ? 'ready' : 'pending',
      presentationPendingReason: { code: 'scene-pipeline-preparation' },
    };
  });
  await new Promise(setImmediate);
  assert.equal(draws, 1);
  ready = true;
  release({ ok: true });
  assert.equal((await result).presentation, 'ready');
  assert.equal(draws, 2);
});

test('cold scene preparation accepts a caller-owned deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let ready = false;
  let draws = 0;
  let completePreparation;
  const preparationCompleted = new Promise((resolve) => {
    completePreparation = resolve;
  });
  setTimeout(() => {
    ready = true;
    completePreparation({ ok: true });
  }, 32);
  const result = completeReadyFrame(async () => {
    draws++;
    return {
      completed: Promise.resolve({ ok: true }),
      preparationCompleted,
      presentation: ready ? 'ready' : 'pending',
      presentationPendingReason: { code: 'scene-pipeline-preparation' },
    };
  }, 64);
  for (let elapsed = 0; elapsed < 80; elapsed++) {
    t.mock.timers.tick(1);
    await new Promise(setImmediate);
  }
  assert.equal((await result).presentation, 'ready');
  assert.equal(draws, 2);
});

test('pending preparation retains its original fifteen-second deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let draws = 0;
  const pending = completeReadyFrame(async () => {
    draws++;
    return {
      completed: Promise.resolve({ ok: true }),
      preparationCompleted: new Promise(() => {}),
      presentation: 'pending',
      presentationPendingReason: { code: 'scene-pipeline-preparation' },
    };
  });
  const rejected = assert.rejects(pending, /Renderer scene presentation did not become ready/);
  await new Promise(setImmediate);
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(draws, 1);
});

test('cold preparation uses its owner budget and resumes only on the Engine signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let release;
  let ready = false;
  let draws = 0;
  const preparationCompleted = new Promise((resolve) => {
    release = resolve;
  });
  const result = completeReadyFrame(
    async () => {
      draws++;
      return {
        presentation: ready ? 'ready' : 'pending',
        presentationPendingReason: { code: 'scene-pipeline-preparation' },
        completed: Promise.resolve({ ok: true }),
        preparationCompleted,
      };
    },
    { timeoutMs: 90_000 },
  );
  const observed = result.catch((error) => error);
  await new Promise(setImmediate);
  t.mock.timers.tick(20_000);
  await new Promise(setImmediate);
  assert.equal(draws, 1);
  ready = true;
  release({ ok: true });
  assert.equal((await observed).presentation, 'ready');
  assert.equal(draws, 2);
});

test('completed preparation does not consume the next picture GPU budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let prepared, gpu;
  let draws = 0;
  const preparationCompleted = new Promise((resolve) => {
    prepared = resolve;
  });
  const completed = new Promise((resolve) => {
    gpu = resolve;
  });
  const result = completeReadyFrame(async () =>
    ++draws === 1
      ? {
          presentation: 'pending',
          presentationPendingReason: { code: 'scene-pipeline-preparation' },
          completed: Promise.resolve({ ok: true }),
          preparationCompleted,
        }
      : { presentation: 'ready', completed },
  );
  const observed = result.catch((error) => error);
  await new Promise(setImmediate);
  t.mock.timers.tick(4_000);
  prepared({ ok: true });
  await new Promise(setImmediate);
  t.mock.timers.tick(12_000);
  gpu({ ok: true });
  assert.equal((await observed).presentation, 'ready');
  assert.equal(draws, 2);
});

test('pending GPU completion starts its wait after the Engine preparation signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let prepared, gpu;
  const preparationCompleted = new Promise((resolve) => {
    prepared = resolve;
  });
  const completed = new Promise((resolve) => {
    gpu = resolve;
  });
  let draws = 0;
  const reads = [];
  const result = drawReadyFrame(
    {
      requestObservation: () => ({ ok: true }),
      draw: () => ({
        ok: true,
        value:
          ++draws === 1
            ? {
                frameId: 1,
                presentation: 'pending',
                observationDomains: ['final-display'],
                preparationCompleted,
                completed,
              }
            : {
                frameId: 2,
                presentation: 'ready',
                observationDomains: ['final-display'],
                completed: Promise.resolve({ ok: true }),
              },
      }),
      observe: async (receipt) => {
        reads.push(receipt.frameId);
        return { ok: true, value: {} };
      },
    },
    {},
    ['final-display'],
  );
  const observed = result.catch((error) => error);
  await new Promise(setImmediate);
  t.mock.timers.tick(4_000);
  prepared({ ok: true });
  await new Promise(setImmediate);
  t.mock.timers.tick(12_000);
  gpu({ ok: true });
  assert.equal((await observed).presentation, 'ready');
  assert.equal(draws, 2);
  assert.deepEqual(reads, [1]);
});

test('GPU failure interrupts an unresolved preparation signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const error = new Error('device lost during pipeline preparation');
  let actual;
  const result = completeReadyFrame(async () => ({
    presentation: 'pending',
    completed: Promise.resolve({ ok: false, error }),
    preparationCompleted: new Promise(() => {}),
  })).catch((failure) => {
    actual = failure;
  });
  await new Promise(setImmediate);
  assert.equal(actual, error);
  await result;
});

test('default scene settlement stays bounded across successful preparation waves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let draws = 0;
  await assert.rejects(
    completeReadyFrame(async () => {
      draws++;
      t.mock.timers.tick(10_000);
      return {
        presentation: 'pending',
        presentationPendingReason: { code: 'scene-pipeline-preparation' },
        completed: Promise.resolve({ ok: true }),
        preparationCompleted: Promise.resolve({ ok: true }),
      };
    }),
    /Renderer scene presentation did not become ready/,
  );
  assert.equal(Date.now(), 90_000);
  assert.equal(draws, 9);
});

test('a cold owner budget does not lengthen a stalled GPU submission', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const result = completeReadyFrame(async () => new Promise(() => {}), { timeoutMs: 90_000 });
  const rejected = assert.rejects(
    result,
    /Renderer scene presentation did not become ready.*submission/,
  );
  await new Promise(setImmediate);
  t.mock.timers.tick(15_000);
  await rejected;
});

test('a cold owner budget does not lengthen a stalled GPU completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const result = completeReadyFrame(
    async () => ({
      presentation: 'ready',
      completed: new Promise(() => {}),
    }),
    { timeoutMs: 90_000 },
  );
  const rejected = assert.rejects(
    result,
    /Renderer scene presentation did not become ready.*gpu-completion/,
  );
  await new Promise(setImmediate);
  t.mock.timers.tick(15_000);
  await rejected;
});

test('physical completion consumers retain their own fifteen-second bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const result = completeReadyFrame(
    async () => ({
      presentation: 'ready',
      completed: Promise.resolve({ ok: true }),
    }),
    { onCompleted: () => new Promise(() => {}) },
  );
  const rejected = assert.rejects(result, /completion-consumer/);
  await new Promise(setImmediate);
  t.mock.timers.tick(15_000);
  await rejected;
});

test('a ready picture stalled at its GPU fence reports the GPU owner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const result = drawReadyFrame(
    {
      draw: () => ({
        ok: true,
        value: { presentation: 'ready', completed: new Promise(() => {}) },
      }),
    },
    {},
  );
  const rejected = assert.rejects(
    result,
    (error) =>
      error.message.includes('"phase":"gpu-completion"') &&
      error.message.includes('"presentation":"ready"'),
  );
  await new Promise(setImmediate);
  t.mock.timers.tick(15_000);
  await rejected;
});

test('a late preparation signal cannot submit after the owner deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let release;
  let draws = 0;
  const preparationCompleted = new Promise((resolve) => {
    release = resolve;
  });
  const result = completeReadyFrame(
    async () => {
      draws++;
      return {
        presentation: 'pending',
        completed: Promise.resolve({ ok: true }),
        preparationCompleted,
      };
    },
    { timeoutMs: 30_000 },
  );
  const rejected = assert.rejects(result, /Renderer scene presentation did not become ready/);
  await new Promise(setImmediate);
  t.mock.timers.tick(30_000);
  await rejected;
  release({ ok: true });
  await new Promise(setImmediate);
  assert.equal(draws, 1);
});

test('compilation failure ends waiting without another draw', async () => {
  const error = new Error('native compilation failed');
  let draws = 0;
  await assert.rejects(
    completeReadyFrame(async () => {
      draws++;
      return {
        presentation: 'pending',
        completed: Promise.resolve({ ok: true }),
        preparationCompleted: Promise.resolve({ ok: false, error }),
      };
    }),
    (actual) => actual === error,
  );
  assert.equal(draws, 1);
});

test('a missing required pipeline signal fails closed', async () => {
  await assert.rejects(
    completeReadyFrame(async () => ({
      presentation: 'pending',
      presentationPendingReason: { code: 'material-pipeline-preparation' },
      completed: Promise.resolve({ ok: true }),
    })),
    /omitted its compilation completion signal/,
  );
});

for (const code of ['scene-pipeline-preparation', 'draw-entity-missing']) {
  test(`first ready GPU work after signalled ${code} preparation uses the remaining owner budget`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let finish;
    let draws = 0;
    const completed = new Promise((resolve) => {
      finish = resolve;
    });
    const result = completeReadyFrame(async () =>
      ++draws === 1
        ? {
            presentation: 'pending',
            presentationPendingReason: { code },
            preparationCompleted: Promise.resolve({ ok: true }),
            completed: Promise.resolve({ ok: true }),
          }
        : { presentation: 'ready', completed },
    );
    const observed = result.catch((error) => error);
    await new Promise(setImmediate);
    t.mock.timers.tick(20_000);
    finish({ ok: true });
    assert.equal((await observed).presentation, 'ready');
    assert.equal(draws, 2);
  });
}

test('a stalled first ready GPU completion still fails at the original total owner deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let draws = 0;
  let settled = false;
  const result = completeReadyFrame(async () =>
    ++draws === 1
      ? {
          presentation: 'pending',
          presentationPendingReason: { code: 'scene-pipeline-preparation' },
          preparationCompleted: Promise.resolve({ ok: true }),
          completed: Promise.resolve({ ok: true }),
        }
      : { presentation: 'ready', completed: new Promise(() => {}) },
  ).catch((error) => {
    settled = true;
    return error;
  });
  await new Promise(setImmediate);
  t.mock.timers.tick(89_999);
  await new Promise(setImmediate);
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.match((await result).message, /gpu-completion/);
});

test('an environment-only barrier does not extend the ready GPU completion bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let draws = 0;
  const result = completeReadyFrame(async () =>
    ++draws === 1
      ? {
          presentation: 'pending',
          presentationPendingReason: { code: 'environment-not-ready' },
          preparationCompleted: Promise.resolve({ ok: true }),
          completed: Promise.resolve({ ok: true }),
        }
      : { presentation: 'ready', completed: new Promise(() => {}) },
  );
  const rejected = assert.rejects(result, /gpu-completion/);
  await new Promise(setImmediate);
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(draws, 2);
});

test('actual archive startup preparation shares the existing cold GPU window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let completePreparation;
  let draws = 0;
  let settled = false;
  const preparationCompleted = new Promise((resolve) => {
    completePreparation = resolve;
  });
  const result = completeReadyFrame(
    async () => {
      draws++;
      return { presentation: 'ready', completed: new Promise(() => {}) };
    },
    { preparationCompleted },
  ).catch((error) => {
    settled = true;
    return error;
  });
  await new Promise(setImmediate);
  assert.equal(draws, 0, 'startup preparation must settle before submission');
  completePreparation({ ok: true });
  await new Promise(setImmediate);
  assert.equal(draws, 1);
  t.mock.timers.tick(15_000);
  await new Promise(setImmediate);
  assert.equal(settled, false, 'actual archive preparation owns the existing cold window');
  t.mock.timers.tick(75_000);
  assert.match((await result).message, /gpu-completion/);
  assert.equal(draws, 1, 'a stalled native fence is never retried');
});

test('failed archive startup preparation cannot admit any frame', async () => {
  const error = new Error('archive compilation failed');
  let draws = 0;
  await assert.rejects(
    completeReadyFrame(
      async () => {
        draws++;
      },
      {
        preparationCompleted: Promise.resolve({ ok: false, error }),
      },
    ),
    (cause) => cause === error,
  );
  assert.equal(draws, 0);
});

test('stalled archive startup preparation retains its fifteen-second stage', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let draws = 0;
  const result = completeReadyFrame(
    async () => {
      draws++;
    },
    {
      preparationCompleted: new Promise(() => {}),
    },
  );
  const rejected = assert.rejects(result, /preparation/);
  await new Promise(setImmediate);
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(draws, 0);
});
