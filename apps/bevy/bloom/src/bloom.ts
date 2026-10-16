import { HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import {
  BLOOM_DISABLED,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine-scene';

const GRID_RADIUS = 5;
const GRID_SPACING = 1.8;

export interface BloomScene {
  readonly camera: EntityHandle;
  readonly sphereCount: number;
  readonly emissiveCount: number;
}

function material(world: World, options: Parameters<typeof Materials.standard>[0]): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard(options));
}

function variantAt(x: number, z: number): number {
  return (Math.abs(x * 17 + z * 31 + x * z * 7) + 3) % 6;
}

export function buildBloomWorld(world: World, aspect: number): BloomScene {
  const emissiveBlue = material(world, { baseColor: [0.9, 0.9, 0.9, 1], emissive: [0, 0, 8], emissiveIntensity: 1, roughness: 0.35 });
  const emissiveWhite = material(world, { baseColor: [0.9, 0.9, 0.9, 1], emissive: [12, 12, 12], emissiveIntensity: 1, roughness: 0.35 });
  const emissiveRed = material(world, { baseColor: [0.9, 0.9, 0.9, 1], emissive: [5, 0, 0], emissiveIntensity: 1, roughness: 0.35 });
  const neutral = material(world, { baseColor: [0, 0, 0, 1], roughness: 0.5 });

  let emissiveCount = 0;
  let sphereCount = 0;
  for (let x = -GRID_RADIUS; x < GRID_RADIUS; x += 1) {
    for (let z = -GRID_RADIUS; z < GRID_RADIUS; z += 1) {
      const variant = variantAt(x, z);
      const selected = variant === 0 ? emissiveBlue : variant === 1 ? emissiveWhite : variant === 2 ? emissiveRed : neutral;
      if (selected !== neutral) emissiveCount += 1;
      const scale = variant === 1 ? 0.1 : variant === 2 ? 1 : variant === 0 ? 0.5 : 1.5;
      world.spawn(
        { component: Transform, data: { pos: [x * GRID_SPACING, 0, z * GRID_SPACING], quat: [0, 0, 0, 1], scale: [scale, scale, scale] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
        { component: MeshRenderer, data: { materials: [selected] } },
      );
      sphereCount += 1;
    }
  }

  world.spawn({ component: DirectionalLight, data: { direction: [0.4, -1, 0.3], intensity: 3 } });
  const eye: [number, number, number] = [-2, 10, 16];
  const camera = world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), tonemap: TONEMAP_REINHARD_EXTENDED, bloom: BLOOM_DISABLED, bloomThreshold: 1, bloomIntensity: 1, bloomSoftKnee: 0.5, bloomScatter: 0.7 } },
  ).unwrap();

  return { camera, sphereCount, emissiveCount };
}
