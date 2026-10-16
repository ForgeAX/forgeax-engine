import { isTriangleTopology } from '@forgeax/engine-types';
// pick-triangle.ts — precise screen ray / triangle query.
//
// This is the precise companion to pick()'s inexpensive world-AABB query. CPU
// triangle vertices are transformed into world space before testing the shared
// world ray. That keeps non-uniformly transformed instances and nearest-
// occluder ordering correct.

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, ray, type Vec3Like, vec3 } from '@forgeax/engine-math';
import { Instances, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MeshAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { currentMeshPositions, type PoseUnavailableReason } from './current-positions';
import { transformMeshVertex, visitSubmeshTriangles } from './mesh-triangles';
import { computeScreenRay, rayHitsMeshBounds, readWorldMatrix } from './pick-core';

export interface TriangleHit {
  readonly entity: EntityHandle;
  /** Zero-based triangle index across supported triangle submeshes. */
  readonly triangleIndex: number;
  /** Exact world-space intersection point. */
  readonly point: Vec3Like;
  /** Distance from the screen ray origin in world units. */
  readonly distance: number;
  /** Barycentric weights for the triangle's first, second, and third vertices. */
  readonly barycentric: readonly [number, number, number];
  /** Present when the caller supplied the registry's payload identity resolver. */
  readonly assetGuid?: string;
  /** Zero-based explicit instance ordinal when the entity owns Instances. */
  readonly instanceIndex?: number;
  readonly precision: 'triangle';
}

export type TrianglePickUnavailableReason =
  | PoseUnavailableReason
  | 'instance-transforms-unavailable';

export type TrianglePickResult =
  | { readonly status: 'hit'; readonly hit: TriangleHit }
  | { readonly status: 'miss'; readonly precision: 'triangle' }
  | {
      readonly status: 'unavailable';
      readonly precision: 'unavailable';
      readonly reason: TrianglePickUnavailableReason;
      readonly entities: readonly EntityHandle[];
    };

export interface TrianglePickOptions {
  /** Resolve a loaded MeshAsset payload to its existing Catalog GUID. */
  readonly assetGuidOf?: (asset: MeshAsset) => string | undefined;
}

function pointOnRay(screenRay: ray.Ray, point: Vec3Like): number {
  const dx = (point[0] as number) - (screenRay[0] as number);
  const dy = (point[1] as number) - (screenRay[1] as number);
  const dz = (point[2] as number) - (screenRay[2] as number);
  return (
    dx * (screenRay[3] as number) + dy * (screenRay[4] as number) + dz * (screenRay[5] as number)
  );
}

/**
 * Return the nearest exact triangle hit for a viewport ray.
 *
 * Current Skin joints are sampled after transform propagation; posed world
 * bounds replace rest bounds. Missing or invalid pose data is unavailable,
 * never a fabricated rest-pose hit or a miss based on stale bounds.
 */
export function pickTriangle(
  world: World,
  cameraEntity: EntityHandle,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  options: TrianglePickOptions = {},
): TrianglePickResult {
  const screen = computeScreenRay(
    world,
    cameraEntity,
    screenX,
    screenY,
    viewportWidth,
    viewportHeight,
  );
  if (screen === undefined) return { status: 'miss', precision: 'triangle' };

  const origin = screen.ray;
  const query = world
    .query({
      read: [Transform, GlobalTransform, MeshFilter, MeshRenderer],
      optional: [Instances, Skin],
    })
    .unwrap();
  let best: TriangleHit | undefined;
  let unsupportedReason: TrianglePickUnavailableReason | undefined;
  const unsupportedEntities: EntityHandle[] = [];

  for (const row of query) {
    const rawHandle = Math.round(row.get(MeshFilter).assetHandle as number);
    if (rawHandle === 0) continue;
    const resolved = resolveAssetHandle<MeshAsset>(world, toShared<'MeshAsset'>(rawHandle));
    if (!resolved.ok) continue;
    const mesh = resolved.value;
    const entity = row.entity;
    const entityWorldMatrix = readWorldMatrix(world, entity);
    if (entityWorldMatrix === undefined) continue;
    const instancesData = row.get(Instances);
    let instanceTransforms: Float32Array | undefined;
    let instanceCount = 1;
    if (instancesData !== undefined) {
      instanceTransforms = instancesData.transforms;
      if (instanceTransforms.length % 16 !== 0 || !instanceTransforms.every(Number.isFinite)) {
        unsupportedReason ??= 'instance-transforms-unavailable';
        unsupportedEntities.push(entity);
        continue;
      }
      instanceCount = instanceTransforms.length / 16;
    }

    const pose = currentMeshPositions(world, entity, mesh);
    if ('reason' in pose) {
      if (pose.reason !== 'cpu-geometry-unavailable') {
        unsupportedReason ??= pose.reason;
        unsupportedEntities.push(entity);
        continue;
      }
      let intersects = false;
      for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
        const drawWorld =
          instanceTransforms === undefined
            ? (entityWorldMatrix as unknown as mat4.Mat4Like)
            : mat4.multiply(
                mat4.create(),
                entityWorldMatrix as unknown as mat4.Mat4Like,
                instanceTransforms.subarray(instanceIndex * 16, instanceIndex * 16 + 16),
              );
        if (rayHitsMeshBounds(origin, mesh.aabb, drawWorld)) {
          intersects = true;
          break;
        }
      }
      if (!intersects) continue;
      unsupportedReason ??= 'cpu-geometry-unavailable';
      unsupportedEntities.push(entity);
      continue;
    }

    const { positions, bounds, worldSpace } = pose;
    for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
      const drawWorld = worldSpace
        ? mat4.identity(mat4.create())
        : instanceTransforms === undefined
          ? (entityWorldMatrix as unknown as mat4.Mat4Like)
          : mat4.multiply(
              mat4.create(),
              entityWorldMatrix as unknown as mat4.Mat4Like,
              instanceTransforms.subarray(instanceIndex * 16, instanceIndex * 16 + 16),
            );
      if (!rayHitsMeshBounds(origin, bounds, drawWorld)) continue;

      const worldA = vec3.create();
      const worldB = vec3.create();
      const worldC = vec3.create();
      const worldPoint = vec3.create();
      let triangleIndex = 0;
      const indices = mesh.indices;
      const maxVertex = Math.floor(positions.length / 3) - 1;
      const test = (i0: number, i1: number, i2: number, index: number): void => {
        if (i0 < 0 || i1 < 0 || i2 < 0 || i0 > maxVertex || i1 > maxVertex || i2 > maxVertex)
          return;
        transformMeshVertex(worldA, positions, i0, drawWorld);
        transformMeshVertex(worldB, positions, i1, drawWorld);
        transformMeshVertex(worldC, positions, i2, drawWorld);
        const hit = ray.rayTriangleIntersects(origin, worldA, worldB, worldC);
        if (!hit.hit) return;
        // The local ray origin is stored in the first three slots; construct the
        // point explicitly to avoid relying on a mutable Ray alias.
        worldPoint[0] = (origin[0] as number) + (origin[3] as number) * hit.t;
        worldPoint[1] = (origin[1] as number) + (origin[4] as number) * hit.t;
        worldPoint[2] = (origin[2] as number) + (origin[5] as number) * hit.t;
        const distance = pointOnRay(origin, worldPoint);
        if (
          !Number.isFinite(distance) ||
          distance < 0 ||
          (best !== undefined && distance >= best.distance)
        )
          return;
        const assetGuid = options.assetGuidOf?.(mesh);
        best = {
          entity,
          triangleIndex: index,
          point: [worldPoint[0], worldPoint[1], worldPoint[2]] as unknown as Vec3Like,
          distance,
          barycentric: [1 - hit.u - hit.v, hit.u, hit.v],
          ...(assetGuid === undefined ? {} : { assetGuid }),
          ...(instanceTransforms === undefined ? {} : { instanceIndex }),
          precision: 'triangle',
        };
      };

      for (const submesh of mesh.submeshes) {
        if (!isTriangleTopology(submesh.topology)) continue;
        triangleIndex = visitSubmeshTriangles(submesh, indices, triangleIndex, test);
      }
    }
  }

  if (unsupportedReason !== undefined) {
    return {
      status: 'unavailable',
      precision: 'unavailable',
      reason: unsupportedReason,
      entities: unsupportedEntities,
    };
  }
  return best === undefined
    ? { status: 'miss', precision: 'triangle' }
    : { status: 'hit', hit: best };
}
