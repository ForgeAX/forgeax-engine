// apps/bevy/skybox - source-aligned scene for Bevy's examples/3d/skybox.rs.

import type { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  SkyboxBackground,
  Skylight,
  perspective,
} from '@forgeax/engine-render';
import { SKYBOX_MODE_CUBEMAP, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine-render';
import type { Handle } from '@forgeax/engine-types';
import { quat } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';

export function buildSkyboxWorld(
  world: World,
  equirect: Handle<'EquirectAsset', 'shared'>,
  aspect: number,
  options: { includeSkybox?: boolean } = {},
): void {
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 32_000 },
  }).unwrap();

  world.spawn({
    component: Skylight,
    data: { equirect, intensity: 1.0 },
  }).unwrap();

  if (options.includeSkybox !== false) {
    world.spawn({
      component: SkyboxBackground,
      data: { equirect, mode: SKYBOX_MODE_CUBEMAP },
    }).unwrap();
  }

  const cameraPosition: [number, number, number] = [0, 0, 8];
  world.spawn(
    {
      component: Transform,
      data: {
        pos: cameraPosition,
        quat: quat.fromLookAt(quat.create(), cameraPosition, [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 3, aspect, near: 0.1, far: 100 }),
        tonemap: TONEMAP_REINHARD_EXTENDED,
      },
    },
  ).unwrap();
}
