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
    | 'eye'
  >,
  out: Mat4 = mat4.create(),
): Mat4 {
  if (camera.projection === 'orthographic') {
    return mat4.orthographicReverseZ(
      out,
      camera.orthoLeft,
      camera.orthoRight,
      camera.orthoTop,
      camera.orthoBottom,
      camera.near,
      camera.far,
    );
  }
  mat4.perspectiveReverseZ(out, camera.fov, camera.aspect, camera.near, camera.far);
  if (camera.eye !== undefined) out[8] = camera.eye.frustumShift;
  return out;
}
