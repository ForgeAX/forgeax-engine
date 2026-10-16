import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error browser-safe evidence module is intentionally JavaScript.
import { createLinearHdrRoiEvidence, halfToFloat, projectLinearHdrRoi, referenceBytes } from '../../evidence/evaluator-core.mjs';

const evaluatorPath = new URL('../../evidence/evaluator.mjs', import.meta.url);
const manifestPath = new URL('../../evidence/case-manifest.json', import.meta.url);
const referenceArtifactPath = new URL('../../evidence/reference-linear-hdr.json', import.meta.url);
const browserExecutorPath = new URL('../../evidence/browser-executor.mjs', import.meta.url);

describe('physical material semantic evaluator', () => {
  it('shares the linear HDR projection owner across carriers', async () => {
    const pixels = new Uint8Array([0x00, 0x3c, 0x00, 0x40, 0x00, 0x38, 0x00, 0x3c]);
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(projectLinearHdrRoi(pixels, 1, { x: 0, y: 0, width: 1, height: 1 })).toMatchObject({
      rawHash: expect.any(String),
      nonZeroBytes: 4,
      nonZeroAlphaPixels: 1,
      linearHdrMean: [1, 2, 0.5],
    });
    expect(createLinearHdrRoiEvidence(pixels, 1, { x: 0, y: 0, width: 1, height: 1 }, 'fixture', [0, 0, 0])).toMatchObject({
      observed: { linearHdrMean: [1, 2, 0.5] },
      objectMask: { objectPixels: 1, totalPixels: 1 },
    });
  });

  it('fails closed for pending records and rgba8 readback', async () => {
    const evaluator = await import(evaluatorPath.href);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const plan = evaluator.referencePlan(manifest.cases[0], 0);
    expect(
      evaluator.evaluateCaseRecord(
        {
          caseId: manifest.cases[0].caseId,
          verdict: 'blocked',
          reference: plan,
          readback: { status: 'ok', colorSpace: 'srgb' },
        },
        plan,
      ),
    ).toEqual({ verdict: 'fail', reason: 'linear-hdr-readback-required' });
    expect(
      evaluator.evaluateCaseRecord(
        {
          caseId: manifest.cases[0].caseId,
          verdict: 'pass',
          reference: plan,
          readback: { status: 'ok', colorSpace: 'srgb' },
        },
        plan,
      ),
    ).toEqual({ verdict: 'fail', reason: 'linear-hdr-readback-required' });
  });

  it('requires the additive falsifier to fail', async () => {
    const evaluator = await import(evaluatorPath.href);
    expect(
      evaluator.evaluatePairedSentinels({
        'factor-zero-base-parity': { base: [0, 0, 0], factorZero: [0, 0, 0], epsilon: 0.05 },
        'default-custom-surface-physical-parity': { defaultSurface: [0, 0, 0], customSurface: [0, 0, 0], epsilon: 0.05 },
        'additive-coat-falsifier': { metric: 'linear-rgb-l1', baselineEnergy: 1, mutatedEnergy: 1, baselineNoise: 0.001, energyTolerance: 0.05 },
      }),
    ).toEqual({ verdict: 'fail', reason: 'additive-falsifier-did-not-fail' });
  });

  it('fails an additive mutant that stays inside the energy tolerance', async () => {
    const evaluator = await import(evaluatorPath.href);
    expect(
      evaluator.evaluatePairedSentinels({
        'factor-zero-base-parity': { base: [0, 0, 0], factorZero: [0, 0, 0], epsilon: 0.05 },
        'default-custom-surface-physical-parity': { defaultSurface: [0, 0, 0], customSurface: [0, 0, 0], epsilon: 0.05 },
        'additive-coat-falsifier': { metric: 'linear-rgb-l1', baselineEnergy: 1, mutatedEnergy: 1.04, baselineNoise: 0.001, energyTolerance: 0.05 },
      }),
    ).toEqual({ verdict: 'fail', reason: 'additive-falsifier-did-not-fail' });
  });

  it('reports absolute and relative energy deltas for a valid additive falsifier', async () => {
    const evaluator = await import(evaluatorPath.href);
    expect(
      evaluator.evaluatePairedSentinels({
        'factor-zero-base-parity': { base: [0, 0, 0], factorZero: [0, 0, 0], epsilon: 0.05 },
        'default-custom-surface-physical-parity': { defaultSurface: [0, 0, 0], customSurface: [0, 0, 0], epsilon: 0.05 },
        'additive-coat-falsifier': { metric: 'linear-rgb-l1', baselineEnergy: 1, mutatedEnergy: 1.2, baselineNoise: 0.001, energyTolerance: 0.05 },
      }),
    ).toEqual({
      verdict: 'pass',
      reason: 'paired-sentinels-valid',
      additiveEnergyDelta: 0.19999999999999996,
      additiveEnergyRelativeDelta: 0.19999999999999996,
    });
  });

  it('derives case verdict from an independent numeric reference', async () => {
    const evaluator = await import(evaluatorPath.href);
    const unsealedPlan = evaluator.referencePlan({ caseId: 'fixture', reference: {
        expectedLinearHdrMean: [0.2, 0.3, 0.4],
        source: 'external-fixture',
        revision: 'fixture-r1',
        configHash: 'config-hash',
        hash: '0000000000000000000000000000000000000000000000000000000000000000',
      } }, 0);
    const plan = { ...unsealedPlan, referenceHash: evaluator.referenceArtifactHash(unsealedPlan) };
    const validRecord = {
      caseId: 'fixture',
      verdict: 'blocked',
      reference: plan,
      readback: {
        status: 'ok',
        format: 'rgba16float',
        colorSpace: 'linear-hdr',
        frameId: 0,
        pipelineId: 'forgeax::standard',
        backendId: 'webgpu',
      },
      observed: { linearHdrMean: [0.21, 0.3, 0.4] },
      objectMask: { objectPixels: 1, totalPixels: 1, coverage: 1 },
      rawHash: 'roi-hash',
    };
    expect(evaluator.evaluateCaseRecord(validRecord, plan)).toMatchObject({ verdict: 'pass' });
    expect(evaluator.evaluateCaseRecord(validRecord, plan).delta).toBeCloseTo(0.01, 6);
    expect(evaluator.evaluateCaseRecord({
      ...validRecord,
      observed: { linearHdrMean: [0.8, 0.3, 0.4] },
    }, plan)).toMatchObject({ verdict: 'fail', reason: 'reference-out-of-tolerance' });
    expect(evaluator.evaluateCaseRecord({
      ...validRecord,
      reference: { ...plan, referenceHash: 'other-hash' },
    }, plan)).toEqual({ verdict: 'fail', reason: 'reference-provenance-mismatch' });
    expect(evaluator.evaluateCaseRecord({
      ...validRecord,
      reference: { ...plan, referenceHash: '00000000' },
    }, { ...plan, referenceHash: '00000000' })).toEqual({
      verdict: 'fail',
      reason: 'reference-artifact-hash-mismatch',
    });
    expect(evaluator.evaluateCaseRecord(validRecord, {
      ...plan,
      expectedLinearHdrMean: [0.25, 0.3, 0.4],
    })).toEqual({ verdict: 'fail', reason: 'reference-artifact-hash-mismatch' });
    expect(evaluator.evaluateCaseRecord({
      ...validRecord,
      objectMask: { objectPixels: 0, totalPixels: 1, coverage: 0 },
    }, plan)).toEqual({ verdict: 'fail', reason: 'object-coverage-missing' });
  });

  it('verifies every frozen artifact row against its serialized reference bytes', async () => {
    const evaluator = await import(evaluatorPath.href);
    const artifact = JSON.parse(readFileSync(referenceArtifactPath, 'utf8'));
    expect(artifact.cases).toHaveLength(16);
    for (const item of artifact.cases) {
      const plan = evaluator.referencePlan({
        caseId: item.caseId,
        reference: {
          expectedLinearHdrMean: item.expectedLinearHdrMean,
          source: artifact.source,
          revision: artifact.revision,
          configHash: artifact.configHash,
          camera: artifact.camera,
          metric: artifact.metric,
          epsilon: artifact.epsilon,
          roi: item.roi,
          hash: item.referenceHash,
        },
      }, 0);
      expect(evaluator.referenceArtifactHash(plan)).toBe(item.referenceHash);
    }
  });

  it('binds the additive energy metric and frozen noise boundary', async () => {
    const artifact = JSON.parse(readFileSync(referenceArtifactPath, 'utf8'));
    expect(artifact.paired['additive-coat-falsifier']).toEqual({
      metric: 'linear-rgb-l1',
      baselineNoise: 0.001,
      energyTolerance: 0.05,
    });
  });

  it('uses the shared core and rejects a tampered Browser reference', async () => {
    const browser = await import(browserExecutorPath.href);
    const plan = {
      referenceId: 'artifact:case',
      expectedLinearHdrMean: [0.2, 0.3, 0.4],
      referenceSource: 'fixed-reference',
      referenceRevision: 'r1',
      referenceConfigHash: 'config',
      metric: 'linear-hdr-rgb-mean',
      epsilon: 0.05,
      roi: { x: 0, y: 0, width: 1, height: 1 },
      camera: 'camera',
    };
    const referenceHash = createHash('sha256').update(referenceBytes(plan)).digest('hex');
    const manifest = { cases: [{ caseId: 'case' }] };
    const record = {
      caseId: 'case',
      reference: { ...plan, referenceHash },
      readback: {
        status: 'ok', format: 'rgba16float', colorSpace: 'linear-hdr', frameId: 1,
        pipelineId: 'forgeax::standard', backendId: 'webgpu',
      },
      observed: { linearHdrMean: [0.2, 0.3, 0.4] },
      objectMask: { objectPixels: 1, totalPixels: 1, coverage: 1 },
      rawHash: 'roi',
    };
    const validPlans = new Map([['case', { ...plan, referenceHash }]]);
    await expect(browser.evaluateBrowserRecords([record], manifest, validPlans)).resolves.toMatchObject({
      verdict: 'pass',
    });
    await expect(browser.evaluateBrowserRecords([record], manifest, new Map([['case', {
      ...plan,
      expectedLinearHdrMean: [0.9, 0.3, 0.4],
      referenceHash,
    }]])).then((result: { cases: Array<{ reason: string }> }) => result.cases[0])).resolves.toMatchObject({
      reason: 'reference-artifact-hash-mismatch',
    });
  });

  it('fails Browser paired witnesses that only reproduce the clear color', async () => {
    const browser = await import(browserExecutorPath.href);
    const artifact = JSON.parse(readFileSync(referenceArtifactPath, 'utf8'));
    expect(browser.evaluateBrowserPairedSentinels({
      'factor-zero-base-parity': { base: [0, 0, 0], factorZero: [0, 0, 0] },
      'default-custom-surface-physical-parity': { defaultSurface: [0, 0, 0], customSurface: [0, 0, 0] },
      'additive-coat-falsifier': { baseline: [0, 0, 0], mutant: [1, 1, 1] },
    }, artifact)).toEqual({
      verdict: 'fail',
      reason: 'paired-stage-object-coverage-missing',
    });
  });
});
