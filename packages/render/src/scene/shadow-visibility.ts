import type { frustum } from '@forgeax/engine-math';
import {
  type CsmCameraData,
  computeDirectionalCsm,
  csmShadowQuality,
  type LightRoster,
} from '../render-system-extract';
import { shadowPlanes } from '../shadow-frustum';

/**
 * Light visibility is independent of camera visibility, including across Worlds.
 * Every shadow request counts, whether or not the Render World grants it an
 * atlas layer, so source-side culling never depends on renderer allocation.
 * Directional cascades are fitted against `camera`, the extraction camera.
 */
export function buildShadowFrusta(
  lights: LightRoster,
  camera: CsmCameraData | undefined,
  result: frustum.Frustum[] = [],
): frustum.Frustum[] {
  let count = 0;
  const add = (matrix: Float32Array, clampNear = false, offset = 0): void => {
    result[count] = shadowPlanes(matrix, clampNear, result[count], offset);
    count++;
  };
  const config = lights.directionalCsmConfig;
  const direction = lights.directionalCsmDirection;
  if (config !== undefined && direction !== undefined) {
    if (config.shadowViewProjection !== undefined) {
      // This one authored volume is already in world space, including for a cameraless source.
      if (csmShadowQuality(config) !== undefined) add(config.shadowViewProjection);
    } else {
      const fitted = computeDirectionalCsm(direction, config, camera);
      if (fitted !== null) {
        for (
          let cascade = 0;
          cascade < fitted.cascadeCount && cascade < fitted.lightViewProj.length;
          cascade++
        )
          add(fitted.lightViewProj[cascade] as Float32Array, true);
      }
    }
  }
  for (const snapshot of lights.pointShadow) {
    for (let face = 0; face < 6; face++) add(snapshot.shadowMatrices, false, face * 16);
  }
  for (const snapshot of lights.spot) {
    if (snapshot.castShadow && snapshot.lightViewProj !== undefined) add(snapshot.lightViewProj);
  }
  result.length = count;
  return result;
}
