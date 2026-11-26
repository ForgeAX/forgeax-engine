import {
  STANDARD_PARALLAX_DISPLACEMENT_BIT,
  standardMaskHasBit,
  standardTextureMask,
} from '@forgeax/engine-shader';
import { STANDARD_DISPLACEMENT_MODES } from '@forgeax/engine-types';
import { ownedMaterialBounds } from './material-resource';
import type { MaterialSnapshot } from './render-system-extract';

const displacementBit = standardTextureMask([{ name: 'displacementTexture', type: 'texture2d' }]);

export function standardMaskDisplacesVertices(mask: number): boolean {
  return (
    standardMaskHasBit(mask, displacementBit) &&
    !standardMaskHasBit(mask, STANDARD_PARALLAX_DISPLACEMENT_BIT)
  );
}

/** One accepted material's vertex-displaced height interval, matching the vertex shader. */
export function materialDisplacementRadius(material: MaterialSnapshot): number {
  const owned = ownedMaterialBounds(material);
  const cached = owned?.displacementRadius;
  if (cached !== undefined) return cached;
  const mask = material.standardTextureMask;
  // Parallax keeps geometry at the base mesh, so its bounds stay unexpanded.
  const present =
    mask === undefined
      ? material.materialParamSchema?.some(
          (p) => p.name === 'displacementTexture' && p.type === 'texture2d',
        ) && material.paramSnapshot?.displacementMode !== STANDARD_DISPLACEMENT_MODES.parallax
      : standardMaskDisplacesVertices(mask);
  if (!present) {
    if (owned !== undefined) owned.displacementRadius = 0;
    return 0;
  }
  const scale = material.paramSnapshot?.displacementScale ?? 1;
  const bias = material.paramSnapshot?.displacementBias ?? 0;
  const radius =
    typeof scale !== 'number' ||
    typeof bias !== 'number' ||
    !Number.isFinite(scale) ||
    !Number.isFinite(bias)
      ? Infinity
      : Math.max(Math.abs(bias), Math.abs(scale + bias));
  if (owned !== undefined) owned.displacementRadius = radius;
  return radius;
}

/** Visibility reads the vertex interval and the skinned position contract of an admitted material. */
export function sameMaterialCullingBounds(
  before: MaterialSnapshot | undefined,
  after: MaterialSnapshot | undefined,
): boolean {
  return (
    before === after ||
    (before !== undefined &&
      after !== undefined &&
      before.positionBounds === after.positionBounds &&
      materialDisplacementRadius(before) === materialDisplacementRadius(after))
  );
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
  output?: Float32Array,
): Float32Array | undefined {
  if (bounds === undefined || radius === 0) return bounds;
  if (!Number.isFinite(radius)) return undefined;
  const expanded = output ?? new Float32Array(bounds);
  for (let axis = 0; axis < 3; axis++) {
    expanded[axis] = (bounds[axis] ?? 0) - radius;
    expanded[axis + 3] = (bounds[axis + 3] ?? 0) + radius;
  }
  return expanded.every(Number.isFinite) ? expanded : undefined;
}
