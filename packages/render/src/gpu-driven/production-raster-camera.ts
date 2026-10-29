import { frustum, mat4 } from '@forgeax/engine-math';
import { cameraLensProjection } from '../camera-projection';
import { computeProjectionMatrix, computeViewMatrix } from '../record/helpers';
import type { CameraSnapshot } from '../render-contract';
import type { GpuDrivenOcclusionCamera } from './view-gpu';

function createCameraScratch() {
  return { projection: mat4.create(), view: mat4.create(), viewProjection: mat4.create() };
}
let retainedScratch: ReturnType<typeof createCameraScratch> | undefined;
let usingScratch = false;

export function activeFrustum(camera: CameraSnapshot): Float32Array {
  const outer = usingScratch;
  if (!outer && retainedScratch === undefined) retainedScratch = createCameraScratch();
  const scratch = outer
    ? createCameraScratch()
    : (retainedScratch as ReturnType<typeof createCameraScratch>);
  usingScratch = true;
  try {
    cameraLensProjection(camera, scratch.projection);
    mat4.invert(scratch.view, camera.world);
    mat4.multiply(scratch.viewProjection, scratch.projection, scratch.view);
    return frustum.fromViewProjection(frustum.create(), scratch.viewProjection);
  } finally {
    usingScratch = outer;
  }
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
  const outer = usingScratch;
  if (!outer && retainedScratch === undefined) retainedScratch = createCameraScratch();
  const scratch = outer
    ? createCameraScratch()
    : (retainedScratch as ReturnType<typeof createCameraScratch>);
  usingScratch = true;
  try {
    const viewProjection = mat4.multiply(
      mat4.create(),
      computeProjectionMatrix(camera, scratch.projection),
      computeViewMatrix(camera, scratch.view),
    );
    return {
      viewProjection,
      near: camera.near,
      far: camera.far,
      orthographic: camera.projection === 'orthographic',
      historyKey: `${camera.worldId ?? ''}:${camera.entityKey ?? 0}:${camera.historyVersion ?? 0}:${camera.aspect}`,
    };
  } finally {
    usingScratch = outer;
  }
}
