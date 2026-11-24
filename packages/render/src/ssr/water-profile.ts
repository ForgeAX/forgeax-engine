import type { SsrSpatialAdmission } from './admission';

export const WATER_SSR_PARAMS_BYTES = 80;

// Water keeps its radiance response; traversal uses the shared SSR quality budget.
export const WATER_SSR_DEFAULT_PROFILE = Object.freeze({ intensity: 1 } as const);

export function isWaterSsrAdmitted(
  admission: SsrSpatialAdmission | undefined,
): admission is Extract<SsrSpatialAdmission, { status: 'admitted' }> {
  return admission?.status === 'admitted' && admission.lane === 'deferred';
}
