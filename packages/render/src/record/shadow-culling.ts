import { box3, frustum } from '@forgeax/engine-math';
import { shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import type { ExtractedLights, RenderableSnapshot } from '../render-system-extract';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';

const worldBoundsScratch = box3.create();

export function shadowViewContains(
  source: RenderableSnapshot,
  planes: Float32Array | undefined,
  boundsOf: PersistentShadowCasterProjection['worldBoundsOf'] | undefined,
): boolean {
  if (planes === undefined || planes.length === 0) return true;
  if (source.spriteInstances !== undefined) return true;
  if (source.instances?.instanceCount === 0) return false;
  // Bounds come only from the persistent scene owner. Without one, or when it
  // reports unknown bounds, the caster stays conservative; recording never
  // re-derives an instance union per view.
  if (boundsOf?.(source, worldBoundsScratch) !== true) return true;
  return frustum.intersectsBox(planes as frustum.Frustum, worldBoundsScratch);
}

export function shadowPlanes(matrix: Float32Array): Float32Array {
  return frustum.fromViewProjection(frustum.create(), matrix as never);
}

export function shadowViewPlanesByView(
  lights: ExtractedLights,
  directionalLimit?: number,
): ReadonlyMap<string, Float32Array> {
  const views = new Map<string, Float32Array>();
  for (const [index, matrix] of (lights.lightViewProj ?? []).entries()) {
    if (directionalLimit !== undefined && index >= directionalLimit) continue;
    views.set(shadowViewIdentityKey({ kind: 'directional', index }), shadowPlanes(matrix));
  }
  for (const [index, point] of lights.pointShadow.entries()) {
    for (let face = 0; face < 6; face += 1) {
      views.set(
        shadowViewIdentityKey({ kind: 'point', index, face }),
        shadowPlanes(point.shadowMatrices.subarray(face * 16, face * 16 + 16)),
      );
    }
  }
  let spotIndex = 0;
  for (const spot of lights.spot) {
    if (spot.lightViewProj === undefined) continue;
    views.set(
      shadowViewIdentityKey({ kind: 'spot', index: spotIndex }),
      shadowPlanes(spot.lightViewProj),
    );
    spotIndex += 1;
  }
  return views;
}
