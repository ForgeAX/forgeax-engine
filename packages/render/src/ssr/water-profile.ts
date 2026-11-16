// UE 5.8 defaults: view SSR quality 50 selects Medium (q2), under CVar cap 3.
// SSRTReflections.usf's q2 permutation is a non-glossy single ray with 16 steps.
// These parameters are uploaded to WGSL; the shader owns no second default.
export const WATER_SSR_DEFAULT_PROFILE = Object.freeze({
  quality: 2,
  numSteps: 16,
  numRays: 1,
  roughnessScale: 2,
  intensity: 1,
} as const);

import type { Antialias } from '../components/camera';
import { WaterSsrTemporalValue } from '../components/screen-space-reflection';

/** Water owns a resolve without main TAA, unless the camera explicitly selects otherwise. */
export function waterSsrTemporalEnabled(antialias: Antialias, policy: number): boolean {
  switch (policy) {
    case WaterSsrTemporalValue.auto:
      return antialias !== 'taa';
    case WaterSsrTemporalValue.always:
      return true;
    case WaterSsrTemporalValue.off:
      return false;
    default:
      throw new Error(`Invalid Water SSR temporal policy: ${policy}`);
  }
}
