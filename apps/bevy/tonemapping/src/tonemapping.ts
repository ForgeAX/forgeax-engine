import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_NONE,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const TONEMAP_MODES = [
  TONEMAP_NONE,
  TONEMAP_REINHARD_EXTENDED,
  TONEMAP_LINEAR,
  TONEMAP_CINEON,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_NEUTRAL,
] as const;

export const TONEMAP_NAMES = ['none', 'reinhard', 'linear', 'cineon', 'aces', 'agx', 'neutral'] as const;

export interface TonemappingScene {
  readonly camera: EntityHandle;
  readonly sphereCount: number;
}

function material(world: World, options: Parameters<typeof Materials.standard>[0]): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard(options));
}

export function buildTonemappingWorld(world: World, aspect: number): TonemappingScene {
  const neutral = material(world, { baseColor: [0.03, 0.03, 0.03, 1], roughness: 0.8 });
  const warm = material(world, {
    baseColor: [0.7, 0.12, 0.03, 1], emissive: [4, 0.08, 0.01], emissiveIntensity: 1,
    metallic: 0.1, roughness: 0.35,
  });
  const green = material(world, {
    baseColor: [0.08, 0.7, 0.12, 1], emissive: [0.04, 4, 0.08], emissiveIntensity: 1,
    metallic: 0.1, roughness: 0.35,
  });
  const blue = material(world, {
    baseColor: [0.04, 0.12, 0.8, 1], emissive: [0.01, 0.08, 4], emissiveIntensity: 1,
    metallic: 0.1, roughness: 0.35,
  });
  const white = material(world, {
    baseColor: [0.8, 0.8, 0.8, 1], emissive: [4, 4, 4], emissiveIntensity: 1,
    metallic: 0, roughness: 0.35,
  });
  const materials = [warm, green, blue, white, neutral] as const;

  let sphereCount = 0;
  for (let row = -1; row <= 1; row += 1) {
    for (let column = -3; column <= 3; column += 1) {
      const index = (column + row * 2 + 9) % materials.length;
      const selected = materials[index] ?? neutral;
      const scale = selected === white ? 0.7 : selected === neutral ? 0.55 : 0.65;
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [column * 1.35, row * 1.25, 0],
            quat: [0, 0, 0, 1],
            scale: [scale, scale, scale],
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
        { component: MeshRenderer, data: { materials: [selected] } },
      );
      sphereCount += 1;
    }
  }

  world.spawn({ component: DirectionalLight, data: { direction: [0.4, -1, 0.3], intensity: 2 } });
  const eye: [number, number, number] = [0, 3.2, 12];
  const camera = world.spawn(
    {
      component: Transform,
      data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] },
    },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), tonemap: TONEMAP_NONE } },
  ).unwrap();

  return { camera, sphereCount };
}
