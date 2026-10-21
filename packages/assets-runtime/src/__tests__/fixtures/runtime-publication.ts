import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { meshAssetContribution } from '@forgeax/engine-geometry';
import { textureContribution } from '@forgeax/engine-image';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { materialContribution } from '@forgeax/engine-render';
import type { Asset } from '@forgeax/engine-types';
import { createCatalogSource } from '../../catalog-source';

/** Use the real source/decode/adopt boundary, including its JSON transport. */
export function prepareRuntimeAssetPublication(
  entries: readonly { guid: string; asset: Asset; refs?: readonly string[]; sourceKey?: string }[],
) {
  const packageUrl = 'https://runtime-assets.invalid/pack.json';
  const sourcePath = 'assets.pack';
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath,
    sourceRevision: 'fixture',
    packageUrl,
    sourceKeys: new Map(
      entries.flatMap(({ guid, sourceKey }) =>
        sourceKey === undefined ? [] : [[guid, sourceKey]],
      ),
    ),
    pack: {
      assets: entries.map(({ guid, asset, refs }) => ({
        guid,
        kind: asset.kind,
        payload: asset,
        refs: refs ?? [],
        artifacts: {},
      })),
    },
  });
  const body = JSON.stringify(publication.pack, (_key, value) =>
    ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
  );
  const catalog = entries.map(({ guid, asset, sourceKey }) => ({
    guid,
    kind: asset.kind,
    packageUrl,
    sourcePath,
    publication: publication.publication,
    ...(sourceKey === undefined ? {} : { sourceKey }),
  }));
  // Wire encoding is producer work. Every installation owns a fresh source,
  // Registry, decode and adoption even when fixtures share these immutable bytes.
  return (assets: AssetRegistry) => {
    assets.installDecoder(materialContribution.kind, materialContribution.decoder);
    assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
    assets.installDecoder(textureContribution.kind, textureContribution.decoder);
    assets.setCatalogSource(
      createCatalogSource({
        entries: catalog,
        fetch: async () => new Response(body),
      }),
    );
  };
}

export function publishRuntimeAssets(
  assets: AssetRegistry,
  entries: Parameters<typeof prepareRuntimeAssetPublication>[0],
) {
  prepareRuntimeAssetPublication(entries)(assets);
}
