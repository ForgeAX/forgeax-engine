// @forgeax/engine-runtime - ActiveCamera KV resource + selection helper.
//
// feat-20260630-viewport-2x2-run-x-display-redesign M2 w12 / plan-strategy D-2.
//
// PROBLEM (research Finding 4): the render extract stage selects the camera by
// archetype-query FIRST-HIT (`cameras[0]`) and fires `render-system-multi-camera`
// when more than one [Camera, Transform, Entity] entity exists. A single engine
// world that carries BOTH an editor orbit camera AND a game camera therefore
// cannot pick which one renders. This module adds the minimum neutral mechanism:
// an `ActiveCamera { entity }` resource naming the entity to render through.
//
// ENGINE-NEUTRAL (requirements OOS-4 / AC-16): the engine knows only entity IDs.
// It does NOT know which entity is "editor" or "game" -- the caller (editor side)
// decides what `ActiveCamera.entity` points at. No editor concept enters this
// file or the engine layer.
//
// BACKWARD COMPATIBLE (plan-strategy D-2): when the resource is ABSENT, or the
// named entity is not among the queried cameras, selection falls back to the
// existing first-hit behavior unchanged. Single-camera scenes are unaffected.
//
// Surface:
//   - interface  ActiveCamera { entity: number }
//   - constant   ACTIVE_CAMERA_KEY = 'ActiveCamera'
//   - helper     getActiveCamera(world): ActiveCamera | undefined
//   - helper     setActiveCamera(world, entity): void
//   - pure       selectActiveCameraIndex(cameraEntities, activeEntity): number
//
// @new-surface KV resource: ECS has no defineResource factory; the TS POD
//   interface + string KV key form is the minimum-new-surface route, mirroring
//   TransparentSortConfig. The world resource store
//   (insertResource / getResource / hasResource) is reused unchanged.
// @derives world.hasResource / world.insertResource / world.getResource KV API.
// @fallback getActiveCamera KV missing returns undefined; no warn; no throw
//   (absent ActiveCamera is a legal state -> first-hit fallback in extract).
//
// charter mapping: F1 (single-import barrel + single entity pointer, smallest
// concept face vs a multi-field priority/enabled scheme) + P4 (consistent
// abstraction -- same world.{has,get,insert}Resource KV API as every other
// engine resource consumer).

import type { World } from '@forgeax/engine-ecs';

// ────────────────────────────────────────────────────────────────────────────
// POD interface + KV key
// ────────────────────────────────────────────────────────────────────────────

/**
 * Active-camera pointer (plain-data POD). Lives as a world-level resource keyed
 * by `ACTIVE_CAMERA_KEY`. `entity` is the packed entity id (engine `EntityHandle`
 * is a branded number) of the camera the renderer should use.
 *
 * The engine treats `entity` as an opaque id; whether it names an editor camera
 * or a game camera is a caller-side decision (OOS-4 — engine stays neutral).
 */
export interface ActiveCamera {
  readonly entity: number;
}

/** World resource key for the `ActiveCamera` KV entry. */
export const ACTIVE_CAMERA_KEY = 'ActiveCamera' as const;

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read the world's `ActiveCamera` resource.
 *
 * @fallback KV missing returns `undefined` — absent ActiveCamera is a legal
 * state (the renderer falls back to archetype first-hit). NO warn, NO throw.
 * The `hasResource` guard precedes the read so this helper never trips
 * `ResourceNotFoundError` from `world.getResource`.
 *
 * @example
 *   const a = getActiveCamera(world);   // undefined when not set
 *   if (a) { ... a.entity ... }
 */
export function getActiveCamera(world: World): ActiveCamera | undefined {
  if (!world.hasResource(ACTIVE_CAMERA_KEY)) return undefined;
  return world.getResource<ActiveCamera>(ACTIVE_CAMERA_KEY);
}

/**
 * Write the world's `ActiveCamera` resource (idempotent last-write-wins via
 * `world.insertResource`). The renderer will use the camera whose entity id
 * equals `entity`, or fall back to first-hit if that id is not a queried camera.
 *
 * @example
 *   setActiveCamera(world, gameCameraEntity);  // render through the game camera
 */
export function setActiveCamera(world: World, entity: number): void {
  world.insertResource<ActiveCamera>(ACTIVE_CAMERA_KEY, { entity });
}

/**
 * Pure selection: given the entity ids of every camera surfaced by the extract
 * archetype query (in query order) and the optional active-camera entity id,
 * return the index of the active camera in `cameraEntities`, or `-1` to signal
 * "no selection — use first-hit fallback".
 *
 * `-1` is returned when `activeEntity` is `undefined` (resource absent) OR when
 * the id is not present among `cameraEntities` (stale / non-camera entity).
 * Both cases preserve the existing first-hit behavior (plan-strategy D-2).
 *
 * @example
 *   selectActiveCameraIndex([10, 20, 30], 20) === 1   // pick the 2nd camera
 *   selectActiveCameraIndex([10, 20, 30], undefined) === -1  // first-hit
 *   selectActiveCameraIndex([10, 20, 30], 999) === -1        // first-hit
 */
export function selectActiveCameraIndex(
  cameraEntities: readonly number[],
  activeEntity: number | undefined,
): number {
  if (activeEntity === undefined) return -1;
  return cameraEntities.indexOf(activeEntity);
}
