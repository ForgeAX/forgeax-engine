import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
export const FIELD_PACKAGE = definePackageId('01a11250-0021-7000-8000-000000000001');
export const fieldGuid = (key: string) => AssetGuid.format(AssetGuid.derive(FIELD_PACKAGE, key));
