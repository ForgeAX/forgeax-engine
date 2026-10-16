// audio-listener-sync-system.ts -- AudioListener world-matrix sync.
//
// Syncs the first AudioListener entity's resolved world transform to the Web
// Audio listener (position + forward/up orientation).
//
// feat-20260601 D-6: the sync consumes the single `GlobalTransform.world` mat4 (16
// column-major floats, written by propagateTransforms) instead of a decomposed
// GlobalTransform TRS. forward / up / position are extracted via the
// `@forgeax/engine-math` mat4 helpers (getForward = -col2 normalized; getUp =
// col1 normalized; getTranslation = col3, NOT normalized) -- direction
// normalization eliminates non-uniform-scale pollution that a bare-column read
// would leak. The old quaternion-rotate-vector formula is gone.
//
// Decision anchors:
// - plan-strategy D-6 (rename + world-mat4 reshape + mat4 helper reuse)
// - requirements AC-08 (AudioListener world-matrix sync; quadrant 3 falsify)
// - requirements E-3 (multiple AudioListeners -> first only)
//
// Architecture note: the audio-webaudio package has no dependency on
// engine-runtime (where Transform lives). The sync function is a pure helper
// exported for host assembly. The host (engine-runtime or app layer) queries
// the first AudioListener entity, reads its `GlobalTransform.world` mat4 (a 16-float
// Float32Array), obtains the AudioContext listener from the AudioBackend, and
// calls `syncListenerFromWorldMatrix(listener, worldMatrix)`.
//
// charter awareness:
// - P3 explicit failure: no-op contracts, no throw for missing listener
// - P4 consistent abstraction: reuse the math mat4 extract helpers (no
//   hand-rolled quaternion rotation); pure function exports for unit testing
// - P5 producer/consumer: sync function is the producer; host is the consumer

import { mat4, vec3 } from '@forgeax/engine-math';

/**
 * Pure function: write a world mat4's position/orientation to the Web Audio
 * listener's AudioParams.
 *
 * Exported for unit testing (listener-sync.test.ts) and for host assembly (the
 * host reads `GlobalTransform.world` + AudioListener from the World and calls this
 * each frame).
 *
 * - position = `mat4.getTranslation(world)` (col3, copied directly, not normalized)
 * - forward  = `mat4.getForward(world)` (-col2, normalized -- removes scale)
 * - up       = `mat4.getUp(world)` (col1, normalized -- removes scale)
 *
 * @param listener The Web Audio API AudioListener (from AudioContext.listener)
 * @param worldMatrix The resolved world mat4 (16 column-major floats) of the
 *   entity carrying AudioListener.
 */
export function syncListenerFromWorldMatrix(
  listener: AudioListener,
  worldMatrix: Float32Array,
): void {
  const m = worldMatrix as unknown as mat4.Mat4Like;

  const position = mat4.getTranslation(vec3.create(), m);
  listener.positionX.value = position[0] as number;
  listener.positionY.value = position[1] as number;
  listener.positionZ.value = position[2] as number;

  const forward = mat4.getForward(vec3.create(), m);
  listener.forwardX.value = forward[0] as number;
  listener.forwardY.value = forward[1] as number;
  listener.forwardZ.value = forward[2] as number;

  const up = mat4.getUp(vec3.create(), m);
  listener.upX.value = up[0] as number;
  listener.upY.value = up[1] as number;
  listener.upZ.value = up[2] as number;
}

/**
 * Run the audio listener sync system for a host-owned audio context.
 *
 * The host is responsible for:
 * 1. Querying the World for entities with AudioListener
 * 2. Taking the first AudioListener entity (E-3)
 * 3. Reading its `GlobalTransform.world` mat4 (16-float Float32Array)
 * 4. Calling this function with the AudioContext's listener
 *
 * This function is a convenience wrapper that calls
 * `syncListenerFromWorldMatrix(ctx.listener, worldMatrix)`.
 *
 * @param ctx The Web Audio AudioContext (whose .listener receives position/orientation)
 * @param worldMatrix The `GlobalTransform.world` mat4 from the AudioListener entity
 */
export function audioListenerSyncSystem(ctx: AudioContext, worldMatrix: Float32Array): void {
  syncListenerFromWorldMatrix(ctx.listener, worldMatrix);
}
