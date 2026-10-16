import { definePack } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { GI_MATERIAL_PACKAGE, giMaterialKey } from '../src/material-guids.ts';
import { giMaterialAsset } from '../src/materials.ts';
import { GI_MATERIAL_NAMES } from '../src/scenes.ts';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: GI_MATERIAL_PACKAGE,
  name: 'Hello GI / Materials',
  build: () =>
    ok(Object.fromEntries(GI_MATERIAL_NAMES.map((name) => [giMaterialKey(name), giMaterialAsset(name)]))),
});
