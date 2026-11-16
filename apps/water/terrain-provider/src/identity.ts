import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';

export const WATER_TERRAIN_PROVIDER_PACKAGE_ID = '019fcf2d-7100-7000-8000-000000000201';
const parsed = PackageId.parse(WATER_TERRAIN_PROVIDER_PACKAGE_ID);
if (!parsed.ok) throw new Error('water terrain provider packageId is invalid');
export const WATER_TERRAIN_PROVIDER_PACKAGE_NAMESPACE = parsed.value;

export function waterTerrainProviderGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(WATER_TERRAIN_PROVIDER_PACKAGE_NAMESPACE, sourceKey));
}
