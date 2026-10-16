import { frustum, mat4 } from '@forgeax/engine-math';
import { cameraLensProjection } from '../camera-projection';
import { computeProjectionMatrix, computeViewMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';
import type { GpuDrivenOcclusionCamera } from './view-gpu';

export function activeFrustum(camera: CameraSnapshot): Float32Array {
  const projection = cameraLensProjection(camera);
  const view = mat4.invert(mat4.create(), camera.world);
  return frustum.fromViewProjection(
    frustum.create(),
    mat4.multiply(mat4.create(), projection, view),
  );
}

/** The camera clipping shadow casters honor; empty when shadows ignore it. */
export function shadowViewClipping(camera: CameraSnapshot): string {
  const clipping = camera.clipping;
  if (clipping?.clipShadows !== true || clipping.planes.length === 0) return '';
  return `${clipping.intersection === true ? 'and' : 'or'}:${clipping.planes.flat().join(',')}`;
}

/**
 * Unjittered camera facts for the late HZB test. They derive from the same
 * helpers as the View UBO, so the pyramid and the test share one projection.
 */
export function occlusionCamera(camera: CameraSnapshot): GpuDrivenOcclusionCamera {
  const viewProjection = mat4.multiply(
    mat4.create(),
    computeProjectionMatrix(camera),
    computeViewMatrix(camera),
  );
  return {
    viewProjection,
    near: camera.near,
    far: camera.far,
    orthographic: camera.projection === 'orthographic',
    historyKey: `${camera.worldId ?? ''}:${camera.entityKey ?? 0}:${camera.historyVersion ?? 0}:${camera.aspect}`,
  };
}
