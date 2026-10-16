import { box3, frustum } from '@forgeax/engine-math';
import type { RenderableSnapshot } from '../render-system-extract';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';

const worldBoundsScratch = box3.create();

export function shadowViewContains(
  source: RenderableSnapshot,
  planes: Float32Array | undefined,
  boundsOf: PersistentShadowCasterProjection['worldBoundsOf'] | undefined,
): boolean {
  if (planes === undefined || planes.length === 0 || source.localAabb === undefined) return true;
  // The extracted mesh AABB is bind-pose geometry, not a conservative bound
  // for the current skin palette. Keep skinned residuals until extraction owns
  // a deformation-aware bound.
  if (source.skin !== undefined) return true;
  if (source.spriteInstances !== undefined) return true;
  if (source.instances?.instanceCount === 0) return false;
  // Bounds come only from the persistent scene owner. Without one, or when it
  // reports unknown bounds, the caster stays conservative; recording never
  // re-derives an instance union per view.
  const bounds = boundsOf?.(source);
  if (bounds === undefined) return true;
  worldBoundsScratch[0] = bounds.min[0];
  worldBoundsScratch[1] = bounds.min[1];
  worldBoundsScratch[2] = bounds.min[2];
  worldBoundsScratch[3] = bounds.max[0];
  worldBoundsScratch[4] = bounds.max[1];
  worldBoundsScratch[5] = bounds.max[2];
  return frustum.intersectsBox(planes as frustum.Frustum, worldBoundsScratch);
}
