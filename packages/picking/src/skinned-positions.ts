import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { GlobalTransform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { type MeshAsset, type SkeletonAsset, toShared } from '@forgeax/engine-types';

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
  const resolved = resolveAssetHandle<SkeletonAsset>(
    world,
    toShared<'SkeletonAsset'>(Math.round(skin.value.skeleton as number)),
  );
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
  for (let vertex = 0; vertex < count; vertex++) {
    const offset = vertex * 3;
    const x = positions[offset] as number;
    const y = positions[offset + 1] as number;
    const z = positions[offset + 2] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
    let px = 0,
      py = 0,
      pz = 0;
    for (let lane = 0; lane < 4; lane++) {
      const influence = vertex * 4 + lane;
      const joint = indices[influence] as number;
      const weight = weights[influence] as number;
      if (joint >= jointCount || !Number.isFinite(weight)) return undefined;
      if (weight === 0) continue;
      const base = joint * 16;
      // Match the shader's affine XYZ sum, including non-unit weight sums:
      // jointWorld × IBM is already world-space; never apply the mesh node.
      px +=
        weight *
        ((palette[base] as number) * x +
          (palette[base + 4] as number) * y +
          (palette[base + 8] as number) * z +
          (palette[base + 12] as number));
      py +=
        weight *
        ((palette[base + 1] as number) * x +
          (palette[base + 5] as number) * y +
          (palette[base + 9] as number) * z +
          (palette[base + 13] as number));
      pz +=
        weight *
        ((palette[base + 2] as number) * x +
          (palette[base + 6] as number) * y +
          (palette[base + 10] as number) * z +
          (palette[base + 14] as number));
    }
    posed[offset] = px;
    posed[offset + 1] = py;
    posed[offset + 2] = pz;
    for (let axis = 0; axis < 3; axis++) {
      const value = posed[offset + axis] as number;
      if (!Number.isFinite(value)) return undefined;
      bounds[axis] = Math.min(bounds[axis] as number, value);
      bounds[axis + 3] = Math.max(bounds[axis + 3] as number, value);
    }
  }
  return { positions: posed, bounds };
}
