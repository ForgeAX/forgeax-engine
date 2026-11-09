import type { ViewLights } from '../world/render-lights';

/**
 * True when the frame's directional receiver needs only one Vogel-PCF cascade:
 * exactly one cascade, no cascade blend and the `pcf-vogel` profile. The
 * pipeline then folds PCSS, the other filter profiles and the second-cascade
 * sample out of the Standard fragment (source variant DIRECTIONAL_SHADOW_SIMPLE).
 * Mirrors the View UBO carriers `cascadeCount` / `cascadeBlend` /
 * `directionalShadowFilter.x`.
 */
export function directionalShadowSimple(
  lights: Pick<ViewLights, 'cascades'> & {
    readonly directionalCsmConfig?: { readonly shadowBiasMode?: number | undefined } | undefined;
  },
): boolean {
  const cascades = lights.cascades;
  // No directional shadow receiver at all: the general code is never reached.
  if (cascades === undefined) return true;
  // Explicit constant-bias cameras take the raw-compare path the simple variant drops.
  if (lights.directionalCsmConfig?.shadowBiasMode === 1) return false;
  return (
    cascades.cascadeCount === 1 &&
    (cascades.cascadeBlend ?? 0) <= 0 &&
    cascades.directionalShadowQuality?.kind === 'pcf-vogel'
  );
}

/**
 * True when the frame's Standard light loop needs none of the per-light
 * modifier lanes: no IES, Cookie or projector spot, no IES point, no rect-area
 * or additional directional slot, no atmosphere solar transmittance and no
 * live cloud shadow (absent, low sun or empty range). The forward Standard
 * pipeline then compiles the LEAN_LIGHTING row, from which those decodes are
 * absent. LEAN_LIGHTING is bound 1:1 to DIRECTIONAL_SHADOW_SIMPLE by the
 * permutation rules, so this predicate is folded into that request.
 */
export function leanLightingFrame(
  lights: Pick<ViewLights, 'point' | 'spot' | 'rect' | 'additionalDirectional'>,
  environmentKind: string | undefined,
  cloudShadow: { readonly lowSun: boolean; readonly range: number } | undefined,
): boolean {
  if (environmentKind === 'atmosphere') return false;
  if (cloudShadow !== undefined && !cloudShadow.lowSun && cloudShadow.range > 0) return false;
  if (lights.rect.length > 0 || (lights.additionalDirectional?.length ?? 0) > 0) return false;
  for (const point of lights.point) if (point.iesProfileSlice !== undefined) return false;
  for (const spot of lights.spot) {
    if (
      spot.iesProfileSlice !== undefined ||
      spot.cookieSlice !== undefined ||
      spot.projectorHandle !== undefined ||
      spot.projectorAsset !== undefined ||
      spot.projectorSlice !== undefined
    )
      return false;
  }
  return true;
}

/**
 * The per-frame DIRECTIONAL_SHADOW_SIMPLE request. The simple receiver row
 * also compiles LEAN_LIGHTING (bound 1:1 by the permutation rules), so it is
 * requested only when the receiver is simple and the frame is lean.
 */
export function directionalShadowSimpleRequest(
  lights: Parameters<typeof directionalShadowSimple>[0] & Parameters<typeof leanLightingFrame>[0],
  environmentKind: string | undefined,
  cloudShadow: { readonly lowSun: boolean; readonly range: number } | undefined,
): boolean {
  return directionalShadowSimple(lights) && leanLightingFrame(lights, environmentKind, cloudShadow);
}
