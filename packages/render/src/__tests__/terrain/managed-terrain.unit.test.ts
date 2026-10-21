import { runtimeAssetReference, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { buildTerrainAssets } from '@forgeax/engine-terrain/cook';
import {
  type AssetHandle,
  type MaterialAsset,
  standardSurfaceParameters,
  type TerrainAsset,
  type TextureAsset,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { terrainSourceFixture } from '../../../../assets-runtime/src/__tests__/fixtures/terrain-source';
import { Layer } from '../../components/layer';
import { ShadowParticipation } from '../../components/shadow-participation';
import type { DispatchEntry, RenderableSnapshot } from '../../render-system-extract';
import { extractTerrainSources } from '../../terrain/source';

it.each([
  'numeric',
  'implicit texture',
  'explicit texture',
] as const)('extracts loaded runtime terrain with %s layer values', async (variant) => {
  const packageId = definePackageId('019fca53-7400-7000-8000-000000000001');
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  const layer: MaterialAsset = {
    kind: 'material',
    ...(variant === 'implicit texture'
      ? {}
      : {
          parameters: standardSurfaceParameters(
            variant === 'explicit texture' ? [{ name: 'baseColorTexture', type: 'texture' }] : [],
          ),
        }),
    values: {
      baseColor: [1, 1, 1, 1],
      ...(variant === 'numeric' ? {} : { baseColorTexture: guid('color') }),
    },
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  };
  const color: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: Uint8Array.of(255, 255, 255, 255),
  };
  const outputs = buildTerrainAssets(
    {
      columns: 2,
      rows: 2,
      spacing: 1,
      subsectionVertices: 2,
      heights: Float32Array.of(0, 0, 0, 1),
      weights: new Float32Array(4).fill(1),
      layers: [{ material: guid('layer'), blend: 'weight' }],
    },
    guid,
    { [guid('layer')]: layer, [guid('color')]: color },
  ).unwrap();
  const { assets, publish } = terrainSourceFixture(guid);
  publish({ layer, color, ...outputs });
  const handle = (await assets.load(guid('terrain'), 'terrain')).unwrap();
  expect(runtimeAssets(assets).dependencies(handle).unwrap()).toHaveLength(5);
  const world = new World({ assets });
  for (const component of [Terrain, Transform, GlobalTransform, Layer, ShadowParticipation])
    world.components.register(component).unwrap();
  const entity = world
    .spawn(
      { component: Terrain, data: { asset: handle } },
      { component: Transform, data: {} },
      {
        component: GlobalTransform,
        data: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
      },
    )
    .unwrap();
  const rows: RenderableSnapshot[] = [];
  const dispatch: DispatchEntry[] = [];
  try {
    extractTerrainSources(world, assets, undefined, 1, rows, dispatch);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.terrain?.handle).toBe(handle);
    const layerHandle = runtimeAssetReference(assets, guid('layer')) as AssetHandle<'material'>;
    const dependencies = runtimeAssets(assets).dependencies(layerHandle).unwrap();
    assets.replace(layerHandle, assets.read(layerHandle).unwrap()).unwrap();
    expect(runtimeAssets(assets).dependencies(layerHandle).unwrap()).toEqual(dependencies);
    const copiedRoot = assets.copy(handle).unwrap();
    assets.release(copiedRoot).unwrap();
    const before = assets.snapshot(handle).unwrap();
    for (const patch of [{ sections: [null] }, { grids: [42] }]) {
      expect(assets.update(handle, patch as unknown as Partial<TerrainAsset>)).toMatchObject({
        ok: false,
        error: { code: 'asset-invalid-value' },
      });
      expect(before.matchesCurrent()).toBe(true);
    }
    assets.update(handle, { heights: new Float32Array(4).fill(4) }).unwrap();
    expect(assets.read(handle).unwrap().heightRange[0]).toBe(4);
    expect(before.matchesCurrent()).toBe(false);
    expect(before.read<TerrainAsset>(handle).unwrap().heights).toEqual(Float32Array.of(0, 0, 0, 1));
    before.dispose();
    assets
      .replace(handle, { ...assets.read(handle).unwrap(), heights: new Float32Array(4).fill(5) })
      .unwrap();
    expect(assets.read(handle).unwrap().heightRange[0]).toBe(5);
    assets.update(layerHandle, { values: { baseColor: [0.5, 1, 1, 1] } }).unwrap();
    // Explicit author replacement derives from the current owned layer values.
    assets.replace(handle, assets.read(handle).unwrap()).unwrap();
    expect(assets.copy(handle).ok).toBe(true);
  } finally {
    world.despawn(entity).unwrap();
    assets.dispose();
  }
});
