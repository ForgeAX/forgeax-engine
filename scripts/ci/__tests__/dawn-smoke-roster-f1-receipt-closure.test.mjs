import assert from 'node:assert/strict';
import test from 'node:test';
import { validateShardReport } from '../run-dawn-smoke-roster.mjs';

const entry = {
  package: '@forgeax/direct',
  path: 'apps/hello/direct/package.json',
  gateId: 'direct/dawn',
  commandId: 'smoke',
};

function completeResult(overrides = {}) {
  return {
    ...entry,
    shardIndex: 0,
    command: 'pnpm --filter @forgeax/direct smoke',
    exitCode: 0,
    signal: null,
    timedOut: false,
    unavailable: false,
    skipped: false,
    unavailableOrSkipped: false,
    status: 'pass',
    result: 'pass',
    failureReason: null,
    logPath: 'logs/direct.log',
    logSha256: 'a'.repeat(64),
    logBytes: 128,
    receipt: {
      schemaVersion: 1,
      gateId: entry.gateId,
      commandId: entry.commandId,
      framesObserved: 60,
      completed: true,
      rawLine: '[forgeax-smoke-receipt] {"framesObserved":60}',
      rawLineSha256: 'b'.repeat(64),
      parserId: 'forgeax-smoke-receipt-v1',
    },
    framesObserved: 60,
    framesExpected: 60,
    commandResults: [],
    ...overrides,
  };
}

function completeReport(overrides = {}) {
  return {
    schemaVersion: 3,
    kind: 'dawn-smoke-shard',
    head: '0'.repeat(40),
    expectedProductSha: '0'.repeat(40),
    rosterDigest: 'a'.repeat(64),
    shardIndex: 0,
    shardCount: 3,
    framesExpected: 60,
    declaredGateIds: [entry.gateId],
    runnableGateIds: [entry.gateId],
    excludedGateIds: [],
    assignedGateIds: [entry.gateId],
    declaredEntries: [{ package: entry.package, path: entry.path }],
    runnableEntries: [completeResult()],
    exclusions: [],
    assignedEntries: [{ gateId: entry.gateId, commandId: entry.commandId }],
    ...overrides,
  };
}

test('strict shard closure rejects a missing ledger field', () => {
  const report = completeReport();
  delete report.declaredGateIds;
  assert.throws(() => validateShardReport(report), /declaredGateIds/i);
});

test('strict command evidence requires result and log facts', () => {
  const report = completeReport({
    runnableEntries: [completeResult({ logSha256: undefined, result: undefined })],
  });
  assert.throws(() => validateShardReport(report), /logSha256|result/i);
});

test('strict shard closure rejects assigned gates outside runnable closure', () => {
  const report = completeReport({ assignedGateIds: ['unknown/gate'] });
  assert.throws(() => validateShardReport(report), /assigned|runnable|closure/i);
});

test('strict shard closure rejects unknown result tokens', () => {
  const report = completeReport({
    runnableEntries: [completeResult({ status: 'green', result: 'green' })],
  });
  assert.throws(() => validateShardReport(report), /status|result|token/i);
});
