import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';

export const WATER_BODY_GEOMETRY_PACKAGE_ID = '019fb7ce-3f00-7000-8000-000000000101';
const parsed = PackageId.parse(WATER_BODY_GEOMETRY_PACKAGE_ID);
if (!parsed.ok) throw new Error('water body geometry packageId is invalid');
export const WATER_BODY_GEOMETRY_PACKAGE_NAMESPACE = parsed.value;

export function waterBodyGeometryGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(WATER_BODY_GEOMETRY_PACKAGE_NAMESPACE, sourceKey));
}
