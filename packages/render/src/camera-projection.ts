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
  out: Mat4 = mat4.create(),
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
  const shift = mat4.identity(mat4.create());
  shift[12] = jitterUv[0] * 2;
  shift[13] = jitterUv[1] * -2;
  return mat4.multiply(out, shift, projection);
}
