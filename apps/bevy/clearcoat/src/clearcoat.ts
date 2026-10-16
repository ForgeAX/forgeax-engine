import { HANDLE_CUBE, type AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { CLEARCOAT_MATERIAL_GUID } from './material-identity.ts';

export async function buildClearcoatWorld(
  world: World,
  assets: AssetRegistry,
  equirect: Handle<'EquirectAsset', 'shared'>,
  aspect: number,
): Promise<void> {
  const loadedClearcoat = await assets.loadByGuid<MaterialAsset>(CLEARCOAT_MATERIAL_GUID);
  if (!loadedClearcoat.ok) throw new Error(`clearcoat material failed: ${loadedClearcoat.error.code}`);
  const sphereGeometry = createSphereGeometry(1.1, 48, 32);
  if (!sphereGeometry.ok) throw new Error(`clearcoat sphere failed: ${sphereGeometry.error.code}`);
  const sphere = world.allocSharedRef('MeshAsset', sphereGeometry.value);
  const base = { baseColor: [0.62, 0.045, 0.018, 1] as const, metallic: 0.15, roughness: 0.4 };
  const noCoat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard(base));
  const clearcoat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset', loadedClearcoat.value,
  );
  for (const [x, material] of [[-1.35, noCoat], [1.35, clearcoat]] as const) {
    world.spawn(
      { component: Transform, data: { pos: [x, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: sphere } },
      { component: MeshRenderer, data: { materials: [material] } },
    );
  }
  const floor = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset', Materials.standard({ baseColor: [0.06, 0.07, 0.09, 1], metallic: 0.1, roughness: 0.28 }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, -1.25, 0], quat: [0, 0, 0, 1], scale: [7, 0.05, 5] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [floor] } },
  );
  world.spawn({ component: PointLight, data: { color: [1, 0.72, 0.55], intensity: 20_000, range: 20 } });
  world.spawn({ component: DirectionalLight, data: { direction: [-0.35, -0.8, -0.45], intensity: 250 } });
  world.spawn({ component: Skylight, data: { equirect, intensity: 0.6, rotation: [0, 0, 0, 1] } });
  world.spawn({ component: SkyboxBackground, data: { equirect, rotation: [0, 0, 0, 1] } });
  const eye: [number, number, number] = [0, 0.35, 7.2];
  world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect, near: 0.1, far: 100 }), tonemap: TONEMAP_ACES_FILMIC } },
  );
}
