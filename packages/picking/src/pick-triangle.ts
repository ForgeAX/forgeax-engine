import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, ray, type Vec3Like, vec3 } from '@forgeax/engine-math';
import { Instances } from '@forgeax/engine-render';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { isTriangleTopology } from '@forgeax/engine-types';
import { currentMeshPositions, type PoseUnavailableReason } from './current-positions';
import { transformMeshVertex, visitSubmeshTriangles } from './mesh-triangles';
import { computeScreenRay, rayHitsMeshBounds, type ScreenRay } from './pick-core';
import { meshQueryEntities, queryMesh, queryMeshMatrix } from './query-mesh';

// pick-triangle.ts — precise screen ray / triangle query.
//
// This is the precise companion to pick()'s inexpensive world-AABB query. CPU
// triangle vertices are transformed into world space before testing the shared
// world ray. That keeps non-uniformly transformed instances and nearest-
// occluder ordering correct.

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
  /** Runtime identity of the queried Mesh asset; resolve provenance through its asset owner. */
  readonly assetHandle?: AssetHandle<'mesh'>;
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

type MeshInstances = readonly [transforms: Float32Array | undefined, count: number];

function pointOnRay(screenRay: ray.Ray, point: Vec3Like): number {
  const dx = (point[0] as number) - (screenRay[0] as number);
  const dy = (point[1] as number) - (screenRay[1] as number);
  const dz = (point[2] as number) - (screenRay[2] as number);
  return (
    dx * (screenRay[3] as number) + dy * (screenRay[4] as number) + dz * (screenRay[5] as number)
  );
}

function queryInstances(world: World, entity: EntityHandle): MeshInstances | undefined {
  const result = world.get(entity, Instances);
  if (!result.ok) return [undefined, 1];
  const transforms = result.value.transforms;
  if (transforms.length % 16 !== 0 || !transforms.every(Number.isFinite)) return undefined;
  return [transforms, transforms.length / 16];
}

function drawWorldMatrix(
  entityWorldMatrix: mat4.Mat4Like,
  transforms: Float32Array | undefined,
  instanceIndex: number,
  worldSpace = false,
): mat4.Mat4Like {
  if (worldSpace) return mat4.identity(mat4.create());
  if (transforms === undefined) return entityWorldMatrix;
  return mat4.multiply(
    mat4.create(),
    entityWorldMatrix,
    transforms.subarray(instanceIndex * 16, instanceIndex * 16 + 16),
  );
}

function intersectsCpuUnavailableBounds(
  origin: ray.Ray,
  mesh: MeshAsset,
  entityWorldMatrix: mat4.Mat4Like,
  instances: MeshInstances,
): boolean {
  const [transforms, count] = instances;
  for (let instanceIndex = 0; instanceIndex < count; instanceIndex += 1) {
    const drawWorld = drawWorldMatrix(entityWorldMatrix, transforms, instanceIndex);
    if (rayHitsMeshBounds(origin, mesh.aabb, drawWorld)) return true;
  }
  return false;
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

  return pickTriangleWithScreenRay(world, screen);
}

/** Query exact triangles against a ray derived from the accepted display frame. */
export function pickTriangleWithScreenRay(world: World, screen: ScreenRay): TrianglePickResult {
  const origin = screen.ray;
  let best: TriangleHit | undefined;
  let unsupportedReason: TrianglePickUnavailableReason | undefined;
  const unsupportedEntities: EntityHandle[] = [];

  for (const entity of meshQueryEntities(world)) {
    const value = queryMesh(world, entity);
    if (value === undefined) continue;
    const { mesh, assetHandle } = value;
    const entityWorldMatrix = queryMeshMatrix(world, entity, screen);
    if (entityWorldMatrix === undefined) continue;
    const instances = queryInstances(world, entity);
    if (instances === undefined) {
      unsupportedReason ??= 'instance-transforms-unavailable';
      unsupportedEntities.push(entity);
      continue;
    }
    const [instanceTransforms, instanceCount] = instances;

    const pose = currentMeshPositions(world, entity, mesh);
    if ('reason' in pose) {
      if (pose.reason !== 'cpu-geometry-unavailable') {
        unsupportedReason ??= pose.reason;
        unsupportedEntities.push(entity);
        continue;
      }
      if (
        !intersectsCpuUnavailableBounds(
          origin,
          mesh,
          entityWorldMatrix as unknown as mat4.Mat4Like,
          instances,
        )
      )
        continue;
      unsupportedReason ??= 'cpu-geometry-unavailable';
      unsupportedEntities.push(entity);
      continue;
    }

    const { positions, bounds, worldSpace } = pose;
    for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
      const drawWorld = drawWorldMatrix(
        entityWorldMatrix as unknown as mat4.Mat4Like,
        instanceTransforms,
        instanceIndex,
        worldSpace,
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
        best = {
          entity,
          ...(assetHandle === undefined ? {} : { assetHandle }),
          triangleIndex: index,
          point: [worldPoint[0], worldPoint[1], worldPoint[2]] as unknown as Vec3Like,
          distance,
          barycentric: [1 - hit.u - hit.v, hit.u, hit.v],
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
