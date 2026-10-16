import { SHADOW_CAPSULE_STRIDE, type ShadowCapsuleSet } from '@forgeax/engine-types';

/** Floats per world capsule: start xyz, radius, end xyz, pad. Matches the GPU record. */
export const WORLD_CAPSULE_STRIDE = 8;

/**
 * Why an entity that requested capsule shadows still rasterizes its mesh into
 * the directional cascades. `forward-path` and `no-directional-shadow` are
 * frame facts; the others are per-entity facts decided at extraction.
 */
export type CapsuleShadowFallbackReason =
  | 'forward-path'
  | 'not-skinned'
  | 'no-shadow-capsules'
  | 'no-shadow-caster-pass'
  | 'no-directional-shadow';

/** Extracted per-entity capsule shadow state carried on the RenderableSnapshot. */
export type CapsuleShadowSnapshot =
  | { readonly status: 'ready'; readonly capsules: Float32Array }
  | {
      readonly status: Extract<
        CapsuleShadowFallbackReason,
        'not-skinned' | 'no-shadow-capsules' | 'no-shadow-caster-pass'
      >;
    };

/**
 * Pose bind-space capsules into world space: each endpoint goes through
 * `jointWorld × inverseBind`, and the radius scales by the mean axis length of
 * that matrix so uniformly scaled characters keep proportional shadows.
 */
export function poseShadowCapsules(
  set: ShadowCapsuleSet,
  inverseBindMatrices: readonly Float32Array[],
  jointWorlds: readonly Float32Array[],
): Float32Array {
  const count = set.joints.length;
  const out = new Float32Array(count * WORLD_CAPSULE_STRIDE);
  const m = new Float32Array(16);
  for (let index = 0; index < count; index++) {
    const joint = set.joints[index] as number;
    const world = jointWorlds[joint];
    const ibm = inverseBindMatrices[joint];
    if (world === undefined || ibm === undefined) continue;
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += (world[k * 4 + row] as number) * (ibm[column * 4 + k] as number);
        }
        m[column * 4 + row] = sum;
      }
    }
    const shape = index * SHADOW_CAPSULE_STRIDE;
    const base = index * WORLD_CAPSULE_STRIDE;
    for (const [src, dst] of [
      [shape, base],
      [shape + 3, base + 4],
    ] as const) {
      const x = set.shapes[src] as number;
      const y = set.shapes[src + 1] as number;
      const z = set.shapes[src + 2] as number;
      out[dst] =
        (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
      out[dst + 1] =
        (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
      out[dst + 2] =
        (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
    }
    const scale =
      (Math.hypot(m[0] as number, m[1] as number, m[2] as number) +
        Math.hypot(m[4] as number, m[5] as number, m[6] as number) +
        Math.hypot(m[8] as number, m[9] as number, m[10] as number)) /
      3;
    out[base + 3] = (set.shapes[shape + 6] as number) * scale;
  }
  return out;
}
