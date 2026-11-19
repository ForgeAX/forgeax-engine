import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';

export const waterVisibilityPackage = definePackageId('019a0000-0000-7000-8000-000000000721');
export const waterVisibilityGuid = (key: string) =>
  AssetGuid.format(AssetGuid.derive(waterVisibilityPackage, key));
