import type { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  Skylight,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

/** A two-mesh contact test, shared by the browser and native renderer. */
export function spawnSsaoScene(world: World, aspect = 16 / 9) {
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.7, 0.7, 0.7, 1],
      roughness: 0.9,
    }),
  );
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, -1, 0], scale: [12, 12, 1], quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const movingContact = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0], scale: [2, 2, 2] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world.spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 0.7 } }).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [2, 4, 2] } },
      { component: PointLight, data: { color: [1, 1, 1], intensity: 5, range: 25 } },
    )
    .unwrap();
  const yaw = Math.atan2(3, 6),
    pitch = -Math.atan2(3, Math.hypot(3, 6));
  const sx = Math.sin(pitch / 2),
    cx = Math.cos(pitch / 2);
  const sy = Math.sin(yaw / 2),
    cy = Math.cos(yaw / 2);
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: [3, 3, 6], quat: [sx * cy, cx * sy, -sx * sy, cx * cy] },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect, near: 0.1, far: 50 }),
          clearColor: [0.12, 0.14, 0.17, 1],
        },
      },
    )
    .unwrap();
  return { movingContact, camera };
}
