import type { EntityHandle, FrameArena, World } from '@forgeax/engine-ecs';
import { copyMeshAttribute, meshAttributeWindow } from '@forgeax/engine-geometry';
import { Instances } from '@forgeax/engine-render';
import { MorphWeights } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MeshAsset } from '@forgeax/engine-types';
import { deformationStorage, skinnedPositions } from './skinned-positions';

export type PoseUnavailableReason =
  | 'cpu-geometry-unavailable'
  | 'skinned-pose-unavailable'
  | 'morph-pose-unavailable';

/** Morph only private query storage; preserve lazy copies and authored neutral weights. */
function morphMeshPositions(
  original: Float32Array,
  targets: NonNullable<MeshAsset['morphTargets']>,
  weights: readonly number[] | Float32Array,
  owned: boolean,
  computeBounds: boolean,
  initialBounds: MeshAsset['aabb'],
  arena?: FrameArena,
) {
  let positions = original;
  let morphed = false;
  let bounds = initialBounds;
  if (weights.length !== targets.length || !weights.every(Number.isFinite)) return undefined;
  for (let k = 0; k < targets.length; k++) {
    // Normal/tangent-only targets do not change the geometric query surface.
    const delta = targets[k]?.position;
    if (delta === undefined) continue;
    if (!(delta instanceof Float32Array) || delta.length !== positions.length) return undefined;
    if (weights[k] === 0) continue;
    if (!morphed) {
      if (!owned) {
        const copy: Float32Array = deformationStorage(positions.length, arena);
        copy.set(positions);
        positions = copy;
      }
      morphed = true;
    }
    for (let i = 0; i < positions.length; i++) {
      const value = (positions[i] as number) + (weights[k] as number) * (delta[i] as number);
      if (!Number.isFinite(value)) return undefined;
      positions[i] = value;
    }
  }
  if (morphed && computeBounds) {
    bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let i = 0; i < positions.length; i++) {
      const value = positions[i] as number;
      if (!Number.isFinite(value)) return undefined;
      const axis = i % 3;
      bounds[axis] = Math.min(bounds[axis] as number, value);
      bounds[axis + 3] = Math.max(bounds[axis + 3] as number, value);
    }
  }

  return { positions, bounds, morphed };
}

/** Synchronous current geometry projection shared by triangle and vertex queries.
 * Morph is local, then Skin is world-space. All scratch belongs to this query.
 * Authored default weights are materialized by scene producers into MorphWeights;
 * absent live weights are neutral, exactly as render extraction.
 * With an arena, returned geometry is borrowed until its scope closes;
 * only detached hit records may leave the public query.
 */
export function currentMeshPositions(
  world: World,
  entity: EntityHandle,
  mesh: MeshAsset,
  arena?: FrameArena,
):
  | {
      positions: Float32Array;
      bounds: MeshAsset['aabb'];
      worldSpace: boolean;
      deformed: boolean;
      offset?: number;
      stride?: number;
      count?: number;
    }
  | { reason: PoseUnavailableReason } {
  const skin =
    world.hasComponent(entity, Skin) ||
    mesh.attributes.skinIndex !== undefined ||
    mesh.attributes.skinWeight !== undefined;
  const targets = mesh.morphTargets;
  const live = world.get(entity, MorphWeights);
  const window = meshAttributeWindow(mesh, 'position');
  if (
    !window ||
    !(window.data instanceof Float32Array) ||
    !Number.isInteger(window.count) ||
    window.count === 0
  )
    return { reason: skin ? 'skinned-pose-unavailable' : 'cpu-geometry-unavailable' };
  // Static queries read the canonical rows directly, even for million-vertex
  // terrain. Only actual deformation needs a contiguous query-local output.
  if (!skin && !(targets && targets.length > 0 && live.ok))
    return {
      positions: window.data,
      bounds: mesh.aabb,
      worldSpace: false,
      deformed: false,
      offset: window.offset,
      stride: window.stride,
      count: window.count,
    };
  const positionOwned = mesh.attributeStorage === 'interleaved';
  let positions =
    mesh.attributeStorage === 'interleaved'
      ? copyMeshAttribute(mesh, 'position', deformationStorage(window.count * 3, arena))
      : window.data;
  if (positions === undefined) return { reason: 'cpu-geometry-unavailable' };
  let morphed = false;
  let bounds = mesh.aabb;
  if (targets && targets.length > 0 && live.ok) {
    const morph = morphMeshPositions(
      positions,
      targets,
      live.value.weights,
      positionOwned,
      !skin,
      bounds,
      arena,
    );
    if (morph === undefined) return { reason: 'morph-pose-unavailable' };
    positions = morph.positions;
    morphed = morph.morphed;
    bounds = morph.bounds;
  }
  if (skin) {
    if (world.hasComponent(entity, Instances)) return { reason: 'skinned-pose-unavailable' };
    // Morph scratch is private and can become the world-pose output in place.
    const pose = skinnedPositions(
      world,
      entity,
      mesh,
      positions,
      morphed || positionOwned ? positions : deformationStorage(positions.length, arena),
      arena,
    );
    if (!pose) return { reason: 'skinned-pose-unavailable' };
    return { ...pose, worldSpace: true, deformed: true };
  }
  return { positions, bounds, worldSpace: false, deformed: morphed };
}
