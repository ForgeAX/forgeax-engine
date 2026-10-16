import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const runner = resolve(repositoryRoot, 'packages/vite-plugin-pack/scripts/m0-baseline-runner.mjs');
// This fixture checks accounting, not the historical feature's full Git range.
// A reachable parent keeps the real workspace diff bounded as the repo grows.
const baselineCommit = execFileSync('git', ['rev-parse', 'HEAD^'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
const schema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, 'packages/vite-plugin-pack/scripts/m0-baseline-runner.schema.json'),
    'utf8',
  ),
) as { required: string[] };

function createBaselineFixture(): string {
  const featureDirectory = mkdtempSync(join(tmpdir(), 'forgeax-m0-baseline-'));
  const design = '# M0 baseline fixture\n';
  const evidenceDirectory = resolve(featureDirectory, 'evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    resolve(featureDirectory, 'requirements.json'),
    JSON.stringify({
      designAuthority: {
        sha256: createHash('sha256').update(design).digest('hex'),
      },
    }),
  );
  writeFileSync(resolve(featureDirectory, 'design.md'), design);
  writeFileSync(
    resolve(evidenceDirectory, 'm0-baseline.json'),
    JSON.stringify({
      identity: {
        commitSha: baselineCommit,
        sourceFileCount: 42,
        sourceLines: 12589,
        stableFingerprint: '0'.repeat(64),
      },
      structural: { productionFiles: 42, productionLines: 12589 },
      baselineConflicts: {
        historicalDesign: {
          productionFiles: 39,
          productionLines: 11972,
          status: 'historical-not-adjudicated',
        },
        partialResearch: {
          productionFiles: 31,
          productionLines: 9612,
          status: 'partial-not-adjudicated',
        },
        currentCheckout: { productionFiles: 34, productionLines: 9612 },
        decision: 'preserve-conflict-until-authority-adjudicates',
      },
    }),
  );
  return featureDirectory;
}

// Loop state is deliberately floating and ignored; this fixture keeps the
// source gate reproducible in a clean checkout without importing that state.
const featureDirectory = createBaselineFixture();
const frozenM0Baseline = resolve(featureDirectory, 'evidence/m0-baseline.json');
afterAll(() => rmSync(featureDirectory, { recursive: true, force: true }));

type FrozenM0Baseline = {
  identity: { sourceFileCount: number; sourceLines: number; stableFingerprint: string };
  structural: { productionFiles: number; productionLines: number };
  baselineConflicts: unknown;
};

function runBaseline(args: readonly string[] = []): Record<string, unknown> {
  return JSON.parse(
    execFileSync(process.execPath, [runner, '--feature-dir', featureDirectory, ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }),
  );
}

function readFrozenM0Baseline(): FrozenM0Baseline {
  return JSON.parse(readFileSync(frozenM0Baseline, 'utf8')) as FrozenM0Baseline;
}

describe('M0 baseline runner', () => {
  let baseline: Record<string, unknown>;
  // These assertions all observe the same immutable fixture and checkout.
  beforeAll(() => {
    baseline = runBaseline();
  }, 15_000);
  it('emits every identity-bound baseline field', () => {
    for (const key of schema.required) expect(baseline).toHaveProperty(key);
    expect(baseline.sourceFailureAndStaleOutputAreDistinct).toBe(true);
    expect((baseline.identity as { designMatchesExpected: boolean }).designMatchesExpected).toBe(
      true,
    );
  });

  it('does not turn unknown measurements or historical conflicts into passes', () => {
    expect((baseline.behavior as { status: string }).status).toBe('not-measured');
    expect((baseline.coldWarmDdcP95 as { status: string }).status).toBe('not-measured');
    expect((baseline.closeDrain as { status: string }).status).toBe('not-measured');
    expect((baseline.deletionLedger as { status: string }).status).toBe('not-adjudicated');
    expect(baseline.deletionLedger).not.toHaveProperty('revisionMode');
    expect((baseline.baselineConflicts as { decision: string }).decision).toBe(
      'preserve-conflict-until-authority-adjudicates',
    );
    expect((baseline.sourceFailureClassification as { observed: boolean }).observed).toBe(false);
  }, 15_000);

  it('compares current source structure with the frozen identity-bound M0 baseline', () => {
    const frozen = readFrozenM0Baseline();
    const structural = baseline.structural as { productionFiles: number; productionLines: number };
    expect(frozen.identity.sourceFileCount).toBe(frozen.structural.productionFiles);
    expect(frozen.identity.sourceLines).toBe(frozen.structural.productionLines);
    expect(frozen.identity.stableFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(structural.productionFiles).toBeLessThanOrEqual(30);
    expect(structural.productionFiles).toBeLessThan(frozen.structural.productionFiles);
    expect(structural.productionLines).toBeLessThan(frozen.structural.productionLines);
    expect(frozen.structural.productionLines - structural.productionLines).toBeGreaterThan(0);
    const currentConflicts = baseline.baselineConflicts as {
      currentCheckout: { productionFiles: number; productionLines: number };
      partialResearch: unknown;
      historicalDesign: unknown;
      decision: unknown;
    };
    const frozenConflicts = frozen.baselineConflicts as {
      currentCheckout: { productionFiles: number; productionLines: number };
      partialResearch: unknown;
      historicalDesign: unknown;
      decision: unknown;
    };
    expect(currentConflicts.currentCheckout).toEqual({
      productionFiles: structural.productionFiles,
      productionLines: structural.productionLines,
    });
    expect(currentConflicts.partialResearch).toEqual(frozenConflicts.partialResearch);
    expect(currentConflicts.historicalDesign).toEqual(frozenConflicts.historicalDesign);
    expect(currentConflicts.decision).toEqual(frozenConflicts.decision);
  });

  it('measures final structural and workspace production deltas only in final mode', () => {
    const baseline = runBaseline(['--final']);
    expect(baseline.finalMode).toBe(true);
    expect((baseline.deletionLedger as { status: string }).status).toBe('measured');
    expect(['commit-range', 'checked-out-worktree']).toContain(
      (baseline.deletionLedger as { revisionMode: string }).revisionMode,
    );
    expect(baseline.deletionLedger).toMatchObject({ baseCommit: baselineCommit });
    expect(
      (baseline.structural as { largestFunctionPath: string }).largestFunctionPath.replaceAll(
        '\\',
        '/',
      ),
    ).toContain('/packages/vite-plugin-pack/');
    // Final mode scans the checked-out workspace and git range; keep its
    // bounded budget above the ordinary unit default under contended CI.
  }, 15_000);
});
