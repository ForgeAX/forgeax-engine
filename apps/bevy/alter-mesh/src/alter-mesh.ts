import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createBoxGeometry, createSphereGeometry } from '@forgeax/engine-geometry';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { InputSnapshot } from '@forgeax/engine-input';
import { quat } from '@forgeax/engine-math';
import { Camera, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { AssetHandle } from '@forgeax/engine-types';

export interface AlterMeshState {
  readonly leftEntity: EntityHandle;
  readonly rightEntity: EntityHandle;
  readonly sharedMeshHandle: AssetHandle<'mesh'>;
  readonly sphereMeshHandle: AssetHandle<'mesh'>;
  readonly basePositions: Float32Array;
  readonly alteredPositions: Float32Array;
  rightMesh: 'shared' | 'sphere';
  altered: boolean;
  mutations: number;
  swaps: number;
}

export function buildAlterMeshWorld(world: World, assets: AssetRegistry): AlterMeshState {
  const material = assets.create(Materials.unlit([0.2, 0.75, 1, 1])).unwrap();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const positions = mesh.attributes.position;
  if (!(positions instanceof Float32Array)) throw new Error('box positions unavailable');
  const basePositions = positions.slice();
  const alteredPositions = basePositions.map((value) => value * 1.55);
  const sharedMeshHandle = assets.create(mesh).unwrap();
  const sphereMeshHandle = assets.create(createSphereGeometry(1, 16, 12).unwrap()).unwrap();
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
    leftEntity,
    rightEntity,
    sharedMeshHandle,
    sphereMeshHandle,
    basePositions,
    alteredPositions,
    rightMesh: 'shared',
    altered: false,
    mutations: 0,
    swaps: 0,
  };
}

export function mutateSharedMesh(assets: AssetRegistry, state: AlterMeshState): void {
  state.altered = !state.altered;
  state.mutations += 1;
  assets.writeRange(state.sharedMeshHandle, {
    attribute: 'position', first: 0,
    values: state.altered ? state.alteredPositions : state.basePositions,
  }).unwrap();
}

export function swapRightMesh(world: World, state: AlterMeshState): void {
  state.rightMesh = state.rightMesh === 'shared' ? 'sphere' : 'shared';
  state.swaps += 1;
  world.set(state.rightEntity, MeshFilter, {
    assetHandle: state.rightMesh === 'shared' ? state.sharedMeshHandle : state.sphereMeshHandle,
  });
}

export function stepAlterMesh(world: World, assets: AssetRegistry, state: AlterMeshState, input: InputSnapshot): void {
  if (input.keyboard.justPressedCode('Enter')) mutateSharedMesh(assets, state);
  if (input.keyboard.justPressedCode('Space')) swapRightMesh(world, state);
}
