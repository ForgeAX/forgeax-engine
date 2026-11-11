import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../components';
import { resolveEntityMaterialHandles } from '../entity-materials';
import { Materials } from '../materials';

it('resolves entity materials like the renderer: override, then mesh slot default', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const slotDefault = assets.create(Materials.standard({ baseColor: [1, 0, 0, 1] })).unwrap();
  const override = assets.create(Materials.standard({ baseColor: [0, 1, 0, 1] })).unwrap();
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  const mesh = assets
    .create({ ...geometry, materialSlots: [{ slotName: 'surface', defaultMaterial: slotDefault }] })
    .unwrap();
  const inherited = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [] } },
    )
    .unwrap();
  const overridden = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [override] } },
    )
    .unwrap();
  const meshless = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshRenderer, data: { materials: [override] } },
    )
    .unwrap();
  expect(resolveEntityMaterialHandles(world, inherited)).toEqual([slotDefault]);
  expect(resolveEntityMaterialHandles(world, overridden)).toEqual([override]);
  expect(resolveEntityMaterialHandles(world, meshless)).toEqual([override]);
  assets.dispose();
});
