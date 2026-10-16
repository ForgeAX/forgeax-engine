// Screen vertex queries use the same current Morph -> Skin projection as exact
// triangle picking. Only vertices of ray-intersected triangle-list primitives
// participate; unavailable CPU poses and explicit instances yield no candidates.

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { box3, mat4, ray, type Vec3Like, vec2, vec3 } from '@forgeax/engine-math';
import { Instances, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { currentMeshPositions } from './current-positions';
import { transformMeshVertex, visitSubmeshTriangles } from './mesh-triangles';
import {
  computeScreenRay,
  readWorldMatrix,
  type ScreenRay,
  visitMeshBoundsCorners,
} from './pick-core';

// ── types ────────────────────────────────────────────────────────────────

/** A current-pose vertex on a ray-intersected triangle, sorted in screen space.
 * deformed is true when Morph or Skin was evaluated, never a rest-pose fallback.
 */
export interface VertexHit {
  readonly entity: EntityHandle;
  readonly vertexIndex: number;
  readonly worldPos: Vec3Like;
  readonly screenDist: number;
  readonly worldDist: number;
  readonly deformed: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Scratch Vec2 for worldToScreen calls (reused across invocations). */
const _scratchVec2 = vec2.create();

/**
 * Compute the perpendicular distance from a point to a ray in 3D.
 * rayDir is assumed normalized; returns |(P - O) x D|.
 */
function pointToRayDist(
  px: number,
  py: number,
  pz: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const ex = px - ox;
  const ey = py - oy;
  const ez = pz - oz;
  const cx = ey * dz - ez * dy;
  const cy = ez * dx - ex * dz;
  const cz = ex * dy - ey * dx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/** Vertex bounds preserve their comparison-based invalid-coordinate behavior. */
function rayHitsWorldAabb(r: ray.Ray, localAabb: Float32Array, worldMat: mat4.Mat4Like): boolean {
  if ((localAabb[0] as number) > (localAabb[3] as number)) return true;
  const worldAabb = box3.create();
  worldAabb[0] = worldAabb[1] = worldAabb[2] = Infinity;
  worldAabb[3] = worldAabb[4] = worldAabb[5] = -Infinity;
  visitMeshBoundsCorners(localAabb, worldMat, (point) => {
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = point[axis] as number;
      if (coordinate < (worldAabb[axis] as number)) worldAabb[axis] = coordinate;
      if (coordinate > (worldAabb[axis + 3] as number)) worldAabb[axis + 3] = coordinate;
    }
  });
  return ray.rayAabbIntersects(r, worldAabb).hit;
}

// ── internal: per-entity vertex hit collection (extracted for pickVertex reuse) ──

/**
 * Core per-entity vertex hit collection.
 * Returns all vertex candidates for one entity, unsorted.
 * Caller sorts and applies limit.
 */
function collectVertexHits(
  world: World,
  screenRay: ScreenRay,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
): VertexHit[] {
  const { ray: r, view, proj } = screenRay;

  // ── viewProj = proj * view (precompute for worldToScreen calls) ──
  const viewProj = mat4.create();
  mat4.multiply(viewProj, proj as unknown as mat4.Mat4Like, view as unknown as mat4.Mat4Like);

  const rOx = r[0] as number;
  const rOy = r[1] as number;
  const rOz = r[2] as number;
  const rDx = r[3] as number;
  const rDy = r[4] as number;
  const rDz = r[5] as number;

  // ── resolve entity's mesh asset ──
  const mfRes = world.get(entity, MeshFilter);
  if (!mfRes.ok) {
    return [];
  }
  const meshRes = resolveAssetHandle<MeshAsset>(
    world,
    toShared<'MeshAsset'>(mfRes.value.assetHandle as unknown as number),
  );
  if (!meshRes.ok) {
    return [];
  }
  const mesh = meshRes.value;

  // VertexHit has no instance ordinal; explicit instances are untestable here.
  if (world.hasComponent(entity, Instances)) return [];
  const pose = currentMeshPositions(world, entity, mesh);
  if ('reason' in pose) return [];
  const { positions, bounds, deformed, worldSpace } = pose;
  const entityWorld = readWorldMatrix(world, entity);
  if (!entityWorld) return [];
  const entityWMLike = worldSpace ? mat4.identity(mat4.create()) : entityWorld;
  if (bounds !== undefined && !rayHitsWorldAabb(r, bounds, entityWMLike)) return [];

  // ── iterate submeshes + triangles ──
  const candidates: VertexHit[] = [];
  const seen = new Set<number>(); // (entity, vertexIndex) dedup (review I-1)
  const indices = mesh.indices;
  const submeshes = mesh.submeshes;
  const maxVertexIndex = Math.floor(positions.length / 3) - 1;

  // Shared vertex-emit closure: given 3 vertex indices for a hit triangle,
  // compute worldPos + screenDist + worldDist and push candidates.
  // Extracted from the duplicated ~45-line indexed/non-indexed body (review I-2).
  const worldA = vec3.create();
  const worldB = vec3.create();
  const worldC = vec3.create();
  const emitTriangleVertices = (i0: number, i1: number, i2: number): void => {
    transformMeshVertex(worldA, positions, i0, entityWMLike);
    transformMeshVertex(worldB, positions, i1, entityWMLike);
    transformMeshVertex(worldC, positions, i2, entityWMLike);
    const triResult = ray.rayTriangleIntersects(r, worldA, worldB, worldC);

    if (!triResult.hit) return;

    for (const [vi, worldVec] of [
      [i0, worldA],
      [i1, worldB],
      [i2, worldC],
    ] as const) {
      if (
        !Number.isFinite(positions[vi * 3]) ||
        !Number.isFinite(positions[vi * 3 + 1]) ||
        !Number.isFinite(positions[vi * 3 + 2])
      )
        continue;
      const wx = worldVec[0] as number;
      const wy = worldVec[1] as number;
      const wz = worldVec[2] as number;

      const screenRes = ray.worldToScreen(
        _scratchVec2,
        [wx, wy, wz] as unknown as Vec3Like,
        viewProj as unknown as import('@forgeax/engine-math').Mat4Like,
        viewportWidth,
        viewportHeight,
      );

      if (screenRes.behind) continue;

      // Dedup: same vertex hit by multiple triangles — keep only first
      // (same vertexIndex = same world-space position, screenDist/worldDist identical).
      if (seen.has(vi)) continue;
      seen.add(vi);

      const sx = _scratchVec2[0] as number;
      const sy = _scratchVec2[1] as number;
      const sdx = sx - screenX;
      const sdy = sy - screenY;
      const screenDist = Math.sqrt(sdx * sdx + sdy * sdy);
      const worldDist = pointToRayDist(wx, wy, wz, rOx, rOy, rOz, rDx, rDy, rDz);

      candidates.push({
        entity,
        vertexIndex: vi,
        worldPos: [wx, wy, wz] as unknown as Vec3Like,
        screenDist,
        worldDist,
        deformed,
      });
    }
  };

  for (const submesh of submeshes) {
    // D-5: only triangle-list participates
    if (submesh.topology !== 'triangle-list') continue;

    visitSubmeshTriangles(submesh, indices, 0, (i0, i1, i2) => {
      if (i0 > maxVertexIndex || i1 > maxVertexIndex || i2 > maxVertexIndex) return;
      emitTriangleVertices(i0, i1, i2);
    });
  }

  return candidates;
}

// ── overload signatures: pickVertexOnEntity (D-2: three-state static dispatch) ──

/**
 * Query the nearest vertex on a single entity.
 *
 * Without options: returns `VertexHit | undefined` (nearest hit, or `undefined` on miss).
 *
 * @param world The ECS world (propagateTransforms must have been called this frame).
 * @param cameraEntity Entity carrying the Camera component (and Transform).
 * @param screenX Horizontal pixel coordinate (viewport top-left, y-down).
 * @param screenY Vertical pixel coordinate.
 * @param viewportWidth Viewport width in pixels.
 * @param viewportHeight Viewport height in pixels.
 * @param entity The mesh entity to query (must carry MeshFilter + MeshRenderer).
 * @returns The nearest `VertexHit`, or `undefined` when nothing is hit.
 * @throws {PickError} `code: 'camera-component-missing'` when cameraEntity has no Camera.
 */
export function pickVertexOnEntity(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
): VertexHit | undefined;

/**
 * Query up to `limit` nearest vertices on a single entity.
 *
 * With `{ limit }`: returns `VertexHit[]` sorted by `screenDist` ascending.
 *
 * @param options.limit Maximum number of candidates to return (returns all available
 *   vertices when limit exceeds the hit count).
 * @returns Sorted array of `VertexHit` (empty on miss).
 */
export function pickVertexOnEntity(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
  options: { limit: number },
): VertexHit[];

export function pickVertexOnEntity(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
  options?: { limit: number },
): VertexHit | VertexHit[] | undefined {
  return pickVertexOnEntityWithScreenRay(
    world,
    computeScreenRay(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight),
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
    entity,
    options,
  );
}

/** Query one entity using a receipt-bound screen ray from the accepted frame. */
export function pickVertexOnEntityWithScreenRay(
  world: World,
  screenRay: ScreenRay | undefined,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
  options?: { limit: number },
): VertexHit | VertexHit[] | undefined {
  if (screenRay === undefined) return options === undefined ? undefined : [];
  const candidates = collectVertexHits(
    world,
    screenRay,
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
    entity,
  );

  return selectVertexHits(candidates, options);
}

// ── overload signatures: pickVertex (full-scene, D-2: three-state static dispatch) ──

/**
 * Query the nearest vertex across all pickable mesh entities in the world.
 *
 * Without options: returns `VertexHit | undefined` (globally nearest, or `undefined` on miss).
 *
 * Walks all renderable archetypes, does an AABB coarse cull (R-2), then calls
 * `pickVertexOnEntity` on each ray-intersecting entity. Builtin meshes without AABB
 * fall through to walk-all-vertices (AC-07).
 *
 * @param world The ECS world (propagateTransforms must have been called this frame).
 * @param cameraEntity Entity carrying the Camera component (and Transform).
 * @param screenX Horizontal pixel coordinate (viewport top-left, y-down).
 * @param screenY Vertical pixel coordinate.
 * @param viewportWidth Viewport width in pixels.
 * @param viewportHeight Viewport height in pixels.
 * @returns The globally nearest `VertexHit`, or `undefined` when nothing is hit.
 * @throws {PickError} `code: 'camera-component-missing'` when cameraEntity has no Camera.
 */
export function pickVertex(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
): VertexHit | undefined;

/**
 * Query up to `limit` nearest vertices across all pickable mesh entities.
 *
 * With `{ limit }`: returns `VertexHit[]` globally sorted by `screenDist` ascending.
 *
 * @param options.limit Maximum number of candidates to return.
 * @returns Sorted array of `VertexHit` (empty on miss).
 */
export function pickVertex(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  options: { limit: number },
): VertexHit[];

export function pickVertex(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  options?: { limit: number },
): VertexHit | VertexHit[] | undefined {
  // ── camera validation + view/projection + screen->world ray (pick-core skeleton) ──
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
  return pickVertexWithScreenRay(
    world,
    screenRay,
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
    options,
  );
}

/** Query all entities using a receipt-bound screen ray from the accepted frame. */
export function pickVertexWithScreenRay(
  world: World,
  screenRay: ScreenRay | undefined,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  options?: { limit: number },
): VertexHit | VertexHit[] | undefined {
  if (screenRay === undefined) {
    if (options) return [];
    return undefined;
  }

  // ── walk renderable archetypes (Transform + MeshFilter + MeshRenderer) ──
  // Reuse pick.ts archetype walk skeleton (research Finding 1).
  const query = world
    .query({ read: [Transform, GlobalTransform, MeshFilter, MeshRenderer] })
    .unwrap();

  const allCandidates: VertexHit[] = [];

  for (const row of query) {
    const entity = row.entity;
    // Collect vertices for this entity
    const entityHits = collectVertexHits(
      world,
      screenRay,
      screenX,
      screenY,
      viewportWidth,
      viewportHeight,
      entity,
    );
    for (const h of entityHits) {
      allCandidates.push(h);
    }
  }

  return selectVertexHits(allCandidates, options);
}

function selectVertexHits(
  candidates: VertexHit[],
  options: { limit: number } | undefined,
): VertexHit | VertexHit[] | undefined {
  candidates.sort((a, b) => a.screenDist - b.screenDist);
  return options?.limit === undefined ? candidates[0] : candidates.slice(0, options.limit);
}
