import { standardTextureMask } from '@forgeax/engine-shader';
import type { MaterialSnapshot } from './render-system-extract';

const displacementBit = standardTextureMask([{ name: 'displacementTexture', type: 'texture2d' }]);

/** Same normalized height interval as the vertex shader, across every submesh. */
export function standardDisplacementRadius(materials: readonly MaterialSnapshot[]): number {
  let radius = 0;
  for (const material of materials) {
    const present =
      material.standardTextureMask === undefined
        ? material.materialParamSchema?.some(
            (p) => p.name === 'displacementTexture' && p.type === 'texture2d',
          )
        : (material.standardTextureMask & displacementBit) !== 0;
    if (!present) continue;
    const scale = material.paramSnapshot?.displacementScale ?? 1;
    const bias = material.paramSnapshot?.displacementBias ?? 0;
    if (
      typeof scale !== 'number' ||
      typeof bias !== 'number' ||
      !Number.isFinite(scale) ||
      !Number.isFinite(bias)
    )
      return Infinity;
    radius = Math.max(radius, Math.abs(bias), Math.abs(scale + bias));
  }
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
