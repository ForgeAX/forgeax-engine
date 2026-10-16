import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';

export const SDF_PACKAGE = definePackageId('019fcaf0-0015-7000-8000-000000000001');
export const sdfGuid = (key: string) => AssetGuid.format(AssetGuid.derive(SDF_PACKAGE, key));
