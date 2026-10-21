// @forgeax/engine-render - closed Directional shadow filter vocabulary.

/** Stable serialized labels for Directional shadow filtering. */
export const DirectionalShadowFilterValue = Object.freeze({
  pcf1: 1,
  pcf3: 2,
  pcf5: 3,
  pcssMedium: 4,
  pcssHigh: 5,
  pcfVogel: 6,
  pcfSoft: 7,
  variance: 8,
} as const);

export type DirectionalShadowFilterLabel = keyof typeof DirectionalShadowFilterValue;

/**
 * Extract-side semantic projection of the serialized Directional filter.
 * `shadowAngularRadius` is radians and `maxPenumbraTexels` is a finite integer.
 */
export type DirectionalShadowQuality =
  | { readonly kind: 'pcf'; readonly kernel: 1 | 3 | 5 }
  | { readonly kind: 'pcf-vogel' }
  | { readonly kind: 'pcf-soft' }
  | { readonly kind: 'variance' }
  | {
      readonly kind: 'pcss';
      readonly preset: 'medium' | 'high';
      readonly angularRadiusRadians: number;
      readonly maxPenumbraTexels: number;
    };

/** Resolve the closed serialized label to the receiver-facing semantic union. */
export function directionalShadowQualityFromF32(
  value: number,
  angularRadiusRadians: number,
  maxPenumbraTexels: number,
): DirectionalShadowQuality | undefined {
  switch (value) {
    case DirectionalShadowFilterValue.variance:
      return { kind: 'variance' };
    case DirectionalShadowFilterValue.pcfSoft:
      return { kind: 'pcf-soft' };
    case DirectionalShadowFilterValue.pcfVogel:
      return { kind: 'pcf-vogel' };
    case DirectionalShadowFilterValue.pcf1:
      return { kind: 'pcf', kernel: 1 };
    case DirectionalShadowFilterValue.pcf3:
      return { kind: 'pcf', kernel: 3 };
    case DirectionalShadowFilterValue.pcf5:
      return { kind: 'pcf', kernel: 5 };
    case DirectionalShadowFilterValue.pcssMedium:
      return {
        kind: 'pcss',
        preset: 'medium',
        angularRadiusRadians,
        maxPenumbraTexels,
      };
    case DirectionalShadowFilterValue.pcssHigh:
      return {
        kind: 'pcss',
        preset: 'high',
        angularRadiusRadians,
        maxPenumbraTexels,
      };
    default:
      return undefined;
  }
}

/** Rasterization and bilinear comparison footprint beyond the filter taps. */
export const SHADOW_RASTER_GUARD_TEXELS = 2;

/**
 * Largest texel radius a receiver lookup can sample around its projected
 * position: the PCF half-kernel, or the PCSS blocker search and penumbra bound.
 */
export function directionalShadowFilterRadiusTexels(quality: DirectionalShadowQuality): number {
  switch (quality.kind) {
    case 'variance':
      return 1;
    case 'pcf-vogel':
      return 1;
    case 'pcf-soft':
      return 2;
    case 'pcf':
      return (quality.kernel - 1) / 2;
    case 'pcss':
      return Math.max(quality.preset === 'medium' ? 2 : 3, quality.maxPenumbraTexels);
  }
}
