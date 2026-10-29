const SLAB_POSES = 4096;
const POSE_FLOATS = 16;

let slab = new Float32Array(SLAB_POSES * POSE_FLOATS);
let next = 0;

/**
 * An owned immutable 16-float pose: a view into a shared append-only slab
 * instead of its own typed array, buffer and element store. A slot is never
 * rewritten, so every holder keeps its exact matrix; a slab is reclaimed once
 * no pose in it is referenced.
 */
export function ownPose(source: ArrayLike<number>, offset = 0): Float32Array {
  if (next === SLAB_POSES) {
    slab = new Float32Array(SLAB_POSES * POSE_FLOATS);
    next = 0;
  }
  const start = next * POSE_FLOATS;
  next++;
  const pose = slab.subarray(start, start + POSE_FLOATS);
  for (let lane = 0; lane < POSE_FLOATS; lane++) pose[lane] = source[offset + lane] ?? 0;
  return pose;
}
