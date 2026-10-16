import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  aggregateReports,
  buildShardReport,
  ciSmokeShardTailSeconds,
  discoverCandidates,
  hasUnavailableOrSkipped,
  parseObservedFrameReceipt,
  partitionRunnableEntries,
  readRoster,
  resolveRunnableEntries,
  resultStatus,
  selectSmokeEntries,
  smokeGateSeconds,
  validateShardReport,
} from '../run-dawn-smoke-roster.mjs';

const head = '0123456789abcdef0123456789abcdef01234567';
const digest = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const directGate = {
  gateId: 'direct/smoke',
  commandId: 'smoke',
  executionClass: 'sharded',
  oracle: 'frameReceipt',
};
const excludedGate = {
  gateId: 'browser/smoke',
  commandId: 'smoke',
  executionClass: 'excluded',
  oracle: 'assertion',
};

function fixtureRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forgeax-dawn-roster-'));
  for (const [directory, name, invocation] of [
    ['apps/hello/direct', '@forgeax/direct', 'pnpm --filter @forgeax/direct smoke'],
    ['apps/hello/browser', '@forgeax/browser', 'pnpm --filter @forgeax/browser smoke:all'],
  ]) {
    const packageDirectory = join(repoRoot, directory);
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name, forgeax: { smokeInvocation: invocation } })}\n`,
    );
  }
  const archivedDirectory = join(repoRoot, 'apps/hello/artifacts/sdk-source/apps/archived');
  mkdirSync(archivedDirectory, { recursive: true });
  writeFileSync(
    join(archivedDirectory, 'package.json'),
    `${JSON.stringify({
      name: '@forgeax/archived',
      forgeax: { smokeInvocation: 'pnpm --filter @forgeax/archived smoke' },
    })}\n`,
  );
  return repoRoot;
}

function rosterEntries() {
  return [
    {
      package: '@forgeax/direct',
      path: 'apps/hello/direct/package.json',
      classification: 'run',
      gates: [directGate],
    },
    {
      package: '@forgeax/browser',
      path: 'apps/hello/browser/package.json',
      classification: 'excluded',
      reason: 'browser smoke is not a direct Dawn smoke',
      gates: [excludedGate],
    },
  ];
}

function resolvedRoster() {
  const entries = rosterEntries();
  return {
    declared: entries,
    runnable: [{ ...entries[0], command: 'pnpm --filter @forgeax/direct smoke', ...directGate }],
    independent: [],
    exclusions: [entries[1]],
    declaredGateIds: ['direct/smoke', 'browser/smoke'],
    runnableGateIds: ['direct/smoke'],
    independentGateIds: [],
    excludedGateIds: ['browser/smoke'],
  };
}

function passResult(entry, shardIndex) {
  const rawLine =
    '[forgeax-smoke-receipt] {"schemaVersion":1,"gateId":"direct/smoke","commandId":"smoke","framesObserved":60,"completed":true}';
  return {
    package: entry.package,
    path: entry.path,
    gateId: entry.gateId,
    commandId: entry.commandId,
    shardIndex,
    command: entry.command,
    exitCode: 0,
    signal: null,
    timedOut: false,
    unavailable: false,
    skipped: false,
    unavailableOrSkipped: false,
    framesObserved: 60,
    framesExpected: 60,
    status: 'pass',
    result: 'pass',
    failureReason: null,
    logPath: 'logs/direct.log',
    logSha256: '0'.repeat(64),
    logBytes: 1,
    receipt: {
      schemaVersion: 1,
      gateId: 'direct/smoke',
      commandId: 'smoke',
      framesObserved: 60,
      completed: true,
      rawLine,
      rawLineSha256: '1'.repeat(64),
      parserId: 'forgeax-smoke-receipt-v1',
    },
    commandResults: [{ commandId: 'smoke', command: entry.command, exitCode: 0, status: 'pass' }],
  };
}

function blockedResult(entry, shardIndex) {
  return {
    ...passResult(entry, shardIndex),
    framesObserved: null,
    status: 'blocked',
    result: 'blocked',
    failureReason: 'missing-frame-evidence',
    receipt: null,
    commandResults: [
      { commandId: 'smoke', command: entry.command, exitCode: 0, status: 'blocked' },
    ],
  };
}

function shard(index, results) {
  const resolved = resolvedRoster();
  return {
    schemaVersion: 3,
    kind: 'dawn-smoke-shard',
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    shardIndex: index,
    shardCount: 3,
    framesExpected: 60,
    declaredGateIds: resolved.declaredGateIds,
    runnableGateIds: resolved.runnableGateIds,
    independentGateIds: resolved.independentGateIds,
    excludedGateIds: resolved.excludedGateIds,
    declaredEntries: resolved.declared,
    runnableEntries: results,
    exclusions: resolved.exclusions,
    assignedGateIds: results.map((result) => result.gateId),
    assignedEntries: results.map(({ gateId, commandId }) => ({ gateId, commandId })),
  };
}

test('roster is the explicit gate membership authority and keeps command ownership in manifests', () => {
  const roster = readRoster();
  assert.equal(roster.schemaVersion, 3);
  assert.deepEqual(roster.roots, ['apps/hello', 'apps/learn-render']);
  assert.ok(roster.entries.length > 0);
  assert.ok(roster.entries.every((entry) => Array.isArray(entry.gates)));
});

test('transmission aggregation requires both assertion owners and the full canonical receipt', () => {
  const declared = readRoster().entries.filter(
    (entry) => entry.package === '@forgeax/app-learn-render-6-pbr-4-transmission-refraction',
  );
  const runnable = resolveRunnableEntries({ roster: readRoster() }).runnable.filter(
    (entry) => entry.package === declared[0].package,
  );
  assert.equal(runnable.length, 3);
  const resolved = {
    declared,
    runnable,
    independent: [],
    exclusions: [],
    declaredGateIds: runnable.map((entry) => entry.gateId),
    runnableGateIds: runnable.map((entry) => entry.gateId),
    independentGateIds: [],
    excludedGateIds: [],
  };
  const results = runnable.map((entry) => {
    const receipt =
      entry.oracle === 'frameReceipt'
        ? parseObservedFrameReceipt('[smoke] frames observed=300\n[smoke] PASS', {
            ...entry,
            frames: 300,
          })
        : null;
    return {
      ...passResult(entry, 0),
      oracle: entry.oracle,
      framesExpected: 300,
      framesObserved: receipt?.framesObserved ?? null,
      receipt,
      commandResults: [
        { commandId: entry.commandId, command: entry.command, exitCode: 0, status: 'pass' },
      ],
    };
  });
  const reportFor = (selected) =>
    buildShardReport({
      resolved,
      assigned: selected,
      head,
      expectedProductSha: head,
      rosterDigest: digest,
      shardIndex: 0,
      shardCount: 1,
      results: selected,
      frames: 300,
    });
  const aggregate = (selected) =>
    aggregateReports({
      reports: [reportFor(selected)],
      resolved,
      head,
      expectedProductSha: head,
      rosterDigest: digest,
      shardCount: 1,
      frames: 300,
    });
  assert.equal(aggregate(results).status, 'pass');
  for (const index of [0, 1])
    assert.throws(
      () => aggregate(results.filter((_, candidate) => candidate !== index)),
      /missing/,
    );
  assert.throws(() => aggregate([...results, results[0]]), /duplicate/);
  const short = structuredClone(results);
  short[2].framesObserved = 299;
  short[2].receipt.framesObserved = 299;
  assert.throws(() => aggregate(short), /frame/);
});

test('manifest discovery only reports candidates and resolves gate commands', () => {
  const repoRoot = fixtureRepo();
  const candidates = discoverCandidates({ repoRoot, roots: ['apps/hello'] });
  assert.deepEqual(
    candidates.map(({ package: packageName, path }) => ({ package: packageName, path })),
    [
      { package: '@forgeax/browser', path: 'apps/hello/browser/package.json' },
      { package: '@forgeax/direct', path: 'apps/hello/direct/package.json' },
    ],
  );
  const roster = {
    schemaVersion: 3,
    roots: ['apps/hello'],
    entries: rosterEntries(),
  };
  const resolved = resolveRunnableEntries({ repoRoot, roster, roots: ['apps/hello'] });
  assert.deepEqual(resolved.runnable, [
    {
      package: '@forgeax/direct',
      path: 'apps/hello/direct/package.json',
      classification: 'run',
      gateId: 'direct/smoke',
      commandId: 'smoke',
      executionClass: 'sharded',
      oracle: directGate.oracle,
      command: 'pnpm --filter @forgeax/direct smoke',
    },
  ]);
  assert.deepEqual(resolved.exclusions, [rosterEntries()[1]]);
});

test('stable three-way partition covers runnable gates exactly once, including empty shards', () => {
  const entries = [
    { ...directGate, package: '@forgeax/z', path: 'apps/hello/z/package.json' },
    { ...directGate, package: '@forgeax/a', path: 'apps/hello/a/package.json' },
  ];
  const shards = [0, 1, 2].map((shardIndex) =>
    partitionRunnableEntries(entries, { shardIndex, shardCount: 3 }),
  );
  assert.deepEqual(
    shards[0].map((entry) => entry.package),
    ['@forgeax/a'],
  );
  assert.deepEqual(
    shards[1].map((entry) => entry.package),
    ['@forgeax/z'],
  );
  assert.deepEqual(shards[2], []);
  assert.deepEqual(
    shards
      .flat()
      .map((entry) => entry.path)
      .sort(),
    entries.map((entry) => entry.path).sort(),
  );
});

test('the observed slow Smoke fixed tail receives no additional long roster batch', () => {
  const entries = selectSmokeEntries(resolveRunnableEntries({ roster: readRoster() }), 'sharded');
  // Two complete passing Smoke samples supply current fixed-tail medians.
  // Preserve the original bound while removing stale upload reservations.
  const observedFixedTailSeconds = [235, 240, 140, 250];
  const estimatedCompleteSeconds = observedFixedTailSeconds.map(
    (tail, shardIndex) =>
      tail +
      partitionRunnableEntries(entries, { shardIndex, scope: 'sharded' }).reduce(
        (seconds, entry) => seconds + smokeGateSeconds(entry),
        0,
      ),
  );
  assert.ok(
    Math.max(...estimatedCompleteSeconds) <= 700,
    `observed fixed tails plus estimated roster exceed 700 seconds: ${estimatedCompleteSeconds}`,
  );
});

test('smoke-fleet shards balance measured gate seconds against their fixed tails', () => {
  const entries = selectSmokeEntries(resolveRunnableEntries({ roster: readRoster() }), 'sharded');
  const shards = ciSmokeShardTailSeconds.map((_tail, shardIndex) =>
    partitionRunnableEntries(entries, { shardIndex, scope: 'sharded' }),
  );
  assert.deepEqual(
    shards
      .flat()
      .map((entry) => entry.gateId)
      .sort(),
    entries.map((entry) => entry.gateId).sort(),
  );
  const totals = shards.map(
    (assigned, shard) =>
      ciSmokeShardTailSeconds[shard] +
      assigned.reduce((seconds, entry) => seconds + smokeGateSeconds(entry), 0),
  );
  const largest = Math.max(...entries.map(smokeGateSeconds));
  assert.ok(Math.max(...totals) - Math.min(...totals) <= largest, `imbalanced: ${totals}`);
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const fleet = ci.slice(ci.indexOf('  smoke-fleet:\n'), ci.indexOf('  bevy-smoke-fleet:\n'));
  assert.match(fleet, /group: \[0, 1, 2, 3\]/);
  assert.match(fleet, /--shard-index \$\{\{ matrix\.group \}\} --shard-count 4\n/);
});

test('receipt-backed smoke keeps optional unavailable capability text out of the gate verdict', () => {
  const output = '[smoke] PASS - frames=60\\n{"performanceAdmission":{"status":"unavailable"}}';
  assert.equal(hasUnavailableOrSkipped(output), true);
  assert.equal(hasUnavailableOrSkipped(output, { hasReceipt: true }), false);
});

test('exit-zero smoke without a canonical receipt is blocked even when its log mentions skipping', () => {
  const result = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    output: '[postinstall] skipping optional fetch',
  };
  assert.equal(resultStatus(result, null, true), 'blocked');
});

test('aggregate accepts complete evidence and keeps exclusions out of execution results', () => {
  const resolved = resolvedRoster();
  const reports = [shard(0, [passResult(resolved.runnable[0], 0)]), shard(1, []), shard(2, [])];
  const aggregate = aggregateReports({
    reports,
    resolved,
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    shardCount: 3,
  });
  assert.equal(aggregate.status, 'pass');
  assert.deepEqual(
    aggregate.runnableResults.map((entry) => entry.package),
    ['@forgeax/direct'],
  );
  assert.deepEqual(aggregate.exclusions, resolved.exclusions);
});

test('aggregate carries explicitly allowed missing receipts as blocked, never as pass', () => {
  const resolved = resolvedRoster();
  const entry = resolved.runnable[0];
  const reports = [shard(0, [blockedResult(entry, 0)]), shard(1, []), shard(2, [])];
  assert.throws(
    () =>
      aggregateReports({
        reports,
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /blocked/i,
  );
  const aggregate = aggregateReports({
    reports,
    resolved,
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    shardCount: 3,
    allowBlocked: true,
  });
  assert.equal(aggregate.status, 'blocked');
  assert.equal(aggregate.runnableResults[0].status, 'blocked');
  assert.equal(aggregate.runnableResults[0].receipt, null);
});

test('aggregate keeps receipt-less skip text blocked when the defer path is explicitly allowed', () => {
  const resolved = resolvedRoster();
  const entry = resolved.runnable[0];
  const reports = [shard(0, [blockedResult(entry, 0)]), shard(1, []), shard(2, [])];
  reports[0].runnableEntries[0].unavailableOrSkipped = true;
  const aggregate = aggregateReports({
    reports,
    resolved,
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    shardCount: 3,
    allowBlocked: true,
  });
  assert.equal(aggregate.status, 'blocked');
  assert.equal(aggregate.runnableResults[0].status, 'blocked');
});

test('aggregate fails closed for missing, duplicate, stale, skipped, and short-frame evidence', () => {
  const resolved = resolvedRoster();
  const entry = resolved.runnable[0];
  const complete = [shard(0, [passResult(entry, 0)]), shard(1, []), shard(2, [])];
  assert.throws(
    () =>
      aggregateReports({
        reports: complete.slice(0, 2),
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /missing shard/i,
  );
  assert.throws(
    () =>
      aggregateReports({
        reports: [shard(0, [passResult(entry, 0)]), shard(1, [passResult(entry, 1)]), shard(2, [])],
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /duplicate|extra|complete/i,
  );
  assert.throws(
    () =>
      aggregateReports({
        reports: complete.map((report) => ({ ...report, head: '0'.repeat(40) })),
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /head/i,
  );
  assert.throws(
    () =>
      aggregateReports({
        reports: complete.map((report) => ({
          ...report,
          runnableEntries: report.runnableEntries.map((result) => ({
            ...result,
            framesObserved: 59,
            receipt: { ...result.receipt, framesObserved: 59 },
          })),
        })),
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /frame/i,
  );
  assert.throws(
    () =>
      aggregateReports({
        reports: complete.map((report) => ({
          ...report,
          runnableEntries: report.runnableEntries.map((result) => ({
            ...result,
            status: 'fail',
            result: 'fail',
            unavailableOrSkipped: true,
            commandResults: result.commandResults.map((command) => ({
              ...command,
              status: 'fail',
            })),
          })),
        })),
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /pass|unavailable|skipped/i,
  );
  assert.throws(
    () =>
      validateShardReport({
        ...complete[0],
        runnableEntries: [passResult(entry, 0), passResult(entry, 0)],
      }),
    /duplicate/i,
  );
});

test('the complete Bloom carrier and evidence move together to Smoke lane 1', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /- name: Hello-bloom headless smoke \(dawn-node\)\n\s+if: matrix\.group == 1\n/);
  assert.match(
    ci,
    /- name: Upload Hello-bloom smoke evidence\n\s+if: failure\(\) && matrix\.group == 1\n/,
  );
  assert.match(ci, /pnpm --filter @forgeax\/hello-bloom smoke:all/);
  assert.deepEqual(ciSmokeShardTailSeconds, [235, 240, 140, 250]);
});
