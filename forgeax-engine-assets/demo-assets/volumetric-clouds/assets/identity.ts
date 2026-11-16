import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePackageId } from '@forgeax/engine/pack/source';

export const cloudPackageId = definePackageId('019a50a5-0000-7000-8000-000000000004');
export const cloudGuid = (key: string) => AssetGuid.format(AssetGuid.derive(cloudPackageId, key));
export const referenceCloudRef = { $asset: cloudGuid('material/reference-layout') } as const;
export const analyticUniformCloudRef = { $asset: cloudGuid('material/analytic-uniform') } as const;
export const bandCloudRef = { $asset: cloudGuid('material/cloud-band') } as const;
export const bandWideInstanceRef = { $asset: cloudGuid('instance/cloud-band-wide') } as const;
