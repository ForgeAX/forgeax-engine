import type { World } from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { DirectionalLight, DirectionalShadowFilterValue, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

/** Fixed lighting and exposure: only occlusion geometry and filter controls vary. */
export function spawnSsaoRoom(world: World) {
  const material = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.62, 0.66, 0.7, 1], roughness: 0.9,
  }));
  const mesh = (pos: number[], scale: number[]) => world.spawn(
    { component: Transform, data: { pos, scale } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material] } },
  ).unwrap();
  const wall = mesh([-2.5, 0.75, -0.5], [0.12, 3.5, 5]);
  mesh([-0.5, 0.75, -3], [4, 3.5, 0.12]);
  const pole = mesh([1.8, 0.25, -1.2], [0.12, 2.5, 0.12]);
  mesh([1.5, -0.75, 0.8], [0.5, 0.5, 0.5]);
  mesh([1.9, -0.85, 1.1], [0.3, 0.3, 0.3]);
  const light = world.spawn({ component: DirectionalLight, data: {
    direction: [-0.6, -1, -0.4], intensity: 2, castShadow: true,
    cascadeCount: 4, splitLambda: 0.75, cascadeBlend: 0.2,
    mapSize: 1024, shadowDistance: 20,
    shadowFilter: DirectionalShadowFilterValue.pcssMedium,
    shadowAngularRadius: 0.025, maxPenumbraTexels: 32,
  } }).unwrap();
  return { wall, pole, light };
}
