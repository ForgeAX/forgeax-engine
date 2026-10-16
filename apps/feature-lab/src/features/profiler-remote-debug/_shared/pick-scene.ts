import type { EntityHandle } from '@forgeax/engine/ecs';
import { World } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine/render';
import { propagateTransforms, Transform } from '@forgeax/engine/scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine/types';

export const VIEWPORT = 600;

export interface PickScene {
  readonly world: World;
  readonly camera: EntityHandle;
  readonly near: EntityHandle;
  readonly far: EntityHandle;
  readonly side: EntityHandle;
  readonly mesh: MeshAsset;
}

export function makePickScene(
  projection: 'perspective' | 'orthographic' = 'perspective',
): PickScene {
  const world = new World();
  const mesh = createBoxGeometry(1, 1, 1, 1, 1, 1).unwrap();
  const meshHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh);
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([1, 1, 1, 1]),
  );
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection:
            projection === 'perspective'
              ? CAMERA_PROJECTION_PERSPECTIVE
              : CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: -3,
          right: 3,
          top: 3,
          bottom: -3,
        },
      },
    )
    .unwrap();
  const box = (pos: [number, number, number]): EntityHandle =>
    world
      .spawn(
        { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const near = box([0, 0, 1]);
  const far = box([0, 0, -2]);
  const side = box([1.2, 0, 0]);
  propagateTransforms(world);
  return { world, camera, near, far, side, mesh };
}

export function worldFingerprint(world: World): string {
  const snapshot = world.inspect();
  return JSON.stringify([snapshot.entityCount, snapshot.archetypeCount]);
}
