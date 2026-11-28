import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  Camera,
  DynamicResolution,
  Materials,
  MeshFilter,
  MeshRenderer,
  ShadowParticipation,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { testAssets } from './helpers/runtime-assets';

export function createDepthOfFieldScene(
  width: number,
  height: number,
  antialias: number,
  scale: number,
  assets?: AssetRegistry,
) {
  const world = new World(assets === undefined ? undefined : { assets });
  const material = testAssets(world)
    .create(Materials.unlit([0.8, 0.2, 0.1, 1]))
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -6], scale: [4, 4, 1] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
        },
      },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: ShadowParticipation, data: { cast: false } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: width / height,
          near: 0.1,
          far: 100,
          antialias,
          tonemap: TONEMAP_NONE,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  if (scale < 1)
    world
      .addComponent(camera, {
        component: DynamicResolution,
        data: { minScale: scale, maxScale: scale, targetGpuMs: 16.67 },
      })
      .unwrap();
  return { world, camera };
}
