import type { World } from '@forgeax/engine-ecs';
import type { Asset, Handle, Result, TextureAsset } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export type TilesetRuntimeErrorCode =
  | 'tileset-atlas-not-found'
  | 'tileset-atlas-stale'
  | 'tileset-atlas-kind-mismatch';

export interface TilesetRuntimeError {
  readonly code: TilesetRuntimeErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly guid: string;
    readonly actualKind?: string;
  };
}

export interface ResolvedTilesetRuntime {
  readonly guid: string;
  readonly payload: TextureAsset;
  readonly handle: Handle<'TextureAsset', 'shared'>;
}

export type TilesetAtlasLookup = Asset | { readonly code: 'stale' } | undefined;

/** Project one durable atlas GUID into the current World at the tilemap owner. */
export function resolveTilesetRuntime(
  world: World,
  guid: string,
  lookup: (guid: string) => TilesetAtlasLookup,
): Result<ResolvedTilesetRuntime, TilesetRuntimeError> {
  if (guid.length === 0) {
    return err({
      code: 'tileset-atlas-not-found',
      expected: 'a non-empty durable atlas GUID',
      hint: 'load the atlas payload before extracting the tilemap',
      detail: { guid },
    });
  }
  const payload = lookup(guid);
  if (payload === undefined) {
    return err({
      code: 'tileset-atlas-not-found',
      expected: `a loaded texture payload for atlas GUID ${guid}`,
      hint: 'load or retain the atlas before extracting the tilemap',
      detail: { guid },
    });
  }
  if ('code' in payload) {
    return err({
      code: 'tileset-atlas-stale',
      expected: `a current texture payload for atlas GUID ${guid}`,
      hint: 'rebuild the stale atlas projection before extracting the tilemap',
      detail: { guid },
    });
  }
  if (payload.kind !== 'texture') {
    return err({
      code: 'tileset-atlas-kind-mismatch',
      expected: 'a texture atlas payload',
      hint: `replace atlas GUID ${guid} with a texture asset`,
      detail: { guid, actualKind: payload.kind },
    });
  }
  return ok({
    guid,
    payload,
    handle: world.internSharedRef('TextureAsset', payload),
  });
}
