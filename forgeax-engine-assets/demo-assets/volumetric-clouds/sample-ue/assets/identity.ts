import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePackageId } from '@forgeax/engine/pack/source';

export const standardUeTexturePackageId = definePackageId('019a50a5-0000-7000-8000-000000000006');
export const standardUeGuid = (key: string) => AssetGuid.format(AssetGuid.derive(standardUeTexturePackageId, key));
export const standardUeCloudRef = { $asset: standardUeGuid('material/sample-ue') } as const;
