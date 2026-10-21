import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { samplerContribution } from '@forgeax/engine-render';
import { expect, it, vi } from 'vitest';

const GUID = 'f0000000-0000-4000-f000-000000000001';
const CATALOG_URL = 'https://preview.invalid/preview/catalog/game.json';

it.each([
  ['../packages/sampler.pack.json', 'https://preview.invalid/preview/packages/sampler.pack.json'],
  ['https://cdn.invalid/sampler.pack.json', 'https://cdn.invalid/sampler.pack.json'],
])('loads the authoritative package locator %s', async (locator, packageUrl) => {
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'sampler.pack',
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: [
        {
          guid: GUID,
          kind: 'sampler',
          refs: [],
          artifacts: {},
          payload: { kind: 'sampler', magFilter: 'linear' },
        },
      ],
    },
  });
  const rows = [
    {
      guid: GUID,
      kind: 'sampler',
      packageUrl: locator,
      sourcePath: 'sampler.pack',
      publication: produced.publication,
    },
  ];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === CATALOG_URL) return Response.json(rows);
    if (url === packageUrl) return Response.json(produced.pack);
    throw new Error(`unexpected asset request: ${url}`);
  });
  const assets = new AssetRegistry({ catalog: createCatalogSource({ url: CATALOG_URL, fetch }) });
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  try {
    const handle = (await assets.load(GUID, 'sampler')).unwrap();
    expect(assets.read(handle).unwrap()).toEqual({ kind: 'sampler', magFilter: 'linear' });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([CATALOG_URL, packageUrl]);
    expect((await assets.enumerateCatalog()).unwrap()[0]?.packageUrl).toBe(packageUrl);
  } finally {
    assets.dispose();
  }
});
