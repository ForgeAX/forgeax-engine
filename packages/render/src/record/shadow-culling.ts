import { box3, frustum } from '@forgeax/engine-math';
import { shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import type { RenderableSnapshot } from '../render-system-extract';
import type { PersistentShadowCasterProjection } from '../scene/render-scene';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import type { ShadowViewProjection } from '../world/render-lights';

const worldBoundsScratch = box3.create();

export function shadowViewContains(
  source: RenderableSnapshot,
  planes: Float32Array | undefined,
  boundsOf: PersistentShadowCasterProjection['worldBoundsOf'] | undefined,
  slot?: RenderSceneSlot,
): boolean {
  if (planes === undefined || planes.length === 0) return true;
  if (source.spriteInstances !== undefined) return true;
  if (source.instances?.instanceCount === 0) return false;
  // Bounds come only from the persistent scene owner. Without one, or when it
  // reports unknown bounds, the caster stays conservative; recording never
  // re-derives an instance union per view.
  if (boundsOf?.(source, worldBoundsScratch, slot) !== true) return true;
  return frustum.intersectsBox(planes as frustum.Frustum, worldBoundsScratch);
}

export function shadowPlanes(matrix: Float32Array): Float32Array {
  return frustum.fromViewProjection(frustum.create(), matrix as never);
}

/**
 * Culling planes of every shadow view a frame may raster: this view's
 * directional cascades, then the Render World point-face and spot views. Each
 * view's planes were derived once, when its fit or light changed.
 */
export function shadowViewPlanesByView(
  shadowViews: readonly ShadowViewProjection[],
  directionalLimit?: number,
): ReadonlyMap<string, Float32Array> {
  const views = new Map<string, Float32Array>();
  for (const view of shadowViews) {
    const identity = view.identity;
    if (
      identity.kind === 'directional' &&
      directionalLimit !== undefined &&
      identity.index >= directionalLimit
    )
      continue;
    views.set(shadowViewIdentityKey(identity), view.planes);
  }
  return views;
}
