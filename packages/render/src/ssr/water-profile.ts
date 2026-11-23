import type { SsrSpatialAdmission } from './admission';

export const WATER_SSR_PARAMS_BYTES = 96;

// The default Water SSR profile uses one non-glossy ray with 16 steps.
// These parameters are uploaded to WGSL; the shader owns no second default.
export const WATER_SSR_DEFAULT_PROFILE = Object.freeze({
  quality: 2,
  numSteps: 16,
  numRays: 1,
  intensity: 1,
} as const);

export function isWaterSsrAdmitted(
  admission: SsrSpatialAdmission | undefined,
): admission is Extract<SsrSpatialAdmission, { status: 'admitted' }> {
  return admission?.status === 'admitted' && admission.lane === 'deferred';
}
