import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const runner = resolve(repoRoot, 'scripts/gauntlet.mjs');
const fixtureRoot = resolve(__dirname, 'fixtures/gauntlet/happy');
const invalidEvidenceRoot = resolve(__dirname, 'fixtures/gauntlet/invalid-evidence');
const artifactRoots: string[] = [];

afterEach(() => {
  for (const artifactRoot of artifactRoots.splice(0))
    rmSync(artifactRoot, { force: true, recursive: true });
});

function run(args: string[]) {
  return spawnSync('node', [runner, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

describe('gauntlet runner', () => {
  it('runs a declared scenario and retains its raw evidence with the oracle verdict', () => {
    const artifacts = mkdtempSync(resolve(tmpdir(), 'forgeax-gauntlet-'));
    artifactRoots.push(artifacts);

    const result = run(['run', 'hello-cube-dawn', '--root', fixtureRoot, '--artifacts', artifacts]);

    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(
      readFileSync(resolve(artifacts, 'hello-cube-dawn', 'result.json'), 'utf8'),
    );
    expect(evidence.scenarioId).toBe('hello-cube-dawn');
    expect(evidence.oracle.passed).toBe(true);
    expect(evidence.environment.node).toMatch(/^v/);
    expect(evidence.phaseInputs).toEqual(['baseline']);
    expect(evidence.evidence).toEqual({
      frontDoors: ['dawn-node'],
      legs: ['semantic', 'gpu'],
    });
    expect(readFileSync(resolve(artifacts, 'hello-cube-dawn', 'stdout.log'), 'utf8')).toContain(
      '[hello-cube] backend=webgpu',
    );
  });

  it('derives domain, package, and risk coverage from scenario declarations', () => {
    const result = run(['audit', '--root', fixtureRoot, '--json']);

    expect(result.status, result.stderr).toBe(0);
    const audit = JSON.parse(result.stdout);
    expect(audit.scenarios).toEqual(['hello-cube-dawn']);
    expect(audit.domains).toEqual({
      'GPU abstraction and implementations': 1,
      'World and host contract': 1,
    });
    expect(audit.packages).toEqual({ '@forgeax/engine-ecs': 1, '@forgeax/engine-runtime': 1 });
    expect(audit.risks).toEqual({ baseline: 1, gpu: 1 });
    expect(audit.frontDoors).toEqual({ 'dawn-node': 1 });
    expect(audit.evidenceLegs).toEqual({ gpu: 1, semantic: 1 });
  });

  it('rejects evidence legs outside the roadmap contract', () => {
    const result = run(['audit', '--root', invalidEvidenceRoot, '--json']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gauntlet-evidence-leg-unknown');
  });

  it('selects the level-switch lifecycle journey and exposes its pressure phases', () => {
    const result = run(['audit', '--root', repoRoot, '--json']);

    expect(result.status, result.stderr).toBe(0);
    const audit = JSON.parse(result.stdout);
    expect(audit.scenarios).toContain('hello-level-switch-dawn');
    expect(audit.risks.dynamic).toBeGreaterThanOrEqual(1);
    expect(audit.risks.churn).toBeGreaterThanOrEqual(1);
    expect(audit.risks.recovery).toBeGreaterThanOrEqual(1);
  });

  it('selects the custom-importer source-to-delivery journey', () => {
    const result = run(['audit', '--root', repoRoot, '--json']);

    expect(result.status, result.stderr).toBe(0);
    const audit = JSON.parse(result.stdout);
    expect(audit.scenarios).toContain('hello-custom-importer-dawn');
    expect(audit.risks.build).toBeGreaterThanOrEqual(1);
    expect(audit.risks.content).toBeGreaterThanOrEqual(1);
    expect(audit.risks.delivery).toBeGreaterThanOrEqual(1);
  });

  it('retains custom-importer malformed-GUID recovery evidence', () => {
    const artifacts = mkdtempSync(resolve(tmpdir(), 'forgeax-gauntlet-custom-importer-'));
    artifactRoots.push(artifacts);

    const result = run([
      'run',
      'hello-custom-importer-dawn',
      '--root',
      repoRoot,
      '--artifacts',
      artifacts,
    ]);

    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(
      readFileSync(resolve(artifacts, 'hello-custom-importer-dawn', 'result.json'), 'utf8'),
    );
    expect(evidence.phaseInputs).toEqual([
      'baseline',
      'content',
      'build',
      'delivery',
      'fault',
      'recovery',
    ]);
    expect(
      readFileSync(resolve(artifacts, 'hello-custom-importer-dawn', 'stdout.log'), 'utf8'),
    ).toContain('[smoke] malformed GUID rejected: pack-guid-malformed; recovery load succeeded');
    expect(
      readFileSync(resolve(artifacts, 'hello-custom-importer-dawn', 'stdout.log'), 'utf8'),
    ).toContain('[smoke] catalog miss rejected: asset-not-imported; recovery load succeeded');
  }, 20_000);

  it('runs the level-switch lifecycle journey three times without a lifecycle regression', () => {
    const statuses = [0, 1, 2].map(() => {
      const artifacts = mkdtempSync(resolve(tmpdir(), 'forgeax-gauntlet-level-switch-'));
      artifactRoots.push(artifacts);
      return run(['run', 'hello-level-switch-dawn', '--root', repoRoot, '--artifacts', artifacts])
        .status;
    });

    expect(statuses).toEqual([0, 0, 0]);
  }, 20_000);

  it('warms both state-transition paths before measuring lifecycle throughput', () => {
    const artifacts = mkdtempSync(resolve(tmpdir(), 'forgeax-gauntlet-level-switch-warmup-'));
    artifactRoots.push(artifacts);

    const result = run([
      'run',
      'hello-level-switch-dawn',
      '--root',
      repoRoot,
      '--artifacts',
      artifacts,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[smoke] warmup transitions complete: tutorial -> street-a');
  });
});
