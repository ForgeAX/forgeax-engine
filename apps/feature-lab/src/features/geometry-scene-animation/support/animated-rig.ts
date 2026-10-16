import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine/geometry';
import { ChildOf, GlobalTransform, Transform } from '@forgeax/engine/scene';
import { Skin } from '@forgeax/engine/skinning';
import type { MeshAsset, SkeletonAsset, VertexAttributeMap } from '@forgeax/engine/types';
import { MESH, material, spawnMesh, unlit } from '../../../lab/stage';

/** An ordinary three-joint Skin: the test sees the actual palette-driven surface. */
export function spawnAnimatedRig(
  world: World,
  x: number,
  length: number,
  color: readonly [number, number, number, number],
): readonly [EntityHandle, EntityHandle, EntityHandle] {
  const root = world.spawn({ component: Transform, data: { pos: [x, 0.15, 0] } }).unwrap();
  const middle = world
    .spawn(
      { component: Transform, data: { pos: [0, length, 0] } },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  const end = world
    .spawn(
      { component: Transform, data: { pos: [0, length, 0] } },
      { component: ChildOf, data: { parent: middle } },
    )
    .unwrap();
  const rows = 25;
  const count = rows * 2;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const tangent = new Float32Array(count * 4);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const y = (Math.floor(i / 2) / (rows - 1)) * 2 * length;
    const joint = y <= length ? 0 : 1;
    const weight = (y - joint * length) / length;
    position.set([i % 2 === 0 ? -0.18 : 0.18, y, 0], i * 3);
    normal.set([0, 0, 1], i * 3);
    uv.set([i % 2, y / (2 * length)], i * 2);
    tangent.set([1, 0, 0, 1], i * 4);
    skinIndex.set([joint, joint + 1, 0, 0], i * 4);
    skinWeight.set([1 - weight, weight, 0, 0], i * 4);
  }
  const indices: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const attributes: VertexAttributeMap = { position, normal, uv, tangent, skinIndex, skinWeight };
  const packed = packInterleavedVertexAttributes(attributes, count).unwrap();
  const asset: MeshAsset = {
    kind: 'mesh',
    vertices: packed.vertices,
    indices: new Uint16Array(indices),
    attributes,
    aabb: new Float32Array([-8, -4, -2, 8, 8, 2]),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: count,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
  const inverseBindMatrices = new Float32Array(48);
  for (let i = 0; i < 3; i++) {
    inverseBindMatrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -i * length, 0, 1], i * 16);
  }
  const skeleton: SkeletonAsset = { kind: 'skeleton', jointCount: 3, inverseBindMatrices };
  const mat = material(world, {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::pbr-skin' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000, cullMode: 'none' },
      },
    ],
    values: { baseColor: color, metallic: 0, roughness: 0.55 },
  });
  spawnMesh(
    world,
    world.allocSharedRef('MeshAsset', asset),
    mat,
    {},
    {
      component: Skin,
      data: {
        skeleton: world.allocSharedRef('SkeletonAsset', skeleton),
        joints: [root, middle, end],
      },
    },
  );
  return [root, middle, end];
}

export function effector(world: World, joint: EntityHandle): readonly [number, number, number] {
  const matrix = world.get(joint, GlobalTransform).unwrap().world;
  return [matrix[12] as number, matrix[13] as number, matrix[14] as number];
}

export function goalMarker(world: World, goal: readonly [number, number, number]): EntityHandle {
  return spawnMesh(world, MESH.sphere, unlit(world, [1, 0.3, 0.08, 1]), {
    pos: goal,
    scale: [0.13, 0.13, 0.13],
  });
}
