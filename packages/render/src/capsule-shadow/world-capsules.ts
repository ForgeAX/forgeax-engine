/** Floats per world capsule: start xyz, radius, end xyz, pad. Matches the GPU record. */
export const WORLD_CAPSULE_STRIDE = 8;

/**
 * Why an entity that requested capsule shadows still rasterizes its mesh into
 * the directional cascades. `forward-path` and `no-directional-shadow` are
 * frame facts; the others are facts of the actual fixed-root task.
 */
export type CapsuleShadowFallbackReason =
  | 'forward-path'
  | 'pose-unavailable'
  | 'not-skinned'
  | 'no-shadow-capsules'
  | 'no-shadow-caster-pass'
  | 'no-directional-shadow';

/** Borrowed actual task output; never copied into Scene rows or publication packets. */
export type CapsuleShadowSnapshot =
  | { readonly status: 'ready'; readonly capsules: Float32Array }
  | {
      readonly status: Extract<
        CapsuleShadowFallbackReason,
        'not-skinned' | 'no-shadow-capsules' | 'pose-unavailable'
      >;
    };
