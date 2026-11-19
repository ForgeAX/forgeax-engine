import { AssetGuid, type PackBuildReadContext } from '@forgeax/engine/pack/source';
import {
  AssetError,
  err,
  type MaterialAsset,
  materialGuidText,
  ok,
  type Result,
  resolveMaterialAsset,
} from '@forgeax/engine/types';

/** Resolve tracked author sources before a runtime parent can project its static contract. */
export async function resolveDemoMaterialSource(
  material: MaterialAsset,
  readByGuid: PackBuildReadContext['readByGuid'],
): Promise<Result<MaterialAsset, unknown>> {
  if (material.parent === undefined) return ok(material);
  const leaf = 'demo-material-source';
  const table: Record<string, MaterialAsset> = { [leaf]: material };
  let current: MaterialAsset = material;
  while (current.parent !== undefined) {
    const parent = materialGuidText(current.parent);
    const parsed = AssetGuid.parse(parent);
    if (!parsed.ok) return err(parsed.error);
    if (Object.hasOwn(table, parent)) break;
    const read = await readByGuid(parsed.value);
    if (!read.ok) return err(read.error);
    if (read.value.kind !== 'material') {
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: `material author source for parent ${parent}, received ${read.value.kind}`,
          hint: 'reference an ordinary material source GUID in the authored parent chain',
        }),
      );
    }
    // Cooked receipts belong to the new leaf's normal Pack producer.
    const { cooked: _cooked, ...source } = read.value as MaterialAsset & { cooked?: unknown };
    table[parent] = source;
    current = source;
  }
  const resolved = resolveMaterialAsset(leaf, table);
  return resolved.ok ? ok(resolved.value.asset) : err(resolved.error);
}
