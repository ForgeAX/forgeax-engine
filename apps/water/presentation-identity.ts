import { AssetGuid, definePackageId } from '@forgeax/engine/pack/source';
export const WATER_PRESENTATION_PACKAGE = definePackageId('019fcf2d-8100-7000-8000-000000000290');
export const presentationGuid = (key: string) =>
  AssetGuid.format(AssetGuid.derive(WATER_PRESENTATION_PACKAGE, key));
