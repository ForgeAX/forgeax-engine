import { type AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import type { Asset, AssetKind } from '@forgeax/engine-types';

/** Exercise workspace GUID operations through the actual Catalog/Pack owner. */
export function publishWorkspaceAssets(
  assets: AssetRegistry,
  entries: readonly {
    readonly guid: string;
    readonly asset: Asset;
    readonly refs?: readonly string[];
  }[],
): void {
  for (const contribution of defaultAssetDecoderContributions)
    assets.installDecoder(contribution.kind as AssetKind<unknown>, contribution.decoder);
  const packageUrl = 'https://workspace.invalid/fixture.pack.json';
  const { pack, publication } = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'workspace',
    sourceRevision: 'fixture',
    packageUrl,
    pack: {
      assets: entries.map(({ guid, asset, refs }) => ({
        guid,
        kind: asset.kind,
        payload: asset,
        refs: [...(refs ?? [])],
        artifacts: {},
      })),
    },
  });
  const body = JSON.stringify(pack, (key, value) => {
    if (key === 'defaultMaterial' && value instanceof Uint8Array)
      return AssetGuid.format(value as AssetGuid);
    return ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value;
  });
  assets.setCatalogSource(
    createCatalogSource({
      entries: entries.map(({ guid, asset }) => ({
        guid,
        kind: asset.kind,
        sourcePath: 'workspace',
        packageUrl,
        publication,
      })),
      fetch: async () => new Response(body),
    }),
  );
}
