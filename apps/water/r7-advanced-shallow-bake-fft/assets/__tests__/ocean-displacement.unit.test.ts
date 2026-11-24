import { CONTENT_PACKAGE_IDS } from '@forgeax/engine/content';
import { AssetGuid, type PackBuildReadContext } from '@forgeax/engine/pack/source';
import { err, ok } from '@forgeax/engine/types';
import { buildWaterMaterialFamily } from '@forgeax/engine/water';
import { expect, it } from 'vitest';
import pack from '../reach.pack';

it('enables FFT height deformation only on the created Ocean surface', async () => {
  const family = buildWaterMaterialFamily(CONTENT_PACKAGE_IDS.water);
  const dependencies = Object.fromEntries(
    Object.entries(family.outputs).map(([key, asset]) => [
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
  const assets = (await pack.build({ packageId: pack.packageId, readByGuid })).unwrap();
  for (const name of ['ocean', 'ocean-active', 'river-fft']) {
    const material = assets[`material/water/${name}`];
    if (material?.kind !== 'material') throw new Error(`Missing ${name} material`);
    expect(material.staticSwitches?.waterOceanPatch, name).toBe(name !== 'ocean');
    expect(material.staticSwitches?.waterOceanDisplacement, name).toBe(name === 'ocean-active');
  }
}, 30_000);
