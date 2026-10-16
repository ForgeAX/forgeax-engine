import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const script = fileURLToPath(new URL('../smoke-rhinull.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('../..', import.meta.url));

function run(env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('admits the default carrier as a structural-only 60-frame matrix', () => {
  const result = run();
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.structuralOnly, true);
  assert.equal(report.acceptance, 'structural-only');
  assert.equal(report.pixel, 'not-applicable');
  assert.equal(report.framesObserved, 60);
  assert.equal(report.matrix.topology.targetCount, 1);
  assert.equal(report.matrix.zeroWork.byteLength, 0);
  assert.equal(report.matrix.failureRecovery.recovered, true);
  assert.equal(report.capabilityUnavailable.reason, 'capability-missing');
  assert.equal(report.capabilityUnavailable.requiredVisualFailure, false);
});

test('required evidence mode preserves the structural-only result', () => {
  const result = run({ FORGEAX_REQUIRED_EVIDENCE: '1' });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.structuralOnly, true);
  assert.equal(report.acceptance, 'structural-only');
  assert.equal(report.pixel, 'not-applicable');
  assert.equal(report.framesObserved, 60);
});

test('feature evidence contract requires three visual cards and staged readback', () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../evidence/schema.json', import.meta.url)), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const fixture = {
    schemaVersion: 'hello-taa-auto-exposure-evidence/1',
    featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
    source: { path: 'src/main.ts', sha256: 'a'.repeat(64) },
    build: { command: 'pnpm --filter @forgeax/hello-taa build', sha256: 'b'.repeat(64) },
    backend: 'browser-webgpu',
    runner: { kind: 'playwright', id: 'local-browser' },
    resolution: { width: 1920, height: 1080 },
    frames: 60,
    frameIdentity: { first: 0, last: 59, sequenceSha256: 'c'.repeat(64) },
    stages: [
      { id: 'linear-hdr', domain: 'linear-HDR', readback: { rawHash: 'd'.repeat(64), frame: 59 } },
      { id: 'linear-ldr', domain: 'linear-LDR', readback: { rawHash: 'e'.repeat(64), frame: 59 } },
      { id: 'final-display', domain: 'final-sRGB', readback: { rawHash: 'f'.repeat(64), frame: 59 } },
    ],
    exposure: { mode: 'auto', ev: { first: 0, last: 0, generation: 1 } },
    lut: { generation: 1, strength: 0, sourceKey: 'none' },
    resourceGrowth: { stableFrames: 60, byteLengthDelta: 0, bindGroupDelta: 0 },
    visualEvidence: ['exposure-adaptation-card', 'white-balance-card', 'lut-output-card'].map((id) => ({
      id, png: `${id}.png`, observed: 'captured', verdict: 'pass', confidence: 'high',
    })),
    falsify: [{ id: 'duplicate-oetf', result: 'pass' }],
    status: 'pass',
  };
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
});

test('visual fixture advertises the three feature cards and stable query cases', () => {
  const cases = JSON.parse(readFileSync(fileURLToPath(new URL('../../evidence/visual-cases.json', import.meta.url)), 'utf8'));
  const featureCases = cases[0]?.featureTargets ?? [];
  assert.deepEqual(featureCases.map((entry) => entry.id), [
    'exposure-adaptation-card',
    'white-balance-card',
    'lut-output-card',
  ]);
  for (const entry of featureCases) {
    assert.equal(entry.url, `/?taa-case=${entry.id}`);
    assert.deepEqual(entry.stages, ['linear-HDR', 'linear-LDR', 'final-sRGB']);
    assert.equal(entry.pngIsSupplemental, true);
  }
});
