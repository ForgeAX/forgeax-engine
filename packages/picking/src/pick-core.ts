// pick-core.ts — shared picking skeleton for pick() / pickVertex*() (feat-20260705 M2 M0).
//
// `pick.ts` (screen-to-entity ray-AABB) and `pick-vertex.ts` (vertex-level) share a
// verbatim skeleton (F11): the `GlobalTransform.world` row type, the row reader, and the
// camera-validation → view=invert(worldMatrix) → projection-branch → screenToRay
// sequence. This module is the single source of truth for that skeleton
// (architecture-principles §2 Derive, Don't Duplicate; AC-201). pick.ts and
// pick-vertex.ts import from here rather than each maintaining their own copy.
//
// Error channel (charter P3): a `cameraEntity` that carries no `Camera` is the one
// unrecoverable precondition — `computeScreenRay` throws a structured `PickError`
// (`code: 'camera-component-missing'`). A camera entity that carries no resolvable
// `GlobalTransform.world` is a degenerate miss (no view matrix can be built) — signalled by
// a `undefined` return, which callers translate to their own miss shape
// (`undefined` for pick, `[]`/`undefined` for the vertex queries).

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { box3, mat4, ray, type Vec3Like, vec3 } from '@forgeax/engine-math';
import { Camera, type CameraProjection, cameraProjectionFromF32 } from '@forgeax/engine-render';
import { GlobalTransform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { PickError } from './pick-errors';

/**
 * Read an entity's resolved world mat4 (16 column-major floats) from the
 * `GlobalTransform.world` column array view. Returns a fresh copy (the view
 * aliases live slot bytes); `undefined` when the entity has no derived world.
 */
export function readWorldMatrix(world: World, entity: EntityHandle): Float32Array | undefined {
  const result = world.get(entity, GlobalTransform);
  return result.ok ? new Float32Array(result.value.world) : undefined;
}

/**
 * The screen-to-world ray plus the camera matrices used to build it.
 *
 *   - `ray`            — the unprojected world-space pick ray (origin + direction).
 *   - `view`           — `invert(camera GlobalTransform.world)`.
 *   - `proj`           — the camera projection matrix (perspective / orthographic).
 *   - `projectionKind` — the resolved camera projection discriminant.
 *
 * `view` and `proj` are returned separately so vertex picking can build its own
 * `viewProj = proj * view` for `worldToScreen` without recomputing the branch.
 */
export interface ScreenRay {
  readonly ray: ray.Ray;
  readonly view: mat4.Mat4;
  readonly proj: mat4.Mat4;
  readonly projectionKind: CameraProjection;
}

/** Build a screen ray from matrices captured with the accepted render frame. */
export function computeScreenRayFromMatrices(
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  viewMatrix: ArrayLike<number>,
  projectionMatrix: ArrayLike<number>,
  projectionKind: CameraProjection,
): ScreenRay | undefined {
  if (
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    viewMatrix.length !== 16 ||
    projectionMatrix.length !== 16 ||
    !Array.from(viewMatrix).every((value) => Number.isFinite(value)) ||
    !Array.from(projectionMatrix).every((value) => Number.isFinite(value))
  ) {
    return undefined;
  }
  const view = mat4.create();
  const proj = mat4.create();
  view.set(viewMatrix);
  proj.set(projectionMatrix);
  const r = ray.create();
  ray.screenToRay(r, screenX, screenY, viewportWidth, viewportHeight, view, proj, projectionKind);
  return { ray: r, view, proj, projectionKind };
}

/**
 * Build the screen-to-world ray for `cameraEntity` at the viewport-relative
 * `(screenX, screenY)` coordinate: validate the camera component, read its world
 * transform, invert it to a view matrix, branch the projection on the camera
 * discriminant, and unproject the coordinate into a world-space ray.
 *
 * @returns The `ScreenRay`, or `undefined` when the camera entity carries no
 *   resolvable `GlobalTransform.world` (a degenerate miss — no view matrix can be built).
 * @throws {PickError} `code: 'camera-component-missing'` when `cameraEntity` has no `Camera`.
 */
export function computeScreenRay(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
): ScreenRay | undefined {
  // An invalid viewport cannot define a screen ray; refuse it before the lower
  // math layer's safe fallback can become a fabricated origin hit.
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return undefined;
  }

  // --- precondition: camera component present (structured error, charter P3) ---
  const camRes = world.get(cameraEntity, Camera);
  if (!camRes.ok) {
    throw new PickError(cameraEntity as unknown as number);
  }
  const cam = camRes.value;

  // --- camera world transform (feat-20260601 D-3: read GlobalTransform.world mat4) ---
  const camWorld = readWorldMatrix(world, cameraEntity);
  if (camWorld === undefined) {
    // A camera entity without a Transform cannot define a view matrix; treat the
    // degenerate case as a miss rather than fabricating an identity view (no spurious hit).
    return undefined;
  }

  // --- view = invert(camera world mat4) ---
  const view = mat4.create();
  mat4.invert(view, camWorld as unknown as mat4.Mat4Like);

  // --- projection: branch on the camera discriminant (research Finding 5a) ---
  const projectionKind = cameraProjectionFromF32(cam.projection);
  const proj = mat4.create();
  if (projectionKind === 'orthographic') {
    mat4.orthographicReverseZ(proj, cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far);
  } else {
    mat4.perspectiveReverseZ(proj, cam.fov, cam.aspect, cam.near, cam.far);
  }

  // --- screen -> world ray (two-point unproject; clamp + NaN/Inf sanitized inside) ---
  const r = ray.create();
  ray.screenToRay(r, screenX, screenY, viewportWidth, viewportHeight, view, proj, projectionKind);

  return { ray: r, view, proj, projectionKind };
}

/** The point kernel and corner order shared by precise picking queries. */
export function visitMeshBoundsCorners(
  bounds: NonNullable<MeshAsset['aabb']>,
  matrix: mat4.Mat4Like,
  visit: (point: Vec3Like) => void,
): void {
  // Keep the point kernel's w=0 convention, Float32 rounding and corner order.
  // transformBox3 intentionally has a different perspective-degenerate rule.
  const point = vec3.create();
  for (let corner = 0; corner < 8; corner++) {
    point[0] = bounds[corner & 1 ? 3 : 0] as number;
    point[1] = bounds[corner & 2 ? 4 : 1] as number;
    point[2] = bounds[corner & 4 ? 5 : 2] as number;
    mat4.transformPoint(point, matrix, point);
    visit(point);
  }
}

/** Triangle bounds retain Math.min/max's propagation of invalid coordinates. */
export function rayHitsMeshBounds(
  screenRay: ray.Ray,
  bounds: MeshAsset['aabb'],
  matrix: mat4.Mat4Like,
): boolean {
  if (bounds === undefined || (bounds[0] as number) > (bounds[3] as number)) return true;
  const worldBounds = box3.create();
  worldBounds[0] = worldBounds[1] = worldBounds[2] = Infinity;
  worldBounds[3] = worldBounds[4] = worldBounds[5] = -Infinity;
  visitMeshBoundsCorners(bounds, matrix, (point) => {
    for (let axis = 0; axis < 3; axis++) {
      worldBounds[axis] = Math.min(worldBounds[axis] as number, point[axis] as number);
      worldBounds[axis + 3] = Math.max(worldBounds[axis + 3] as number, point[axis] as number);
    }
  });
  return ray.rayAabbIntersects(screenRay, worldBounds).hit;
}
