import { describe, expect, it } from 'vitest';
import {
  AUTO_EXPOSURE_SCENE_CASE,
  AUTO_EXPOSURE_THREE_R184_FIXTURE,
  THREE_R184_PROVENANCE,
} from '../../contracts/auto-exposure-scene-case';
import { AC27_COMMON_STAGE_MAPPING } from '../../evidence/auto-exposure-ac27-join';
import {
  serializeAutoExposureThreeR184Artifact,
  validateAutoExposureThreeR184Artifact,
  type AutoExposureThreeR184Artifact,
} from '../auto-exposure-three-r184-capture';

function artifact(): AutoExposureThreeR184Artifact {
  const stages = AC27_COMMON_STAGE_MAPPING.map(({ stage, domain }) => ({
    stage,
    domain,
    values: [0.1, 0.2, 0.3, 1],
    rawHash: 'a'.repeat(64),
  }));
  return {
    schemaVersion: 1,
    kind: 'auto-exposure-three-r184-live',
    qualification: 'live-three-r184-webgpu-readback',
    caseId: AUTO_EXPOSURE_SCENE_CASE.caseId,
    side: 'three',
    referenceLane: 'direct',
    testedRevision: 'b'.repeat(40),
    runner: { kind: 'dawn', id: 'contract-dawn' },
    resolution: { width: 128, height: 128 },
    provenance: {
      implementation: 'three',
      package: 'three',
      version: '0.184.0',
      commit: THREE_R184_PROVENANCE.commit,
      integrity: THREE_R184_PROVENANCE.integrity,
      backend: 'webgpu',
    },
    fixtureIdentity: AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity,
    config: { ...AUTO_EXPOSURE_SCENE_CASE.rendererConfig },
    stages,
    scene: AUTO_EXPOSURE_THREE_R184_FIXTURE,
    stageOrder: AC27_COMMON_STAGE_MAPPING,
    renderStates: [
      { stage: 'linear-HDR', toneMapping: 'NoToneMapping', toneMappingExposure: 1, outputColorSpace: 'LinearSRGBColorSpace', targetType: 'HalfFloatType', targetColorSpace: 'LinearSRGBColorSpace' },
      { stage: 'tone-mapping', toneMapping: 'ACESFilmicToneMapping', toneMappingExposure: 1, outputColorSpace: 'LinearSRGBColorSpace', targetType: 'HalfFloatType', targetColorSpace: 'LinearSRGBColorSpace' },
      { stage: 'output-encoding', toneMapping: 'ACESFilmicToneMapping', toneMappingExposure: 1, outputColorSpace: 'SRGBColorSpace', targetType: 'UnsignedByteType', targetColorSpace: 'SRGBColorSpace' },
      { stage: 'decoded-sRGB-roi', toneMapping: 'ACESFilmicToneMapping', toneMappingExposure: 1, outputColorSpace: 'SRGBColorSpace', targetType: 'UnsignedByteType', targetColorSpace: 'SRGBColorSpace' },
    ],
    readback: {
      method: 'readRenderTargetPixelsAsync',
      origin: 'bottom-left',
      roi: { x: 56, y: 20, width: 16, height: 16 },
      stages: [
        { stage: 'linear-HDR', format: 'rgba16float', byteLength: 131072, rawHash: 'a'.repeat(64) },
        { stage: 'tone-mapping', format: 'rgba16float', byteLength: 131072, rawHash: 'a'.repeat(64) },
        { stage: 'output-encoding', format: 'rgba8unorm-srgb', byteLength: 65536, rawHash: 'a'.repeat(64) },
        { stage: 'decoded-sRGB-roi', format: 'decoded-srgb-roi', byteLength: 4096, rawHash: 'a'.repeat(64) },
      ],
    },
    status: 'observation',
    overallParityClaim: false,
    notApplicable: AUTO_EXPOSURE_SCENE_CASE.notApplicable,
  };
}

describe('Three r184 AC-27 live producer contract', () => {
  it('requires a live WebGPU-shaped, exact-head artifact', () => {
    const value = artifact();
    expect(validateAutoExposureThreeR184Artifact(value)).toEqual({ ok: true });
    expect(JSON.parse(serializeAutoExposureThreeR184Artifact(value))).toMatchObject({
      kind: 'auto-exposure-three-r184-live',
      qualification: 'live-three-r184-webgpu-readback',
      overallParityClaim: false,
    });
  });

  it('rejects nonfinite and stale/analytic-shaped evidence', () => {
    const nonFinite = {
      ...artifact(),
      stages: artifact().stages.map((stage, index) => index === 0 ? { ...stage, values: [Number.NaN] } : stage),
    };
    expect(validateAutoExposureThreeR184Artifact(nonFinite).ok).toBe(false);

    const stale = { ...artifact(), testedRevision: 'not-a-revision' };
    expect(validateAutoExposureThreeR184Artifact(stale).ok).toBe(false);

    const analytic = { ...artifact(), qualification: 'analytic-reference' } as unknown as AutoExposureThreeR184Artifact;
    expect(validateAutoExposureThreeR184Artifact(analytic).ok).toBe(false);

    const wrongScene = {
      ...artifact(),
      scene: {
        ...AUTO_EXPOSURE_THREE_R184_FIXTURE,
        asset: { ...AUTO_EXPOSURE_THREE_R184_FIXTURE.asset, radius: 2 },
      },
    } as unknown as AutoExposureThreeR184Artifact;
    expect(validateAutoExposureThreeR184Artifact(wrongScene).ok).toBe(false);
  });
});
