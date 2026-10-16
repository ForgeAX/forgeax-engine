import {
  AUTO_EXPOSURE_TAA_FIXTURE,
  AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY,
} from '@forgeax/apps-shared/auto-exposure-fixture';

export const THREE_R184_PROVENANCE = {
  package: 'three', version: '0.184.0',
  commit: 'd3b629c0c2097cec664ad16369bb6eae3b10e335',
  integrity: 'sha512-wtTRjG92pM5eUg/KuUnHsqSAlPM296brTOcLgMRqEeylYTh/CdtvKUvCyyCQTzFuStieWxvZb8mVTMvdPyUpxg==',
} as const;

export interface StableFixtureIdentity {
  readonly asset: { readonly id: string; readonly sha256: string };
  readonly camera: { readonly id: string; readonly sha256: string };
  readonly light: { readonly id: string; readonly sha256: string };
  readonly input: { readonly id: string; readonly sha256: string };
}

const AUTO_EXPOSURE_FIXTURE_IDENTITY = {
  ...AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY,
} as const satisfies StableFixtureIdentity;

/**
 * The executable Three.js fixture is shared by the live producer and its
 * evidence projection. Keeping the primitive parameters beside the pinned
 * identities prevents an artifact from merely relabelling a different scene.
 */
export const AUTO_EXPOSURE_THREE_R184_FIXTURE = {
  asset: {
    primitive: 'BoxGeometry',
    dimensions: [1, 1, 1] as const,
    material: { kind: 'MeshBasicMaterial', colorSpace: 'LinearSRGBColorSpace' },
    barLayout: AUTO_EXPOSURE_TAA_FIXTURE.asset.barLayout,
    transform: AUTO_EXPOSURE_TAA_FIXTURE.asset.transform,
    sourceIdentity: AUTO_EXPOSURE_FIXTURE_IDENTITY.asset,
  },
  camera: {
    projection: 'perspective',
    fovDeg: 60,
    aspect: AUTO_EXPOSURE_TAA_FIXTURE.camera.aspect,
    near: AUTO_EXPOSURE_TAA_FIXTURE.camera.near,
    far: AUTO_EXPOSURE_TAA_FIXTURE.camera.far,
    position: AUTO_EXPOSURE_TAA_FIXTURE.camera.position,
    rotation: AUTO_EXPOSURE_TAA_FIXTURE.camera.rotation,
    sourceIdentity: AUTO_EXPOSURE_FIXTURE_IDENTITY.camera,
  },
  light: {
    kind: 'directional',
    direction: AUTO_EXPOSURE_TAA_FIXTURE.light.direction,
    color: AUTO_EXPOSURE_TAA_FIXTURE.light.color,
    intensity: AUTO_EXPOSURE_TAA_FIXTURE.light.intensity,
    target: [0, 0, 0],
    sourceIdentity: AUTO_EXPOSURE_FIXTURE_IDENTITY.light,
  },
  input: AUTO_EXPOSURE_TAA_FIXTURE.input,
  clearColor: AUTO_EXPOSURE_TAA_FIXTURE.clearColor,
} as const;

export const AUTO_EXPOSURE_SCENE_CASE = {
  caseId: 'auto-exposure-three-r184',
  fixtureIdentity: AUTO_EXPOSURE_FIXTURE_IDENTITY,
  rendererFields: ['toneMapping', 'toneMappingExposure', 'outputColorSpace'],
  rendererConfig: { toneMapping: 'ACESFilmicToneMapping', toneMappingExposure: 1, outputColorSpace: 'SRGBColorSpace', lut: 'not-applicable', temporal: 'not-applicable' },
  commonStages: ['linear-HDR', 'tone-mapping', 'output-encoding', 'decoded-sRGB-roi'],
  roiEpsilon: 0.05,
  referenceSides: ['direct', 'clustered'],
  overallParityClaim: false,
  notApplicable: [
    { stage: 'auto-exposure', reason: 'Three.js r184 has no equivalent renderer-owned histogram/adaptation contract' },
    { stage: 'TAAU', reason: 'Three.js fixture has no equivalent ForgeaX temporal upscaler stage' },
    { stage: 'cube-producer', reason: 'Three.js reference does not own ForgeaX Node-only cube import or Pack producer' },
  ],
} as const;

export type AutoExposureSceneCase = typeof AUTO_EXPOSURE_SCENE_CASE;

export function validateAutoExposureFixture(input: typeof AUTO_EXPOSURE_SCENE_CASE): { ok: true } | { ok: false; reason: string } {
  if (input.rendererFields.length !== 3 || input.commonStages.includes('decoded-sRGB-roi') === false || input.roiEpsilon > 0.05 || input.overallParityClaim) {
    return { ok: false, reason: 'common-stage contract is incomplete' };
  }
  return { ok: true };
}
