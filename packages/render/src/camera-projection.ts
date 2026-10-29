import { type Mat4, mat4 } from '@forgeax/engine-math';
import type { CameraSnapshot } from './render-contract';

/**
 * The camera's own lens projection (reverse-Z). Every culling, temporal, debug
 * and View UBO consumer derives from here, so a stereo eye's off-axis term is
 * never lost by a local re-derivation. Auxiliary capture overrides stay in
 * `computeProjectionMatrix`.
 */
export function cameraLensProjection(
  camera: Pick<
    CameraSnapshot,
    | 'projection'
    | 'fov'
    | 'aspect'
    | 'near'
    | 'far'
    | 'orthoLeft'
    | 'orthoRight'
    | 'orthoTop'
    | 'orthoBottom'
    | 'projectionOffset'
  >,
  out: Mat4,
): Mat4 {
  if (camera.projection === 'orthographic') {
    mat4.orthographicReverseZ(
      out,
      camera.orthoLeft,
      camera.orthoRight,
      camera.orthoTop,
      camera.orthoBottom,
      camera.near,
      camera.far,
    );
  } else {
    mat4.perspectiveReverseZ(out, camera.fov, camera.aspect, camera.near, camera.far);
  }
  const offset = camera.projectionOffset;
  const x = offset?.[0] ?? 0;
  const y = offset?.[1] ?? 0;
  // Clip translation preserves depth and works for both lens families.
  for (let column = 0; column < 16; column += 4) {
    const w = out[column + 3] ?? 0;
    out[column] = (out[column] ?? 0) + x * w;
    out[column + 1] = (out[column + 1] ?? 0) + y * w;
  }
  return out;
}

/** Apply a screen-UV sample offset in clip space; the input may alias out. */
export function jitterCameraProjection(
  out: Mat4,
  projection: Mat4,
  jitterUv: readonly [number, number] | undefined,
): Mat4 {
  if (jitterUv === undefined) {
    out.set(projection);
    return out;
  }
  // Clip translation changes only x/y. Preserve the f32 shift used by the
  // matrix path, and read each column before writing so out may alias input.
  const x = Math.fround(jitterUv[0] * 2);
  const y = Math.fround(jitterUv[1] * -2);
  for (let column = 0; column < 16; column += 4) {
    const w = projection[column + 3] ?? 0;
    out[column] = (projection[column] ?? 0) + x * w;
    out[column + 1] = (projection[column + 1] ?? 0) + y * w;
    out[column + 2] = projection[column + 2] ?? 0;
    out[column + 3] = w;
  }
  return out;
}
