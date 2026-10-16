// pick.ts — screen-to-entity raycast (feat-20260529-picking-raycasting-screen-to-entity M3 / w13).
//
// `pick(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)`
// is a free function (NOT `world.pick()`; requirements hard constraint): it unprojects
// a viewport-relative screen coordinate into a world-space ray through the supplied
// camera, walks every renderable archetype, ray-AABB tests each pickable mesh's
// world-space bounding box, and returns the NEAREST `PickHit` (or `undefined` on miss).
//
// Mesh AABB source (feat-20260614 M8, D-15/D-18): the ray-AABB test needs each
// mesh's local-space `MeshAsset.aabb`, resolved from the entity's `MeshFilter`
// handle via `resolveAssetHandle<MeshAsset>(world, handle)` (two-tier builtin /
// world.sharedRefs dispatch). The registry no longer holds handles, so `pick`
// takes no `AssetRegistry` -- it resolves entirely World-side. Keeping `pick` a
// free function (rather than a `World` method) preserves the layering: `World`
// (engine-ecs) stays asset-free; the picking glue lives in the runtime package
// alongside the renderer.
//
// Error channel split (charter P3): the single unrecoverable precondition —
// `cameraEntity` carries no `Camera` — throws a structured `PickError`
// (`code: 'camera-component-missing'`); the ordinary "ray hit nothing" outcome returns
// `undefined`. AI users branch with `if (hit)` for the common case and only handle
// `PickError` where they cannot guarantee the camera entity is well-formed.
//
// Transform source (feat-20260601 D-3): per entity (camera + candidates) read the
// single resolved `GlobalTransform.world` mat4 written by `propagateTransforms` -- the
// GlobalTransform/Transform fallback double-track is retired (the world column
// always exists on a Transform-bearing entity). The camera view is
// `mat4.invert(GlobalTransform.world)`; the candidate AABB is the local AABB
// transformed by `GlobalTransform.world` directly. The world mat4 is read through the
// M1 row-level access, zero `{}` materialization.
//
// Related: requirements in-scope #5/#6/#7 + AC-05..AC-11; plan-strategy D-3 / D-6 / 5.3;
//          research Finding 4 (local->world AABB) + Finding 5 (entity-id via query rows).

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { box3, ray, type Vec3Like, vec3 } from '@forgeax/engine-math';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { computeScreenRay, readWorldMatrix, type ScreenRay } from './pick-core';

/**
 * Result of a successful screen-to-entity pick.
 *
 * Minimal three-field surface (D-6):
 *   - `entity`   — the picked `Entity` (packed u32 handle, ready for `world.get` / `world.set`)
 *   - `point`    — the world-space ray/AABB entry point (`Vec3Like`; a 3-element array)
 *   - `distance` — the entry distance along the ray from the camera (>= 0)
 *
 * No `face` / `uv` / `normal` fields: AABB picking has no triangle resolution, so those
 * would be a lie. A future mesh-precise pick spin-off owns them (requirements OOS).
 */
export interface PickHit {
  readonly entity: EntityHandle;
  readonly point: Vec3Like;
  readonly distance: number;
}

/**
 * Raycast from a viewport-relative screen coordinate into the world and return the
 * nearest pickable mesh entity whose world-space AABB the ray enters.
 *
 * @param world The ECS world holding the camera + candidate mesh entities (and the
 *   per-World SharedRefStore that owns each `MeshAsset` and its local-space `aabb`).
 * @param cameraEntity The entity carrying the `Camera` component (and a Transform).
 * @param screenX Horizontal pixel coordinate relative to the viewport top-left (y-down).
 * @param screenY Vertical pixel coordinate.
 * @param viewportWidth Viewport width in pixels.
 * @param viewportHeight Viewport height in pixels.
 * @returns The nearest `PickHit`, or `undefined` when the ray hits nothing.
 * @throws {PickError} `code: 'camera-component-missing'` when `cameraEntity` has no `Camera`.
 */
export function pick(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
): PickHit | undefined {
  // --- camera validation + view/projection + screen->world ray (pick-core skeleton) ---
  // Throws PickError('camera-component-missing') when cameraEntity has no Camera;
  // returns undefined when the camera has no resolvable GlobalTransform.world (degenerate miss).
  const screenRay = computeScreenRay(
    world,
    cameraEntity,
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
  );
  if (screenRay === undefined) return undefined;
  return pickWithScreenRay(world, screenRay);
}

/** Raycast using a receipt-bound screen ray from the accepted render frame. */
export function pickWithScreenRay(world: World, screenRay: ScreenRay): PickHit | undefined {
  const r = screenRay.ray;

  const query = world
    .query({ read: [Transform, GlobalTransform, MeshFilter, MeshRenderer] })
    .unwrap();

  const worldAabb = box3.create();
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestEntity: EntityHandle | undefined;

  for (const row of query) {
    const assetHandleRaw = Math.round(row.get(MeshFilter).assetHandle as number);
    if (assetHandleRaw === 0) continue;
    const meshRes = resolveAssetHandle<MeshAsset>(world, toShared<'MeshAsset'>(assetHandleRaw));
    if (!meshRes.ok) continue;
    const localAabb = meshRes.value.aabb;
    if (localAabb === undefined) continue;
    // Inverted-infinity empty box (mesh without positions): not pickable.
    if ((localAabb[0] as number) > (localAabb[3] as number)) continue;

    // read the packed Entity for this row from the essential id=0 Entity
    // column (`self` field); the column exists on every archetype.
    const entity = row.entity;

    // local AABB -> world AABB using the resolved GlobalTransform.world mat4
    // directly (feat-20260601 D-3: no compose from decomposed TRS).
    const entityWorld = readWorldMatrix(world, entity);
    if (entityWorld === undefined) continue;
    box3.transformBox3(
      worldAabb,
      localAabb,
      entityWorld as unknown as Parameters<typeof box3.transformBox3>[2],
    );

    const result = ray.rayAabbIntersects(r, worldAabb);
    if (result.hit && result.tmin < bestDistance) {
      bestDistance = result.tmin;
      bestEntity = entity;
    }
  }

  if (bestEntity === undefined) return undefined;

  // entry point = origin + direction * tmin
  const origin = vec3.create();
  const dir = vec3.create();
  ray.getOrigin(origin, r);
  ray.getDirection(dir, r);
  const point = vec3.create(
    (origin[0] as number) + (dir[0] as number) * bestDistance,
    (origin[1] as number) + (dir[1] as number) * bestDistance,
    (origin[2] as number) + (dir[2] as number) * bestDistance,
  );

  return { entity: bestEntity, point, distance: bestDistance };
}
