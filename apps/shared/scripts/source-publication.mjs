import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createCatalogSource } from '@forgeax/engine-assets-runtime';

/** Read the actual app build publication through the normal JSON/asset decoder path. */
export function useBuiltAssetSource(assets, directory) {
  const root = resolve(directory);
  const origin = 'https://smoke-assets.invalid';
  assets.setCatalogSource(createCatalogSource({
    url: `${origin}/pack-index.json`,
    fetch: async input => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (url.origin !== origin || !path.startsWith(root + sep))
        throw new Error('Smoke asset request escaped the app build publication');
      try {
        return new Response(await readFile(path));
      } catch (error) {
        if (error?.code === 'ENOENT') return new Response(null, { status: 404 });
        throw error;
      }
    },
  }));
}

/** Publish a native importer/cooker result through the same finalizer and decoder path as Vite. */
export async function useImportedAssetSource(assets, product, sourcePath) {
  const { projectImportProductForBuild } = await import('@forgeax/engine-import');
  const { finalizePackageTransportSource, createRuntimePackPublication } = await import('@forgeax/engine-pack/build');
  const packageUrl = 'https://imported-smoke.invalid/import.pack.json';
  const finalized = await finalizePackageTransportSource(projectImportProductForBuild(product), {
    base: '/', packagePath: 'import.pack.json',
    artifactPath: (guid, key) => `artifacts/${guid}/${key}`,
  });
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime', sourcePath, sourceRevision: '1', packageUrl, pack: finalized.pack,
  });
  const bodies = new Map(finalized.artifacts.map((artifact) => [new URL(artifact.path, packageUrl).href, artifact.bytes]));
  bodies.set(packageUrl, JSON.stringify(publication.pack));
  assets.setCatalogSource(createCatalogSource({
    entries: publication.pack.assets.map(({ guid, kind, refs }) => ({
      guid, kind, refs, sourcePath, packageUrl, publication: publication.publication,
    })),
    fetch: async input => {
      const key = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = bodies.get(key);
      return new Response(body, { status: body === undefined ? 404 : 200 });
    },
  }));
}
