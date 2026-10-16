import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Instances } from '@forgeax/engine-render';
import { MorphWeights } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MeshAsset } from '@forgeax/engine-types';
import { skinnedPositions } from './skinned-positions';

export type PoseUnavailableReason =
  | 'cpu-geometry-unavailable'
  | 'skinned-pose-unavailable'
  | 'morph-pose-unavailable';

/** Synchronous current geometry projection shared by triangle and vertex queries.
 * Morph is local, then Skin is world-space. All scratch belongs to this query.
 * Authored default weights are materialized by scene producers into MorphWeights;
 * absent live weights are neutral, exactly as render extraction.
 */
export function currentMeshPositions(
  world: World,
  entity: EntityHandle,
  mesh: MeshAsset,
):
  | { positions: Float32Array; bounds: MeshAsset['aabb']; worldSpace: boolean; deformed: boolean }
  | { reason: PoseUnavailableReason } {
  const source = mesh.attributes.position;
  let positions =
    source instanceof Float32Array
      ? source
      : source instanceof ArrayBuffer && source.byteLength % 12 === 0
        ? new Float32Array(source)
        : undefined;
  const skin =
    world.hasComponent(entity, Skin) ||
    mesh.attributes.skinIndex !== undefined ||
    mesh.attributes.skinWeight !== undefined;
  if (!positions || positions.length === 0 || positions.length % 3 !== 0)
    return { reason: skin ? 'skinned-pose-unavailable' : 'cpu-geometry-unavailable' };
  const targets = mesh.morphTargets;
  const live = world.get(entity, MorphWeights);
  let morphed = false;
  let bounds = mesh.aabb;
  if (targets && targets.length > 0 && live.ok) {
    const weights = live.value.weights;
    if (weights.length !== targets.length || !weights.every(Number.isFinite))
      return { reason: 'morph-pose-unavailable' };
    for (let k = 0; k < targets.length; k++) {
      // Normal/tangent-only targets do not change the geometric query surface.
      const delta = targets[k]?.position;
      if (delta === undefined) continue;
      if (!(delta instanceof Float32Array) || delta.length !== positions.length)
        return { reason: 'morph-pose-unavailable' };
      if (weights[k] === 0) continue;
      if (!morphed) {
        positions = new Float32Array(positions);
        morphed = true;
      }
      for (let i = 0; i < positions.length; i++) {
        const value = (positions[i] as number) + (weights[k] as number) * (delta[i] as number);
        if (!Number.isFinite(value)) return { reason: 'morph-pose-unavailable' };
        positions[i] = value;
      }
    }
    if (morphed && !skin) {
      bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      for (let i = 0; i < positions.length; i++) {
        const value = positions[i] as number;
        if (!Number.isFinite(value)) return { reason: 'morph-pose-unavailable' };
        const axis = i % 3;
        bounds[axis] = Math.min(bounds[axis] as number, value);
        bounds[axis + 3] = Math.max(bounds[axis + 3] as number, value);
      }
    }
  }
  if (skin) {
    if (world.hasComponent(entity, Instances)) return { reason: 'skinned-pose-unavailable' };
    // Morph scratch is private and can become the world-pose output in place.
    const pose = skinnedPositions(world, entity, mesh, positions, morphed ? positions : undefined);
    if (!pose) return { reason: 'skinned-pose-unavailable' };
    return { ...pose, worldSpace: true, deformed: true };
  }
  return { positions, bounds, worldSpace: false, deformed: morphed };
}
