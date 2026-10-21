import type { AssetHandle } from '@forgeax/engine-types';

import type { EntityHandle, World } from '@forgeax/engine-ecs';
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
import { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { createPrimitiveMesh } from '@forgeax/engine-geometry';


export const ANTIALIAS_MODES = [ANTIALIAS_NONE, ANTIALIAS_MSAA, ANTIALIAS_FXAA] as const;
export const ANTIALIAS_NAMES = ['none', 'msaa', 'fxaa'] as const;

export interface AntiAliasingScene {
  readonly camera: EntityHandle;
  readonly shapeCount: number;
}

function material(world: World, options: Parameters<typeof Materials.standard>[0]): AssetHandle<'material'> {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  return sceneAssets.create(Materials.standard(options)).unwrap();
}

export function buildAntiAliasingWorld(world: World, aspect: number): AntiAliasingScene {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

const primitiveTriangle = sceneAssets.create(createPrimitiveMesh('triangle').unwrap()).unwrap();

const primitiveCube = sceneAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

const primitiveQuad = sceneAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

const primitiveSphere = sceneAssets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();

  const mat = material(world, { baseColor: [0.7, 0.7, 0.7, 1], metallic: 0, roughness: 0.4 });
  const layout = [
    { assetHandle: primitiveTriangle, pos: [-1.05, 0, 0] as const, scale: 0.55 },
    { assetHandle: primitiveCube, pos: [-0.35, 0, 0] as const, scale: 0.5 },
    { assetHandle: primitiveQuad, pos: [0.35, 0, 0] as const, scale: 0.5 },
    { assetHandle: primitiveSphere, pos: [1.05, 0, 0] as const, scale: 0.5 },
  ];

  for (const shape of layout) {
    world.spawn(
      { component: Transform, data: { pos: shape.pos, quat: [0, 0, 0, 1], scale: [shape.scale, shape.scale, shape.scale] } },
      { component: MeshFilter, data: { assetHandle: shape.assetHandle } },
      { component: MeshRenderer, data: { materials: [mat] } },
    );
  }

  world.spawn({ component: DirectionalLight, data: { castShadow: true, direction: [-0.4, -0.6, -0.7], color: [1, 1, 1], intensity: 1.5 } });
  const camera = world.spawn(
    { component: Transform, data: { pos: [0, 0, 6], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect }), antialias: ANTIALIAS_NONE } },
  ).unwrap();
  return { camera, shapeCount: layout.length };
}
