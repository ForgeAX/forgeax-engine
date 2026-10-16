import { HANDLE_CUBE, HANDLE_QUAD, HANDLE_SPHERE, HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const ANTIALIAS_MODES = [ANTIALIAS_NONE, ANTIALIAS_MSAA, ANTIALIAS_FXAA] as const;
export const ANTIALIAS_NAMES = ['none', 'msaa', 'fxaa'] as const;

export interface AntiAliasingScene {
  readonly camera: EntityHandle;
  readonly shapeCount: number;
}

function material(world: World, options: Parameters<typeof Materials.standard>[0]): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard(options));
}

export function buildAntiAliasingWorld(world: World, aspect: number): AntiAliasingScene {
  const mat = material(world, { baseColor: [0.7, 0.7, 0.7, 1], metallic: 0, roughness: 0.4 });
  const layout = [
    { assetHandle: HANDLE_TRIANGLE, pos: [-1.05, 0, 0] as const, scale: 0.55 },
    { assetHandle: HANDLE_CUBE, pos: [-0.35, 0, 0] as const, scale: 0.5 },
    { assetHandle: HANDLE_QUAD, pos: [0.35, 0, 0] as const, scale: 0.5 },
    { assetHandle: HANDLE_SPHERE, pos: [1.05, 0, 0] as const, scale: 0.5 },
  ];

  for (const shape of layout) {
    world.spawn(
      { component: Transform, data: { pos: shape.pos, quat: [0, 0, 0, 1], scale: [shape.scale, shape.scale, shape.scale] } },
      { component: MeshFilter, data: { assetHandle: shape.assetHandle } },
      { component: MeshRenderer, data: { materials: [mat] } },
    );
  }

  world.spawn({ component: DirectionalLight, data: { direction: [-0.4, -0.6, -0.7], color: [1, 1, 1], intensity: 1.5 } });
  const camera = world.spawn(
    { component: Transform, data: { pos: [0, 0, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect }), antialias: ANTIALIAS_NONE } },
  ).unwrap();
  return { camera, shapeCount: layout.length };
}
