import { frustum } from '@forgeax/engine-math';

/** Reverse-Z near pancaking must admit upstream casters before the vertex stage. */
export function shadowPlanes(matrix: Float32Array, clampNear = false): frustum.Frustum {
  const planes = frustum.fromViewProjection(frustum.create(), matrix);
  if (clampNear) planes.set([0, 0, 0, 1], 20);
  return planes;
}
