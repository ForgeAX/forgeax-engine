import { type AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import {
  createRuntimePackPublication,
  type RuntimePackAssetInput,
} from '@forgeax/engine-pack/runtime';

/** Publish ordinary test source assets through the verified Pack JSON boundary. */
export function publishTestAssets(
  assets: AssetRegistry,
  entries: readonly RuntimePackAssetInput[],
): void {
  const sourcePath = 'fixtures.pack',
    packageUrl = 'https://runtime-fixture.invalid/assets.pack.json';
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath,
    sourceRevision: 'fixture',
    packageUrl,
    pack: { assets: entries },
  });
  const body = JSON.stringify(produced.pack, (_key, value) =>
    ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
  );
  assets.setCatalogSource(
    createCatalogSource({
      entries: entries.map(({ guid, kind }) => ({
        guid,
        kind,
        sourcePath,
        packageUrl,
        publication: produced.publication,
      })),
      fetch: async () => new Response(body),
    }),
  );
}
