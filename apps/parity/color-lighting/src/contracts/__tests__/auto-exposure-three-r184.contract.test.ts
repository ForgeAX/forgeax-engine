import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import caseReportSchema from '../../../schemas/case-report.schema.json' with { type: 'json' };
import { AUTO_EXPOSURE_SCENE_CASE, AUTO_EXPOSURE_THREE_R184_FIXTURE } from '../auto-exposure-scene-case';
import { THREE_R184_PROVENANCE, validateAutoExposureFixture } from '../../adapters/three-adapter';
import { evaluateAutoExposureParity } from '../../evidence/auto-exposure-parity-report';
import { evaluateAutoExposureBenchmark } from '../../evidence/auto-exposure-benchmark';
import {
  AC27_COMMON_STAGE_MAPPING,
  joinAutoExposureAc27,
  type AutoExposureAc27Capture,
} from '../../evidence/auto-exposure-ac27-join';

const ac27Config = { ...AUTO_EXPOSURE_SCENE_CASE.rendererConfig };
const validateCaseReport = new Ajv2020({ allErrors: true, strict: false }).compile(caseReportSchema);

function ac27Capture(
  side: 'forgeax' | 'three',
  decodedValues: readonly number[],
  overrides: Partial<AutoExposureAc27Capture> = {},
): AutoExposureAc27Capture {
  const provenance = side === 'three'
    ? {
        implementation: 'three' as const,
        package: THREE_R184_PROVENANCE.package,
        version: THREE_R184_PROVENANCE.version,
        commit: THREE_R184_PROVENANCE.commit,
        integrity: THREE_R184_PROVENANCE.integrity,
        backend: 'webgpu' as const,
      }
    : {
        implementation: 'forgeax' as const,
        package: '@forgeax/engine' as const,
        version: 'workspace',
        commit: 'a'.repeat(40),
        build: '28d25fbcd40e71a91c81aa574895ec0dea0c2f33',
        backend: 'browser-webgpu' as const,
      };
  const stages = AC27_COMMON_STAGE_MAPPING.map(({ stage, domain }) => ({
    stage,
    domain,
    values: stage === 'decoded-sRGB-roi' ? decodedValues : [0.1, 0.2],
    rawHash: 'a'.repeat(64),
  }));
  return {
    side,
    referenceLane: 'direct',
    testedRevision: 'b'.repeat(40),
    runner: { kind: 'contract', id: `${side}-r184` },
    resolution: { width: 1920, height: 1080 },
    provenance,
    fixtureIdentity: AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity,
    scene: AUTO_EXPOSURE_THREE_R184_FIXTURE,
    config: ac27Config,
    stages,
    ...overrides,
  };
}

describe('auto exposure Three.js r184 contract', () => {
  it('pins provenance, fixture identity, renderer fields, and comparable stages', () => {
    expect(THREE_R184_PROVENANCE.version).toBe('0.184.0');
    expect(THREE_R184_PROVENANCE.commit).toBe('d3b629c0c2097cec664ad16369bb6eae3b10e335');
    expect(THREE_R184_PROVENANCE.integrity).toMatch(/^sha512-/);
    expect(validateAutoExposureFixture(AUTO_EXPOSURE_SCENE_CASE).ok).toBe(true);
    expect(AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity.asset.id).toBeTruthy();
    expect(AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity.camera.id).toBeTruthy();
    expect(AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity.light.id).toBeTruthy();
    expect(AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity.input.id).toBeTruthy();
    expect(AUTO_EXPOSURE_SCENE_CASE.rendererFields).toEqual([
      'toneMapping',
      'toneMappingExposure',
      'outputColorSpace',
    ]);
    expect(AUTO_EXPOSURE_SCENE_CASE.commonStages).toContain('decoded-sRGB-roi');
    expect(AUTO_EXPOSURE_SCENE_CASE.roiEpsilon).toBeLessThanOrEqual(0.05);
    expect(AUTO_EXPOSURE_SCENE_CASE.overallParityClaim).toBe(false);
    expect(AUTO_EXPOSURE_THREE_R184_FIXTURE.asset.barLayout).toEqual([
      { offset: -0.5, color: [0.95, 0.12, 0.1, 1] },
      { offset: 0, color: [0.1, 0.85, 0.2, 1] },
      { offset: 0.5, color: [0.1, 0.25, 0.95, 1] },
    ]);
    expect(AUTO_EXPOSURE_THREE_R184_FIXTURE.camera).toMatchObject({ fovDeg: 60, aspect: 16 / 9, near: 0.1, far: 100, position: [0, 0, 2.5] });
    expect(AUTO_EXPOSURE_THREE_R184_FIXTURE.light).toMatchObject({ direction: [-0.4, -0.6, -0.7], intensity: 1.2 });
  });

  it('records incomparable auto/TAAU/producer stages as not-applicable', () => {
    expect(AUTO_EXPOSURE_SCENE_CASE.notApplicable).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'auto-exposure' }),
      expect.objectContaining({ stage: 'TAAU' }),
      expect.objectContaining({ stage: 'cube-producer' }),
    ]));
  });

  it('fails closed when a live common-stage readback is missing', () => {
    const result = evaluateAutoExposureParity(undefined, undefined);
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/readbacks/);
    expect(result.overallParityClaim).toBe(false);
  });

  it('compares only decoded-sRGB values from the shared fixture', () => {
    const result = evaluateAutoExposureParity(ac27Capture('forgeax', [0.2, 0.3]), ac27Capture('three', [0.2, 0.31]));
    expect(result.status).toBe('passed');
    expect(result.readback.domain).toBe('decoded-sRGB');
    expect(result.readback.roiEpsilon).toBeCloseTo(0.01);
  });

  it('blocks sparse legacy captures without exact producer provenance', () => {
    const result = evaluateAutoExposureParity(
      { side: 'forgeax', fixtureIdentity: AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity, config: {}, stages: [] } as never,
      { side: 'three', fixtureIdentity: AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity, config: {}, stages: [] } as never,
    );
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('identities');
    expect(result.readback.roiEpsilon).toBeNull();
  });

  it('fails closed when no qualified timestamp samples exist', () => {
    const result = evaluateAutoExposureBenchmark([], [{ lane: 'swiftshader', reason: 'software adapter is ineligible' }]);
    expect(result.status).toBe('blocked');
    expect(result.p95['1920x1080']).toBeNull();
    expect(result.ineligible[0]?.reason).toContain('ineligible');
  });

  it('joins only exact r184 producers on the shared fixture and common stages', () => {
    const result = joinAutoExposureAc27({
      forgeax: ac27Capture('forgeax', [0.2, 0.3]),
      three: ac27Capture('three', [0.2, 0.31]),
    });
    expect(result.status).toBe('passed');
    expect(result.kind).toBe('auto-exposure-three-r184-ac27');
    expect(result.referenceLane).toBe('direct');
    expect(result.readback.domain).toBe('decoded-sRGB');
    expect(result.readback.roiEpsilon).toBeCloseTo(0.01);
    expect(result.readback.rawDelta).toBe(1);
    expect(result.stageMapping).toEqual(AC27_COMMON_STAGE_MAPPING);
    expect(result.overallParityClaim).toBe(false);
    expect(result.errors).toEqual([]);
    expect(validateCaseReport(result)).toBe(true);
  });

  it('blocks stale Three provenance instead of trusting the version string', () => {
    const staleThree = {
      ...ac27Capture('three', [0.2, 0.3]),
      provenance: { ...ac27Capture('three', [0.2, 0.3]).provenance, commit: 'c'.repeat(40) },
    } as unknown as AutoExposureAc27Capture;
    const result = joinAutoExposureAc27({ forgeax: ac27Capture('forgeax', [0.2, 0.3]), three: staleThree });
    expect(result.status).toBe('blocked');
    expect(result.errors.map((error) => error.code)).toContain('three-provenance-mismatch');
  });

  it('blocks a fixture identity mismatch and missing common-stage readback', () => {
    const wrongFixture = {
      ...ac27Capture('three', [0.2, 0.3]),
      fixtureIdentity: {
        ...AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity,
        asset: { ...AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity.asset, sha256: 'd'.repeat(64) },
      },
    } as unknown as AutoExposureAc27Capture;
    const mismatch = joinAutoExposureAc27({ forgeax: ac27Capture('forgeax', [0.2, 0.3]), three: wrongFixture });
    expect(mismatch.status).toBe('blocked');
    expect(mismatch.errors.map((error) => error.code)).toContain('fixture-mismatch');

    const missingReadback = joinAutoExposureAc27({
      forgeax: { ...ac27Capture('forgeax', [0.2, 0.3]), stages: ac27Capture('forgeax', [0.2, 0.3]).stages.slice(0, 3) },
      three: ac27Capture('three', [0.2, 0.3]),
    });
    expect(missingReadback.status).toBe('blocked');
    expect(missingReadback.errors.map((error) => error.code)).toContain('stage-mapping-invalid');
    expect(validateCaseReport(missingReadback)).toBe(true);
  });

  it('blocks a scene-parameter mismatch even when identity labels are unchanged', () => {
    const wrongScene = {
      ...ac27Capture('three', [0.2, 0.3]),
      scene: {
        ...AUTO_EXPOSURE_THREE_R184_FIXTURE,
        camera: { ...AUTO_EXPOSURE_THREE_R184_FIXTURE.camera, aspect: 1 },
      },
    } as unknown as AutoExposureAc27Capture;
    const result = joinAutoExposureAc27({ forgeax: ac27Capture('forgeax', [0.2, 0.3]), three: wrongScene });
    expect(result.status).toBe('blocked');
    expect(result.errors.map((error) => error.code)).toContain('fixture-mismatch');
  });

  it('fails, rather than blocks, a complete common-stage capture above epsilon', () => {
    const result = joinAutoExposureAc27({
      forgeax: ac27Capture('forgeax', [0.2, 0.3]),
      three: ac27Capture('three', [0.2, 0.36]),
    });
    expect(result.status).toBe('failed');
    expect(result.readback.roiEpsilon).toBeCloseTo(0.06);
    expect(result.reason).toContain('exceeds epsilon');
    expect(result.overallParityClaim).toBe(false);
  });

  it('blocks a positive LUT setting because Three has no equivalent sampled fixture', () => {
    const positiveLut = {
      ...ac27Capture('forgeax', [0.2, 0.3]),
      config: { ...ac27Config, lut: { sourceKey: 'auto-exposure-positive-lut', generation: 1, strength: 1 } },
    } as unknown as AutoExposureAc27Capture;
    const result = joinAutoExposureAc27({ forgeax: positiveLut, three: ac27Capture('three', [0.2, 0.3]) });
    expect(result.status).toBe('blocked');
    expect(result.errors.map((error) => error.code)).toContain('renderer-config-mismatch');
  });
});
