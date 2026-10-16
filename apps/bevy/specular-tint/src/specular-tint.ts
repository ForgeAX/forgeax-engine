import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective, PointLight, SkyboxBackground, Skylight, TONEMAP_ACES_FILMIC } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export function buildSpecularTintWorld(world: World, equirect: Handle<'EquirectAsset', 'shared'>, specularColorTexture: number, aspect: number): void {
  const sphereGeometry = createSphereGeometry(1.05, 48, 32);
  if (!sphereGeometry.ok) throw new Error(`specular tint sphere failed: ${sphereGeometry.error.code}`);
  const sphere = world.allocSharedRef('MeshAsset', sphereGeometry.value);
  const base = { baseColor: [0, 0, 0, 1] as const, metallic: 0, roughness: 0.08 };
  const neutral = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ ...base, specularColor: [1, 1, 1] }));
  const solid = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ ...base, specularColor: [1, 0.08, 0.65] }));
  const mapped = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ ...base, specularColorTexture }));
  for (const [x, material] of [[-2.15, neutral], [0, solid], [2.15, mapped]] as const) {
    world.spawn({ component: Transform, data: { pos: [x, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } }, { component: MeshFilter, data: { assetHandle: sphere } }, { component: MeshRenderer, data: { materials: [material] } });
  }
  const floor = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({ baseColor: [0.06, 0.07, 0.09, 1], metallic: 0.1, roughness: 0.28 }));
  world.spawn({ component: Transform, data: { pos: [0, -1.2, 0], quat: [0, 0, 0, 1], scale: [7, 0.05, 5] } }, { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } }, { component: MeshRenderer, data: { materials: [floor] } });
  world.spawn({ component: PointLight, data: { color: [1, 0.72, 0.55], intensity: 20_000, range: 20 } });
  world.spawn({ component: DirectionalLight, data: { direction: [-0.35, -0.8, -0.45], intensity: 250 } });
  world.spawn({ component: Skylight, data: { equirect, intensity: 0.6, rotation: [0, 0, 0, 1] } });
  world.spawn({ component: SkyboxBackground, data: { equirect, rotation: [0, 0, 0, 1] } });
  const eye: [number, number, number] = [0, 0.35, 7.6];
  world.spawn({ component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } }, { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect, near: 0.1, far: 100 }), tonemap: TONEMAP_ACES_FILMIC } });
}
