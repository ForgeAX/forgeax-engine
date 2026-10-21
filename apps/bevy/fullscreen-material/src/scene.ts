
import { quat } from '@forgeax/engine-math';
import type { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 80;

export function buildFullscreenMaterialWorld(world: World, aspect: number): void {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveCube = sceneAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

const primitiveSphere = sceneAssets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();

  const stone = sceneAssets.create(Materials.standard({ baseColor: [0.12, 0.2, 0.55, 1], roughness: 0.35 })).unwrap();
  const gold = sceneAssets.create(Materials.standard({ baseColor: [0.8, 0.28, 0.04, 1], metallic: 0.2, roughness: 0.25 })).unwrap();

  for (const [x, z, material] of [
    [-1.5, -1.5, stone],
    [1.5, -1.5, gold],
    [1.5, 1.5, stone],
    [-1.5, 1.5, gold],
  ] as const) {
    world.spawn(
      { component: Transform, data: { pos: [x, 0.8, z], scale: [1.25, 1.25, 1.25] } },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [material] } },
    ).unwrap();
  }

  world.spawn(
    { component: Transform, data: { pos: [0, 2.7, 0], scale: [1.25, 1.25, 1.25] } },
    { component: MeshFilter, data: { assetHandle: primitiveSphere } },
    { component: MeshRenderer, data: { materials: [gold] } },
  ).unwrap();

  world.spawn(
    { component: Transform, data: { pos: [4, 6, 4] } },
    { component: PointLight, data: { color: [1, 0.88, 0.72], intensity: 500, range: 40 } },
  ).unwrap();
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0.5, -1, -0.5], color: [1, 1, 1], intensity: 1, castShadow: false },
  }).unwrap();

  const eye: [number, number, number] = [8, 7, 9];
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 1, 0], [0, 1, 0]) } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect, near: CAMERA_NEAR, far: CAMERA_FAR }), clearColor: [0.03, 0.03, 0.05, 1] } },
  ).unwrap();
}
