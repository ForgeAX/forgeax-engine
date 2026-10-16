import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePackageId } from '@forgeax/engine/pack/source';
import type { PackageId } from '@forgeax/engine/pack/source';
import type { AssetGuid as AssetGuidType } from '@forgeax/engine/types';

export function guidText(value: AssetGuidType): string {
  return AssetGuid.format(value);
}

export function assetGuid(packageId: PackageId, sourceKey: string): AssetGuidType {
  return AssetGuid.derive(packageId, sourceKey);
}

export const PACKAGE_IDS = Object.freeze({
  environment: definePackageId('019fb7ce-3100-7000-8000-000000000000'),
  materials: definePackageId('019fb7ce-3200-7000-8000-000000000000'),
  geometry: definePackageId('019fb7ce-3300-7000-8000-000000000000'),
  scene: definePackageId('019fb7ce-3400-7000-8000-000000000000'),
  fantasyMeshes: definePackageId('019fb7ce-3500-7000-8000-000000000000'),
  ui: definePackageId('019fb7ce-3600-7000-8000-000000000000'),
  character: definePackageId('019fb7ce-3700-7000-8000-000000000000'),
});

/** Material identities are derived from the owning Pack namespace and source key. */
export const STANDARD_ROOT_MATERIAL_GUID = assetGuid(PACKAGE_IDS.materials, 'material/standard-root');
export const RUSTED_IRON_MATERIAL_GUID = assetGuid(PACKAGE_IDS.materials, 'material/rusted-iron');

/** Direction stored by DirectionalLight: outgoing from the Sun toward the scene. */
export const SUN_OUTGOING_DIRECTION = [-0.32, -0.91, -0.24] as const;
