import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';

/** One identity authority shared by the Preview evidence producer and reader. */
export const SURFACE_EVIDENCE_PACKAGE_ID = '019fb7ce-3f00-7000-8000-000000000000';

const parsedNamespace = PackageId.parse(SURFACE_EVIDENCE_PACKAGE_ID);
if (!parsedNamespace.ok) throw new Error('surface evidence packageId is invalid');
export const SURFACE_EVIDENCE_PACKAGE_NAMESPACE = parsedNamespace.value;

export function surfaceEvidenceGuid(sourceKey: string): string {
  return AssetGuid.format(AssetGuid.derive(SURFACE_EVIDENCE_PACKAGE_NAMESPACE, sourceKey));
}
