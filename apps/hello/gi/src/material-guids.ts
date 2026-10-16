import { AssetGuid } from '@forgeax/engine-pack/guid';
import { definePackageId } from '@forgeax/engine-pack/source';
import type { GiMaterialName } from './scenes.ts';

export const GI_MATERIAL_PACKAGE = definePackageId('019fe6a1-6100-7000-8000-000000000000');

export const giMaterialKey = (name: GiMaterialName) => `material/${name}`;

/** Material identity derives from the Pack namespace and source key, never a parallel table. */
export const giMaterialGuid = (name: GiMaterialName) =>
  AssetGuid.format(AssetGuid.derive(GI_MATERIAL_PACKAGE, giMaterialKey(name)));
