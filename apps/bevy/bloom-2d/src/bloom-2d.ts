import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { MaterialAsset } from '@forgeax/engine-types';
import { BLOOM_DISABLED, Camera, Materials, MeshFilter, MeshRenderer, orthographic, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine-scene';

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
    const mat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', material(color));
    world.spawn(
      { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [size, size, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [mat] } },
    );
    brightCount += bright;
  }

  const camera = world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { ...orthographic(ORTHO), tonemap: TONEMAP_REINHARD_EXTENDED, bloom: BLOOM_DISABLED, bloomThreshold: 1, bloomIntensity: 1, bloomSoftKnee: 0.5, bloomScatter: 0.7 } },
  ).unwrap();

  return { camera, quadCount: colors.length, brightCount };
}
