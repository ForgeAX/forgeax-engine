// @forgeax/engine-render - Directional CSM projection owner.

import type { DirectionalShadowQuality } from '../components/directional-shadow-filter';
import { directionalShadowQualityFromF32 } from '../components/directional-shadow-filter';

/** Light-space bounds produced by one existing orthographic CSM fit. */
export interface DirectionalShadowCascadeFit {
  readonly split: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** Host projection sent to the shared View UBO. */
export interface DirectionalShadowProjection {
  readonly splitPlanes: Float32Array;
  readonly directionalShadowQuality: DirectionalShadowQuality;
}

/**
 * Project accepted Directional author facts and the existing CSM fit into the
 * shared split vec4 lanes. `.x` is the split, `.y` is world units per texel,
 * `.z` is the light-space depth span, and `.w` is reserved for the ABI.
 */
export function projectDirectionalShadow(
  fits: readonly DirectionalShadowCascadeFit[],
  mapSize: number,
  shadowFilter: number,
  shadowAngularRadius: number,
  maxPenumbraTexels: number,
): DirectionalShadowProjection | undefined {
  if (!Number.isFinite(mapSize) || mapSize < 1) return undefined;
  const directionalShadowQuality = directionalShadowQualityFromF32(
    shadowFilter,
    shadowAngularRadius,
    maxPenumbraTexels,
  );
  if (directionalShadowQuality === undefined) return undefined;

  const splitPlanes = new Float32Array(16);
  for (let index = 0; index < fits.length && index < 4; index += 1) {
    const fit = fits[index];
    if (fit === undefined) continue;
    const width = Math.abs(fit.maxX - fit.minX);
    const height = Math.abs(fit.maxY - fit.minY);
    const depth = Math.abs(fit.maxZ - fit.minZ);
    const worldUnitsPerTexel = Math.max(width, height, Number.EPSILON) / mapSize;
    const lightDepthWorldSpan = Math.max(depth, Number.EPSILON);
    if (!Number.isFinite(worldUnitsPerTexel) || !Number.isFinite(lightDepthWorldSpan)) {
      return undefined;
    }
    const lane = index * 4;
    splitPlanes[lane] = fit.split;
    splitPlanes[lane + 1] = worldUnitsPerTexel;
    splitPlanes[lane + 2] = lightDepthWorldSpan;
  }
  return { splitPlanes, directionalShadowQuality };
}
