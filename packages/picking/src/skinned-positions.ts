import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, FrameArena, World } from '@forgeax/engine-ecs';
import { copyMeshAttribute } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { GlobalTransform, readPresentationWorldMatrix } from '@forgeax/engine-scene';
import { Skin, skinVertexPosition } from '@forgeax/engine-skinning';
import type { MeshAsset, SkeletonAsset } from '@forgeax/engine-types';

/** Shared storage policy: standalone geometry is owned; query geometry is borrowed. */
export function deformationStorage(count: number, arena?: FrameArena): Float32Array {
  return arena ? arena.alloc(Float32Array, count).unwrap() : new Float32Array(count);
}

/** Resolve both influence streams under one storage decision, without retaining them. */
function meshSkinChannels(mesh: MeshAsset) {
  if (mesh.attributeStorage === undefined && mesh.attributes.skinWeight instanceof Float32Array)
    return mesh.attributes;
  return {
    skinIndex: copyMeshAttribute(mesh, 'skinIndex'),
    skinWeight: copyMeshAttribute(mesh, 'skinWeight'),
  };
}

function hasCompletePalette(jointCount: number, joints: number, inverseLanes: number): boolean {
  return (
    Number.isInteger(jointCount) &&
    jointCount > 0 &&
    joints === jointCount &&
    inverseLanes === jointCount * 16
  );
}

/** Query-local world vertices: no retained pose, GPU readback or World mutation. */
export function skinnedPositions(
  world: World,
  entity: EntityHandle,
  mesh: MeshAsset,
  positions: Float32Array,
  out: Float32Array,
  arena?: FrameArena,
): { positions: Float32Array; bounds: Float32Array } | undefined {
  const skin = world.get(entity, Skin);
  if (!skin.ok) return undefined;
  const resolved = runtimeAssets(world.assets).resolveAsset<SkeletonAsset>(skin.value.skeleton);
  if (!resolved.ok || resolved.value.kind !== 'skeleton') return undefined;
  const { jointCount, inverseBindMatrices } = resolved.value;
  const joints = skin.value.joints;
  const { skinIndex: indices, skinWeight: weights } = meshSkinChannels(mesh);
  const count = positions.length / 3;
  if (
    !Number.isInteger(count) ||
    !hasCompletePalette(jointCount, joints.length, inverseBindMatrices.length) ||
    !(indices instanceof Uint16Array) ||
    !(weights instanceof Float32Array) ||
    indices.length !== count * 4 ||
    weights.length !== count * 4
  )
    return undefined;

  const palette = deformationStorage(jointCount * 16, arena);
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

  const meshWorld = skin.value.affinePoint ? readPresentationWorldMatrix(world, entity) : undefined;
  if (skin.value.affinePoint && meshWorld === undefined) return undefined;
  const posed = out;
  const bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const point = new Float64Array(4);
  for (let vertex = 0; vertex < count; vertex++) {
    const offset = vertex * 3;
    if (!skinVertexPosition(point, positions, indices, weights, palette, vertex, meshWorld))
      return undefined;
    for (let axis = 0; axis < 3; axis++) {
      posed[offset + axis] = point[axis] as number;
      const value = posed[offset + axis] as number;
      if (!Number.isFinite(value)) return undefined;
      bounds[axis] = Math.min(bounds[axis] as number, value);
      bounds[axis + 3] = Math.max(bounds[axis + 3] as number, value);
    }
  }
  return { positions: posed, bounds };
}
