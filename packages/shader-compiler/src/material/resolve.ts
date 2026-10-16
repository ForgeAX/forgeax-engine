export type { MaterialTable, ResolvedMaterial } from '@forgeax/engine-types';

import {
  type MaterialAsset,
  type MaterialError,
  type MaterialTable,
  type ResolvedMaterial,
  type Result,
  resolveMaterialAsset as resolveSharedMaterialAsset,
} from '@forgeax/engine-types';

export function resolveMaterialAsset(
  leaf: string,
  table: MaterialTable,
  onResolved?: (asset: MaterialAsset) => void,
): Result<ResolvedMaterial, MaterialError> {
  const result = resolveSharedMaterialAsset(leaf, table);
  void onResolved;
  return result;
}
