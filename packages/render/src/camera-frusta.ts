import { frustum, mat4 } from '@forgeax/engine-math';
import { cameraLensProjection } from './camera-projection';
import type { CameraSnapshot } from './render-contract';

function createFrustumScratch() {
  return { projection: mat4.create(), view: mat4.create(), viewProjection: mat4.create() };
}
let frustumScratch: ReturnType<typeof createFrustumScratch> | undefined;
let buildingFrusta = false;

/**
 * Build the camera frusta consumed by Render's CPU culling paths.
 *
 * The empty plane sentinel is intentional: invalid perspective dimensions and
 * inverted near/far ranges remain conservative always-visible cameras. Keep
 * the projection, view inversion, and multiplication order aligned with the
 * record stage's camera matrices.
 */
export function buildCameraFrusta(cameras: readonly CameraSnapshot[]): readonly Float32Array[] {
  const wasBuilding = buildingFrusta;
  buildingFrusta = true;
  let scratch: ReturnType<typeof createFrustumScratch> | undefined;
  try {
    const planes: Float32Array[] = [];
    for (const camera of cameras) {
      if (
        (camera.projection === 'perspective' && (camera.fov <= 0 || camera.aspect <= 0)) ||
        camera.near >= camera.far
      ) {
        planes.push(new Float32Array(0));
        continue;
      }
      if (frustumScratch === undefined) frustumScratch = createFrustumScratch();
      scratch ??= wasBuilding ? createFrustumScratch() : frustumScratch;
      const { projection, view, viewProjection } = scratch;
      cameraLensProjection(camera, projection);
      mat4.invert(view, camera.world);
      mat4.multiply(viewProjection, projection, view);
      const cameraPlanes = frustum.create();
      frustum.fromViewProjection(cameraPlanes, viewProjection);
      planes.push(cameraPlanes);
    }
    return planes;
  } finally {
    buildingFrusta = wasBuilding;
  }
}
