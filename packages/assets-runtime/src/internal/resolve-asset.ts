import type { Asset, MaterialAsset, Result } from '@forgeax/engine-types';
import { ASSET_ERROR_HINTS, AssetError, err, ok } from '@forgeax/engine-types';

/** A realm-local accepted asset view. Published readers never construct a World. */
export interface AssetReader {
  readonly identity: string;
  resolveAsset<T extends Asset>(handle: number, revision?: number): Result<T, AssetError>;
}

/** Runtime materials are complete content; inheritance is resolved before adoption. */
export function readMaterialContent(source: AssetReader, handle: number) {
  const read = source.resolveAsset<MaterialAsset>(handle);
  if (!read.ok) return read;
  if (read.value.kind !== 'material')
    return err(
      new AssetError({
        code: 'asset-reference-invalid',
        expected: 'a material reference',
        hint: ASSET_ERROR_HINTS['asset-reference-invalid'],
      }),
    );
  const material = read.value;
  return ok({
    passes: material.passes ?? [],
    parameters: material.parameters ?? [],
    values: material.values ?? {},
    colorSpace: material.colorSpace,
    surface: material.surface,
  });
}
