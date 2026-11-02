import {
  STANDARD_PARALLAX_DISPLACEMENT_BIT,
  standardMaskHasBit,
  standardTextureMask,
} from '@forgeax/engine-shader';
import { STANDARD_DISPLACEMENT_MODES } from '@forgeax/engine-types';
import type { MaterialSnapshot } from './render-system-extract';

const displacementBit = standardTextureMask([{ name: 'displacementTexture', type: 'texture2d' }]);

const radii = new WeakMap<MaterialSnapshot, number>();

/** One accepted material's vertex-displaced height interval, matching the vertex shader. */
export function materialDisplacementRadius(material: MaterialSnapshot): number {
  const cached = material.immutableValues === true ? radii.get(material) : undefined;
  if (cached !== undefined) return cached;
  const mask = material.standardTextureMask;
  // Parallax keeps geometry at the base mesh, so its bounds stay unexpanded.
  const present =
    mask === undefined
      ? material.materialParamSchema?.some(
          (p) => p.name === 'displacementTexture' && p.type === 'texture2d',
        ) && material.paramSnapshot?.displacementMode !== STANDARD_DISPLACEMENT_MODES.parallax
      : (mask & displacementBit) !== 0 &&
        !standardMaskHasBit(mask, STANDARD_PARALLAX_DISPLACEMENT_BIT);
  const scale = material.paramSnapshot?.displacementScale ?? 1;
  const bias = material.paramSnapshot?.displacementBias ?? 0;
  const radius = !present
    ? 0
    : typeof scale !== 'number' ||
        typeof bias !== 'number' ||
        !Number.isFinite(scale) ||
        !Number.isFinite(bias)
      ? Infinity
      : Math.max(Math.abs(bias), Math.abs(scale + bias));
  if (material.immutableValues === true) radii.set(material, radius);
  return radius;
}

/** Same normalized height interval as the vertex shader, across every submesh. */
export function standardDisplacementRadius(materials: readonly MaterialSnapshot[]): number {
  let radius = 0;
  for (const material of materials) radius = Math.max(radius, materialDisplacementRadius(material));
  return radius;
}

/** Expand detached bounds before instance/world transforms and either culling lane. */
export function expandDisplacementBounds(
  bounds: Float32Array | undefined,
  radius: number,
): Float32Array | undefined {
  if (bounds === undefined || radius === 0) return bounds;
  if (!Number.isFinite(radius)) return undefined;
  const expanded = new Float32Array(bounds);
  for (let axis = 0; axis < 3; axis++) {
    expanded[axis] = (bounds[axis] ?? 0) - radius;
    expanded[axis + 3] = (bounds[axis + 3] ?? 0) + radius;
  }
  return expanded.every(Number.isFinite) ? expanded : undefined;
}
