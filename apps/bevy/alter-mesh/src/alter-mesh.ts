import { RuntimeMeshVertices } from '@forgeax/engine-assets-runtime';
import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { quat } from '@forgeax/engine-math';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { Handle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';

const FLOATS_PER_VERTEX = 12;
const POSITIONS: readonly (readonly [number, number, number])[] = [
  [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5],
  [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5],
  [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5],
  [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, -0.5, -0.5],
];
const NORMALS: readonly (readonly [number, number, number])[] = [
  ...Array.from({ length: 4 }, () => [0, 1, 0] as const),
  ...Array.from({ length: 4 }, () => [0, -1, 0] as const),
  ...Array.from({ length: 4 }, () => [1, 0, 0] as const),
  ...Array.from({ length: 4 }, () => [-1, 0, 0] as const),
  ...Array.from({ length: 4 }, () => [0, 0, 1] as const),
  ...Array.from({ length: 4 }, () => [0, 0, -1] as const),
];
const INDICES = new Uint16Array([
  0, 3, 1, 1, 3, 2, 4, 5, 7, 5, 6, 7,
  8, 11, 9, 9, 11, 10, 12, 13, 15, 13, 14, 15,
  16, 19, 17, 17, 19, 18, 20, 21, 23, 21, 23, 22,
]);

export interface AlterMeshState {
  readonly meshContent: EntityHandle;
  readonly leftEntity: EntityHandle;
  readonly rightEntity: EntityHandle;
  readonly sharedMeshHandle: Handle<'MeshAsset', 'shared'>;
  readonly baseVertices: Float32Array;
  readonly alteredVertices: Float32Array;
  readonly indices: Uint16Array;
  rightMesh: 'shared' | 'sphere';
  altered: boolean;
  mutations: number;
  swaps: number;
}

function cubeVertices(scale: number): Float32Array {
  const vertices = new Float32Array(POSITIONS.length * FLOATS_PER_VERTEX);
  for (let i = 0; i < POSITIONS.length; i++) {
    const position = POSITIONS[i]!;
    const normal = NORMALS[i]!;
    const offset = i * FLOATS_PER_VERTEX;
    vertices[offset] = position[0] * scale;
    vertices[offset + 1] = position[1] * scale;
    vertices[offset + 2] = position[2] * scale;
    vertices[offset + 3] = normal[0];
    vertices[offset + 4] = normal[1];
    vertices[offset + 5] = normal[2];
    vertices[offset + 6] = i % 4 === 0 || i % 4 === 3 ? 0 : 1;
    vertices[offset + 7] = i % 4 < 2 ? 0 : 1;
    vertices[offset + 8] = 1;
    vertices[offset + 11] = 1;
  }
  return vertices;
}

function cubeMesh(vertices: Float32Array): MeshAsset {
  return {
    kind: 'mesh',
    vertices,
    attributes: {
      position: new Float32Array(POSITIONS.flat()),
      normal: new Float32Array(NORMALS.flat()),
      uv: new Float32Array(POSITIONS.flatMap((_, i) => [i % 4 === 0 || i % 4 === 3 ? 0 : 1, i % 4 < 2 ? 0 : 1])),
      tangent: new Float32Array(POSITIONS.flatMap(() => [1, 0, 0, 1])),
    },
    indices: INDICES,
    submeshes: [{ indexOffset: 0, indexCount: INDICES.length, vertexCount: POSITIONS.length, topology: 'triangle-list', materialSlot: 0 }],
    aabb: new Float32Array([-0.75, -0.75, -0.75, 0.75, 0.75, 0.75]),
    materialSlots: [{ slotName: 'Default' }],
  };
}

export function buildAlterMeshWorld(world: World): AlterMeshState {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.2, 0.75, 1, 1]),
  );
  const sharedMeshHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', cubeMesh(cubeVertices(1)));
  const meshContent = world.spawn({ component: RuntimeMeshVertices, data: { asset: sharedMeshHandle, vertices: cubeVertices(1) } }).unwrap();
  const leftEntity = world.spawn(
    { component: Transform, data: { pos: [-0.9, 0, 0], quat: [0, 0, 0, 1], scale: [1.1, 1.1, 1.1] } },
    { component: MeshFilter, data: { assetHandle: sharedMeshHandle } },
    { component: MeshRenderer, data: { materials: [material] } },
  ).unwrap();
  const rightEntity = world.spawn(
    { component: Transform, data: { pos: [0.9, 0, 0], quat: [0, 0, 0, 1], scale: [1.1, 1.1, 1.1] } },
    { component: MeshFilter, data: { assetHandle: sharedMeshHandle } },
    { component: MeshRenderer, data: { materials: [material] } },
  ).unwrap();
  const eye: [number, number, number] = [0, 0.4, 4.2];
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 4 / 3, near: 0.1, far: 100 }) },
  );
  return {
    meshContent,
    leftEntity,
    rightEntity,
    sharedMeshHandle,
    baseVertices: cubeVertices(1),
    alteredVertices: cubeVertices(1.55),
    indices: INDICES,
    rightMesh: 'shared',
    altered: false,
    mutations: 0,
    swaps: 0,
  };
}

export function mutateSharedMesh(world: World, state: AlterMeshState): void {
  state.altered = !state.altered;
  state.mutations += 1;
  world.set(state.meshContent, RuntimeMeshVertices, { vertices: state.altered ? state.alteredVertices : state.baseVertices }).unwrap();
}

export function swapRightMesh(world: World, state: AlterMeshState): void {
  state.rightMesh = state.rightMesh === 'shared' ? 'sphere' : 'shared';
  state.swaps += 1;
  world.set(state.rightEntity, MeshFilter, {
    assetHandle: state.rightMesh === 'shared' ? state.sharedMeshHandle : HANDLE_SPHERE,
  });
}

export function stepAlterMesh(world: World, state: AlterMeshState, input: InputSnapshot): void {
  if (input.keyboard.justPressedCode('Enter')) mutateSharedMesh(world, state);
  if (input.keyboard.justPressedCode('Space')) swapRightMesh(world, state);
}
