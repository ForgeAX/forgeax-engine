import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAbsenceReport, scanSource } from '../check-renderer-recovery-absence.mjs';

const root = new URL('../../..', import.meta.url).pathname;

test('a clean recovery surface has no AC-20 matches', () => {
  const matches = scanSource({
    path: 'packages/render/src/assembly/recovery/generation.ts',
    source: `
      async function recoverOnce() {
        const candidate = await buildGenerationAggregate({ scope, device, context });
        if (!candidate.ok) return candidate;
        publishGeneration(publication, candidate.value, () => true);
      }
    `,
  });
  assert.deepEqual(matches, []);
});

test('each prohibited owner mechanism reports a rule and source location', () => {
  const fixtures = [
    ['second-recovery-owner', 'const manager = new RecoveryManager();'],
    ['global-gpu-ledger', 'const globalGpuResourceLedger = new Map();'],
    ['app-recovery-retry', 'renderer.recover();'],
    ['recovery-backend-switch', 'async function recoverOnce() { selectBackendForRecovery(); }'],
    ['raw-device-destroy', 'rawDevice.destroy();'],
    ['recovery-specific-graph', 'const recoveryGraph = buildRecoveryGraph();'],
    ['second-submit-path', 'function submitRecoveryFrame() {}'],
  ];
  for (const [ruleId, source] of fixtures) {
    const path =
      ruleId === 'app-recovery-retry'
        ? 'packages/app/src/internal/frame-loop.ts'
        : 'packages/render/src/assembly/recovery/generation.ts';
    const matches = scanSource({ path, source });
    assert.ok(
      matches.some((match) => match.ruleId === ruleId),
      `${ruleId} was not reported`,
    );
    assert.ok(matches.every((match) => match.line >= 1 && match.column >= 1));
  }
});

test('recovery active swaps and manual cleanup are scoped to the recovery function', () => {
  const matches = scanSource({
    path: 'packages/render/src/assembly/factory.ts',
    source: `
      async function recoverOnce() {
        const candidate = await buildGenerationAggregate({ scope, device, context });
        internals.device = device;
        internals.context.unconfigure();
        previousGpuStore.destroyAll();
        renderSystem.resetForRecover();
        publishRendererGeneration(candidate.value);
      }
    `,
  });
  assert.ok(matches.some((match) => match.ruleId === 'recovery-early-active-swap'));
  assert.ok(matches.some((match) => match.ruleId === 'recovery-manual-cleanup'));
});

test('the current repository is the red contract until the owner repair lands', () => {
  const report = buildAbsenceReport({ root });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.matches, []);
});
