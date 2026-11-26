import { frustum } from '@forgeax/engine-math';

/** Reverse-Z near pancaking must admit upstream casters before the vertex stage. */
export function shadowPlanes(
  matrix: Float32Array,
  clampNear = false,
  planes = frustum.create(),
  offset = 0,
): frustum.Frustum {
  frustum.fromViewProjection(planes, matrix, offset);
  if (clampNear) {
    planes.fill(0, 20, 23);
    planes[23] = 1;
  }
  return planes;
}
