import {
  AssetError,
  type AssetHandle,
  type AssetReferenceOwner,
  err,
  materialGuidText,
  ok,
  type Result,
  type TilesetAsset,
} from '@forgeax/engine-types';

/** Link the atlas closure once at asset admission; Tilemap instances are never visited. */
export function linkRuntimeTileset(
  tileset: TilesetAsset,
  owner: AssetReferenceOwner,
  source: (guid: string) => AssetHandle | undefined,
): Result<{ value: TilesetAsset; dependencies: readonly number[] }, AssetError> {
  const atlases: AssetHandle<'texture'>[] = [];
  for (const input of tileset.atlases) {
    const handle =
      typeof input === 'number'
        ? input
        : typeof input === 'string'
          ? source(input)
          : input instanceof Uint8Array && input.length === 16
            ? source(materialGuidText(input))
            : undefined;
    if (handle === undefined || !Number.isInteger(handle) || handle <= 0 || handle > 0xffff_ffff)
      return err(
        new AssetError({
          code: 'asset-invalid-value',
          expected: 'a loaded texture handle or source GUID for every Tileset atlas',
          hint: 'load or create the atlas textures in this asset owner before creating the Tileset',
        }),
      );
    const valid = owner.validate(handle, 'texture');
    if (!valid.ok) return valid;
    atlases.push(handle as AssetHandle<'texture'>);
  }
  return ok({ value: { ...tileset, atlases }, dependencies: [...new Set(atlases)] });
}
