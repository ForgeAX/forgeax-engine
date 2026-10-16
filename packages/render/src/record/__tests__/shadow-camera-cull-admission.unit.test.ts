import { describe, expect, it } from 'vitest';
import { type ShadowSamplerRoster, shadowCameraCullAdmitted } from '../typed-frame-graph';

const mainOnly: ShadowSamplerRoster = {
  rayDiffuse: false,
  volumetricFog: false,
  atmosphere: false,
  cubeCaptures: 0,
  reflectionProbes: 0,
  planarReflection: false,
  featureSceneInputs: 0,
};

describe('shadowCameraCullAdmitted', () => {
  it('admits the camera cull when the main camera is the sole shadow consumer', () => {
    expect(shadowCameraCullAdmitted(mainOnly)).toBe(true);
  });

  it.each([
    ['ray diffuse', { rayDiffuse: true }],
    ['enabled volumetric fog', { volumetricFog: true }],
    ['physical atmosphere', { atmosphere: true }],
    ['cube capture', { cubeCaptures: 1 }],
    ['reflection probe', { reflectionProbes: 1 }],
    ['planar reflection', { planarReflection: true }],
    ['feature scene input', { featureSceneInputs: 1 }],
  ] as const)('refuses it when %s samples the shadow maps', (_, extra) => {
    expect(shadowCameraCullAdmitted({ ...mainOnly, ...extra })).toBe(false);
  });
});
