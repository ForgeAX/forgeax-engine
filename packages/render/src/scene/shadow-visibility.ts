import { frustum } from '@forgeax/engine-math';
import type { ExtractedLights } from '../render-system-extract';

/** Light visibility is independent of camera visibility, including across Worlds. */
export function buildShadowFrusta(lights: ExtractedLights): frustum.Frustum[] {
  const result: frustum.Frustum[] = [];
  const add = (matrix: Float32Array): void => {
    result.push(frustum.fromViewProjection(frustum.create(), matrix));
  };
  for (const matrix of lights.lightViewProj?.slice(0, lights.cascadeCount) ?? []) add(matrix);
  for (const snapshot of lights.pointShadow) {
    if (snapshot.shadowAtlasLayer < 0) continue;
    for (let face = 0; face < 6; face += 1)
      add(snapshot.shadowMatrices.subarray(face * 16, (face + 1) * 16));
  }
  for (const snapshot of lights.spot) {
    if (snapshot.shadowAtlasTile >= 0 && snapshot.lightViewProj !== undefined)
      add(snapshot.lightViewProj);
  }
  return result;
}
