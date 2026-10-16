// @perf-budget-skip: intentional M0 baseline subprocess and git-fixture integration gate.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const baselineRunner = resolve(
  repositoryRoot,
  'packages/vite-plugin-pack/scripts/m0-baseline-runner.mjs',
);
const auditRunner = resolve(
  repositoryRoot,
  'packages/vite-plugin-pack/scripts/m0-branch-identity-audit.mjs',
);
type BaselineFixture = {
  staleDistClassification: { classification: string };
  behavior: {
    failureClassification: { staleOutput: { observed: boolean } };
    closeDrain: { status: string };
  };
  sourceFailureClassification: { status: string; classification: string; observed: boolean };
  sourceFailureAndStaleOutputAreDistinct: boolean;
};

function runFixtureBaseline(): BaselineFixture {
  const fixtureRepository = mkdtempSync(join(tmpdir(), 'forgeax-m0-failure-'));
  try {
    const scriptDirectory = join(fixtureRepository, 'packages/vite-plugin-pack/scripts');
    const sourceDirectory = join(fixtureRepository, 'packages/vite-plugin-pack/src');
    const featureDirectory = join(fixtureRepository, '.forgeax-harness/forgeax-loop/fixture');
    const distDirectory = join(fixtureRepository, 'packages/vite-plugin-pack/dist');
    mkdirSync(scriptDirectory, { recursive: true });
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(featureDirectory, { recursive: true });
    mkdirSync(distDirectory, { recursive: true });
    writeFileSync(join(scriptDirectory, 'm0-baseline-runner.mjs'), readFileSync(baselineRunner));
    writeFileSync(join(scriptDirectory, 'm0-branch-identity-audit.mjs'), readFileSync(auditRunner));
    writeFileSync(
      join(fixtureRepository, 'packages/vite-plugin-pack/package.json'),
      '{"exports":{}}\n',
    );
    writeFileSync(join(sourceDirectory, 'index.ts'), 'export const fixture = true;\n');
    writeFileSync(join(sourceDirectory, 'malformed.ts'), 'export const broken = ;\n');
    writeFileSync(join(sourceDirectory, 'source.meta.json'), '{"meta":');
    writeFileSync(join(distDirectory, 'stale.js'), 'export const stale = true;\n');
    writeFileSync(
      join(distDirectory, '.forgeax-source-identity.json'),
      '{"sourceSha256":"wrong"}\n',
    );
    writeFileSync(join(featureDirectory, 'design.md'), '# Fixture design\n');
    writeFileSync(
      join(featureDirectory, 'requirements.json'),
      '{"designAuthority":{"sha256":null}}\n',
    );
    writeFileSync(join(featureDirectory, 'research-ingest-log.jsonl'), '');
    writeFileSync(
      join(featureDirectory, 'close-events.json'),
      '{"events":["abort","close"],"pending":1,"settled":1}\n',
    );
    execFileSync('git', ['init', '-b', 'fixture-failure'], { cwd: fixtureRepository });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], {
      cwd: fixtureRepository,
    });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: fixtureRepository });
    execFileSync('git', ['add', '.'], { cwd: fixtureRepository });
    execFileSync('git', ['commit', '-m', 'fixture failure'], { cwd: fixtureRepository });
    const baselineOutput = execFileSync(
      process.execPath,
      [join(scriptDirectory, 'm0-baseline-runner.mjs'), '--feature-dir', featureDirectory],
      { cwd: fixtureRepository, encoding: 'utf8' },
    );
    return JSON.parse(baselineOutput) as BaselineFixture;
  } finally {
    rmSync(fixtureRepository, { recursive: true, force: true });
  }
}

describe('M0 baseline failure fixtures', () => {
  it('keeps malformed source and Meta separate from stale output evidence', () => {
    const baseline = runFixtureBaseline();
    expect(baseline.staleDistClassification.classification).toBe('identity-mismatch');
    expect(baseline.behavior.failureClassification.staleOutput.observed).toBe(true);
    expect(baseline.sourceFailureClassification).toEqual({
      status: 'fixture-only',
      classification: 'real-source-failure',
      observed: false,
    });
    expect(baseline.behavior.closeDrain.status).toBe('not-measured');
    expect(baseline.sourceFailureAndStaleOutputAreDistinct).toBe(true);
  }, 30_000);
});
