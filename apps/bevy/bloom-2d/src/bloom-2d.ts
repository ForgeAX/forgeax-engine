
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { MaterialAsset } from '@forgeax/engine-types';
import { BLOOM_DISABLED, Camera, Materials, MeshFilter, MeshRenderer, orthographic, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine-scene';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine/geometry';


const ORTHO = { left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 } as const;

export interface Bloom2dScene {
  readonly camera: EntityHandle;
  readonly quadCount: number;
  readonly brightCount: number;
}

function material(color: readonly [number, number, number, number]): MaterialAsset {
  return Materials.unlit(color);
}

export function buildBloom2dWorld(world: World): Bloom2dScene {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveQuad = sceneAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

  const colors: readonly [readonly [number, number, number, number], readonly [number, number, number], number, number][] = [
    [[8, 0.05, 0.02, 1], [-360, 135, 0], 170, 1],
    [[0.05, 7, 0.08, 1], [0, 0, 0], 150, 1],
    [[0.05, 0.15, 8, 1], [360, 135, 0], 190, 1],
    [[5, 1.5, 0.05, 1], [-250, -150, 0], 90, 1],
    [[0.08, 0.08, 0.08, 1], [0, -150, 0], 100, 0],
    [[0.08, 0.08, 0.08, 1], [250, -150, 0], 100, 0],
  ];

  let brightCount = 0;
  for (const [color, pos, size, bright] of colors) {
    const mat = sceneAssets.create(material(color)).unwrap();
    world.spawn(
      { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [size, size, 1] } },
      { component: MeshFilter, data: { assetHandle: primitiveQuad } },
      { component: MeshRenderer, data: { materials: [mat] } },
    );
    brightCount += bright;
  }

  const camera = world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { ...orthographic(ORTHO), tonemap: TONEMAP_REINHARD_EXTENDED, bloom: BLOOM_DISABLED, bloomThreshold: 1, bloomIntensity: 1, bloomSmoothWidth: 0.01, bloomRadius: 0 } },
  ).unwrap();

  return { camera, quadCount: colors.length, brightCount };
}
