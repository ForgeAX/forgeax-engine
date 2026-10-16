import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import type { MaterialAsset } from '@forgeax/engine-types';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective, PointLight, Skylight, TONEMAP_ACES_FILMIC } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export interface SsaoScene {
  readonly camera: EntityHandle;
  readonly meshCount: number;
}

export function buildSsaoWorld(world: World, aspect: number): SsaoScene {
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.48, 0.52, 0.62, 1],
      metallic: 0,
      roughness: 0.78,
    }),
  );
  const floor = world.spawn(
    { component: Transform, data: { pos: [0, -1.1, 0], quat: [0, 0, 0, 1], scale: [5, 0.12, 4] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
  floor.unwrap();
  const positions: readonly [number, number, number][] = [
    [-1.5, -0.05, 0], [0, -0.05, 0], [1.5, -0.05, 0],
    [-0.75, 0.9, -0.1], [0.75, 0.9, -0.1], [0, 1.8, -0.2],
  ];
  for (const pos of positions) {
    world.spawn(
      { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [0.78, 0.78, 0.78] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    );
  }
  world.spawn({ component: DirectionalLight, data: { direction: [-0.45, -0.85, -0.35], color: [1, 0.94, 0.82], intensity: 0, castShadow: true } });
  world.spawn(
    { component: Transform, data: { pos: [0, 2.2, 2.2], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 0.72, 0.48], intensity: 0, range: 8 } },
  );
  world.spawn({ component: Skylight, data: { color: [0.85, 0.85, 0.9], intensity: 2 } });
  const eye: [number, number, number] = [0, 2.8, 8];
  const camera = world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0.1, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect, near: 0.1, far: 50 }), tonemap: TONEMAP_ACES_FILMIC, clearColor: [0.025, 0.03, 0.045, 1] } },
  ).unwrap();
  return { camera, meshCount: positions.length + 1 };
}
