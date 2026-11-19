import { type AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import {
  createRuntimePackPublication,
  type RuntimePackAssetInput,
} from '@forgeax/engine-pack/runtime';

/** Publish ordinary test source assets through the verified Pack JSON boundary. */
export function publishTestAssets(
  assets: AssetRegistry,
  entries: readonly RuntimePackAssetInput[],
  artifactResponses: ReadonlyMap<string, Uint8Array> = new Map(),
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
  const artifactUrls = new Map(
    [...artifactResponses].map(([path, bytes]) => [new URL(path, packageUrl).href, bytes]),
  );
  assets.setCatalogSource(
    createCatalogSource({
      entries: entries.map(({ guid, kind }) => ({
        guid,
        kind,
        refs:
          produced.pack.assets.find((asset) => asset.guid.toLowerCase() === guid.toLowerCase())
            ?.refs ?? [],
        sourcePath,
        packageUrl,
        publication: produced.publication,
      })),
      fetch: async (input) => {
        const url = String(input);
        if (url === packageUrl) return new Response(body);
        const bytes = artifactUrls.get(url);
        return bytes === undefined
          ? new Response('missing', { status: 404 })
          : new Response(new Uint8Array(bytes));
      },
    }),
  );
}
