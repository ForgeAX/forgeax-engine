import { CONTENT_PACKAGE_IDS } from '@forgeax/engine/content';
import { AssetGuid, type PackBuildReadContext } from '@forgeax/engine/pack/source';
import { err, type MaterialRootAsset, ok } from '@forgeax/engine/types';
import { buildWaterMaterialFamily } from '@forgeax/engine/water';
import { expect, it } from 'vitest';
import r3 from '../r3-slw-reflection-underwater/assets/water-r3.pack';
import r5 from '../r5-gpu-mesh-async-pontoons/assets/estuary.pack';
import r6 from '../r6-legacy-rt-fluid/assets/basins.pack';
import r7 from '../r7-advanced-shallow-bake-fft/assets/reach.pack';

const water = buildWaterMaterialFamily(CONTENT_PACKAGE_IDS.water);
const dependencies = Object.fromEntries(
  Object.entries(water.outputs).map(([key, asset]) => [
    AssetGuid.format(AssetGuid.derive(CONTENT_PACKAGE_IDS.water, key)),
    asset,
  ]),
);
const readByGuid: PackBuildReadContext['readByGuid'] = async <TAsset>(guid: AssetGuid) => {
  const asset = dependencies[AssetGuid.format(guid)];
  return asset === undefined
    ? err(new Error('Expected Engine Water material'))
    : ok(asset as TAsset);
};

it.each([
  r3,
  r5,
  r6,
  r7,
])('publishes opaque reflection sources for both render paths: $name', async (pack) => {
  const assets = (
    await pack.build({
      packageId: pack.packageId,
      readByGuid,
    })
  ).unwrap();
  const sources = Object.entries(assets).filter((entry): entry is [string, MaterialRootAsset] => {
    const asset = entry[1];
    return (
      asset.kind === 'material' &&
      'passes' in asset &&
      asset.passes.some((pass) => pass.program?.module === 'forgeax_material::standard')
    );
  });
  expect(sources.length).toBeGreaterThan(0);
  for (const [key, asset] of sources) {
    expect(
      asset.passes.find((pass) => pass.renderState?.tags?.LightMode === 'Deferred')?.program,
      `${key}: visible opaque color needs matching GBuffer hit geometry`,
    ).toMatchObject({
      module: 'forgeax_material::standard',
      fragmentEntry: 'fs_gbuffer',
    });
    expect(
      asset.passes.some((pass) => pass.renderState?.tags?.LightMode === 'Forward'),
      key,
    ).toBe(true);
  }
}, 30_000);
