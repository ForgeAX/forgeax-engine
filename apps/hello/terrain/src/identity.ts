import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
export const packageId = definePackageId('019fca53-7400-7000-8000-000000000000');
export const terrainGuid = AssetGuid.derive(packageId, 'terrain');
export const materialPackageId = definePackageId('019fca54-7400-7000-8000-000000000000');
export const materialTerrainGuid = (encoding: 'weights' | 'ids') =>
  AssetGuid.derive(materialPackageId, `${encoding}/terrain`);

/** Fixture bootstrap POD selects the same production Catalog root in each realm. */
export function terrainBootstrapData(value: unknown): {
  readonly channel: string;
  readonly rootGuid: AssetGuid;
} {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('channel' in value) ||
    typeof value.channel !== 'string' ||
    !('rootGuid' in value) ||
    typeof value.rootGuid !== 'string'
  )
    throw new Error('terrain Worker requires channel and root GUID bootstrap data');
  const parsed = AssetGuid.parse(value.rootGuid);
  if (!parsed.ok) throw parsed.error;
  return { channel: value.channel, rootGuid: parsed.value };
}
