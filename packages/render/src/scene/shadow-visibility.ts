import { frustum } from '@forgeax/engine-math';
import {
  type CsmCameraData,
  computeDirectionalCsm,
  type LightRoster,
} from '../render-system-extract';

/**
 * Light visibility is independent of camera visibility, including across Worlds.
 * Every shadow request counts, whether or not the Render World grants it an
 * atlas layer, so source-side culling never depends on renderer allocation.
 * Directional cascades are fitted against `camera`, the extraction camera.
 */
export function buildShadowFrusta(
  lights: LightRoster,
  camera: CsmCameraData | undefined,
): frustum.Frustum[] {
  const result: frustum.Frustum[] = [];
  const add = (matrix: Float32Array): void => {
    result.push(frustum.fromViewProjection(frustum.create(), matrix));
  };
  const config = lights.directionalCsmConfig;
  const direction = lights.directionalCsmDirection;
  const csm =
    config === undefined || direction === undefined
      ? null
      : computeDirectionalCsm(direction, config, camera);
  for (const matrix of csm?.lightViewProj.slice(0, csm.cascadeCount) ?? []) add(matrix);
  for (const snapshot of lights.pointShadow) {
    for (let face = 0; face < 6; face += 1)
      add(snapshot.shadowMatrices.subarray(face * 16, (face + 1) * 16));
  }
  for (const snapshot of lights.spot) {
    if (snapshot.castShadow && snapshot.lightViewProj !== undefined) add(snapshot.lightViewProj);
  }
  return result;
}
