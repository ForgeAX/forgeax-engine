import type { ShadowCapsuleSet } from './media-contracts.js';

/** Upper bound on `SkeletonAsset.shadowCapsules` entries, checked at load. */
export const MAX_SHADOW_CAPSULES_PER_SKELETON = 64;

/** Floats per capsule in `ShadowCapsuleSet.shapes`: start xyz, end xyz, radius. */
export const SHADOW_CAPSULE_STRIDE = 7;

function numbers(value: unknown): readonly number[] | ArrayLike<number> | undefined {
  if (value instanceof Float32Array || value instanceof Uint16Array) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return value;
  return undefined;
}

/**
 * Validate a skeleton's shadow capsules and copy them into the runtime POD.
 * Accepts typed arrays or the plain arrays a JSON round-trip leaves behind.
 * Returns `undefined` for any malformed set so loaders reject the skeleton
 * instead of letting an out-of-range joint reach the renderer palette.
 */
export function parseShadowCapsuleSet(
  value: unknown,
  jointCount: number,
): ShadowCapsuleSet | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as { readonly joints?: unknown; readonly shapes?: unknown };
  const joints = numbers(record.joints);
  const shapes = numbers(record.shapes);
  if (joints === undefined || shapes === undefined) return undefined;
  const count = joints.length;
  if (count > MAX_SHADOW_CAPSULES_PER_SKELETON || shapes.length !== count * SHADOW_CAPSULE_STRIDE)
    return undefined;
  for (let index = 0; index < count; index++) {
    const joint = joints[index] as number;
    if (!Number.isInteger(joint) || joint < 0 || joint >= jointCount) return undefined;
    for (let lane = 0; lane < SHADOW_CAPSULE_STRIDE; lane++) {
      if (!Number.isFinite(shapes[index * SHADOW_CAPSULE_STRIDE + lane])) return undefined;
    }
    if ((shapes[index * SHADOW_CAPSULE_STRIDE + 6] as number) <= 0) return undefined;
  }
  return { joints: Uint16Array.from(joints), shapes: Float32Array.from(shapes) };
}
