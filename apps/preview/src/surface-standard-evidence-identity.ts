import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';

/** One identity authority shared by the Preview evidence producer and reader. */
export const SURFACE_EVIDENCE_PACKAGE_ID = '019fb7ce-3f00-7000-8000-000000000000';

const parsedNamespace = PackageId.parse(SURFACE_EVIDENCE_PACKAGE_ID);
if (!parsedNamespace.ok) throw new Error('surface evidence packageId is invalid');
export const SURFACE_EVIDENCE_PACKAGE_NAMESPACE = parsedNamespace.value;

export const WATER_R0_RECIPE_PACKAGE_ID = '01a1d65d-c6aa-7861-8018-efe0e3b473e3';
export const WATER_R0_TERRAIN_PACKAGE_ID = '01a1d659-3cab-7d64-9aa1-11061ff197bf';

const waterRecipeNamespace = PackageId.parse(WATER_R0_RECIPE_PACKAGE_ID);
const waterTerrainNamespace = PackageId.parse(WATER_R0_TERRAIN_PACKAGE_ID);
if (!waterRecipeNamespace.ok || !waterTerrainNamespace.ok)
  throw new Error('Water R0 package identity is invalid');
export const WATER_R0_RECIPE_PACKAGE_NAMESPACE = waterRecipeNamespace.value;
export const WATER_R0_TERRAIN_PACKAGE_NAMESPACE = waterTerrainNamespace.value;

export function surfaceEvidenceGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(SURFACE_EVIDENCE_PACKAGE_NAMESPACE, sourceKey));
}

export function waterR0RecipeGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(WATER_R0_RECIPE_PACKAGE_NAMESPACE, sourceKey));
}

export function waterR0TerrainGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(WATER_R0_TERRAIN_PACKAGE_NAMESPACE, sourceKey));
}
