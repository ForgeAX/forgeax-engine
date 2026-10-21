import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { GlobalTransform } from '@forgeax/engine-scene';
import { Skin, skinVertexPosition } from '@forgeax/engine-skinning';
import type { MeshAsset, SkeletonAsset } from '@forgeax/engine-types';

/** Query-local world vertices: no retained pose, GPU readback or World mutation. */
export function skinnedPositions(
  world: World,
  entity: EntityHandle,
  mesh: MeshAsset,
  positions: Float32Array,
  out?: Float32Array,
): { positions: Float32Array; bounds: Float32Array } | undefined {
  const skin = world.get(entity, Skin);
  if (!skin.ok) return undefined;
  const resolved = runtimeAssets(world.assets).resolveAsset<SkeletonAsset>(skin.value.skeleton);
  if (!resolved.ok || resolved.value.kind !== 'skeleton') return undefined;
  const { jointCount, inverseBindMatrices } = resolved.value;
  const joints = skin.value.joints;
  const indices = mesh.attributes.skinIndex;
  const weights = mesh.attributes.skinWeight;
  const count = positions.length / 3;
  if (
    !Number.isInteger(count) ||
    !Number.isInteger(jointCount) ||
    jointCount <= 0 ||
    joints.length !== jointCount ||
    inverseBindMatrices.length !== jointCount * 16 ||
    !(indices instanceof Uint16Array) ||
    !(weights instanceof Float32Array) ||
    indices.length !== count * 4 ||
    weights.length !== count * 4
  )
    return undefined;

  const palette = new Float32Array(jointCount * 16);
  const matrix = mat4.create();
  for (let joint = 0; joint < jointCount; joint++) {
    const jointWorld = world.get(joints[joint] as EntityHandle, GlobalTransform);
    if (!jointWorld.ok) return undefined;
    // Consume the synchronous borrowed array immediately, without a second 64J-byte copy.
    mat4.multiply(
      matrix,
      jointWorld.value.world,
      inverseBindMatrices.subarray(joint * 16, joint * 16 + 16),
    );
    if (!matrix.every(Number.isFinite)) return undefined;
    palette.set(matrix, joint * 16);
  }

  const posed = out ?? new Float32Array(positions.length);
  const bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const point = new Float64Array(4);
  for (let vertex = 0; vertex < count; vertex++) {
    const offset = vertex * 3;
    if (!skinVertexPosition(point, positions, indices, weights, palette, vertex)) return undefined;
    posed[offset] = point[0] as number;
    posed[offset + 1] = point[1] as number;
    posed[offset + 2] = point[2] as number;
    for (let axis = 0; axis < 3; axis++) {
      const value = posed[offset + axis] as number;
      if (!Number.isFinite(value)) return undefined;
      bounds[axis] = Math.min(bounds[axis] as number, value);
      bounds[axis + 3] = Math.max(bounds[axis + 3] as number, value);
    }
  }
  return { positions: posed, bounds };
}
