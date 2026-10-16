// The producer declares an uncooked imported output with a cooked package
// locator and a raw sourcePath. Its missing projection routes to ImportTransport
// before either body is fetched. Raw source packageUrl rows are malformed and
// must retain their Catalog error instead of becoming an import fallback.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  type CatalogEntry,
  type CatalogProjectionInput,
  catalogOperationsFor,
  type ImportTransport,
} from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const MAT_GUID = 'a0000000-0000-4000-a000-00006d6174a1';
const RAW_GLB_URL = '/preview/assets/city_like.glb';
const IMPORTED_PACK_URL = '/__forgeax-ddc/a0000000-0000-4000-a000-00006d6174a1.pack.json';
const PACK_INDEX_URL = '/pack-index.json';

const missingProjection = {
  subject: 'imported-output',
  execution: 'cooked',
  lifecycle: 'missing',
} satisfies CatalogProjectionInput;
const declaredMaterial: CatalogEntry = {
  guid: MAT_GUID,
  kind: 'material',
  sourcePath: RAW_GLB_URL,
  packageUrl: IMPORTED_PACK_URL,
  ...missingProjection,
  projection: {
    ...missingProjection,
    operations: catalogOperationsFor(missingProjection),
  },
};

function parseGuid(g: string): AssetGuid {
  const parsed = AssetGuid.parse(g);
  if (!parsed.ok) throw new Error(`bad guid ${g}`);
  return parsed.value;
}

// A material entry served from the imported `.pack.json` (the post-transport
// artifact). Minimal valid unlit material.
function importedMaterialPack() {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: MAT_GUID,
        kind: 'material',
        payload: {
          passes: [
            {
              name: 'forward',
              values: {},
              program: { module: 'test::dummy' },
              renderState: { tags: { LightMode: 'Forward' } },
            },
          ],
        },
        refs: [],
        artifacts: {},
      },
    ],
  };
}

describe('raw-container fail-fast (perf-20260706)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('loads a local Pack v2 package without a raw source or suffix arm', async () => {
    const packIndex = [
      { guid: MAT_GUID, packageUrl: '/assets/material.pack.json', kind: 'material' },
    ];
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: MAT_GUID,
          kind: 'material',
          payload: {
            passes: [
              {
                name: 'forward',
                values: {},
                program: { module: 'test::dummy' },
                renderState: { tags: { LightMode: 'Forward' } },
              },
            ],
          },
          refs: [],
          artifacts: {},
        },
      ],
    };
    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      if (url === '/assets/material.pack.json')
        return Promise.resolve({ ok: true, json: () => Promise.resolve(pack) });
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);
    const result = await reg.loadByGuid(parseGuid(MAT_GUID));

    expect(result.ok).toBe(true);
  });

  it('rejects a legacy top-level payload even when the catalog uses packageUrl', async () => {
    const packIndex = [
      { guid: MAT_GUID, packageUrl: '/assets/legacy.pack.json', kind: 'material' },
    ];
    const legacyPack = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [{ guid: MAT_GUID, kind: 'material', payload: { passes: [] }, refs: [] }],
    };
    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      if (url === '/assets/legacy.pack.json')
        return Promise.resolve({ ok: true, json: () => Promise.resolve(legacyPack) });
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);
    const result = await reg.loadByGuid(parseGuid(MAT_GUID));
    expect(result.ok).toBe(false);
  });

  it('never fetches the raw .glb; routes through transport; loads from imported .pack.json', async () => {
    const packIndex = [declaredMaterial];

    let rawGlbFetches = 0;
    let importedPackFetches = 0;

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === RAW_GLB_URL) {
        // Binary GLB: res.json() would THROW (mirrors the real 62 MB container).
        rawGlbFetches++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error('binary glTF is not JSON')),
        });
      }
      if (url === IMPORTED_PACK_URL) {
        importedPackFetches++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(importedMaterialPack()) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    // Transport publishes the previously missing output at its cooked locator.
    const transport: ImportTransport = {
      fetchPack: vi.fn().mockResolvedValue({
        ok: true,
        entries: [{ guid: MAT_GUID, packageUrl: IMPORTED_PACK_URL, kind: 'material' }],
      }),
    };

    const reg = new AssetRegistry(makeMockShaderRegistry(), transport);
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(MAT_GUID));

    // (3) load succeeds via the imported artifact.
    expect(result.ok).toBe(true);
    // (1) the raw .glb was NEVER fetched (fail-fast before the fetch).
    expect(rawGlbFetches).toBe(0);
    // (2) the transport ran, and (3) the imported pack was fetched once.
    expect(transport.fetchPack).toHaveBeenCalledTimes(1);
    expect(importedPackFetches).toBe(1);
  });

  it('shipped form (no transport): missing cooked output fails fast with asset-not-imported, no .glb fetch', async () => {
    const packIndex = [declaredMaterial];
    let rawGlbFetches = 0;
    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === RAW_GLB_URL) {
        rawGlbFetches++;
        return Promise.resolve({ ok: true, json: () => Promise.reject(new Error('binary')) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry()); // no transport
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(MAT_GUID));
    expect(result.ok).toBe(false);
    // The producer-declared missing projection requires import; without a
    // transport it remains asset-not-imported and never reads raw source bytes.
    if (!result.ok) expect(result.error.code).toBe('asset-not-imported');
    expect(rawGlbFetches).toBe(0);
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input))).toEqual([
      PACK_INDEX_URL,
    ]);
  });

  it('rejects a raw source package locator without fetching or importing it', async () => {
    const packIndex = [{ ...declaredMaterial, packageUrl: RAW_GLB_URL }];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === PACK_INDEX_URL) {
        return new Response(JSON.stringify(packIndex));
      }
      throw new Error(`malformed locator must not be read: ${String(input)}`);
    });
    globalThis.fetch = fetch;
    const transport: ImportTransport = {
      fetchPack: vi.fn().mockResolvedValue({ ok: true, entries: [] }),
    };
    const reg = new AssetRegistry(makeMockShaderRegistry(), transport);
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(MAT_GUID));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('asset-parse-failed');
      expect(result.error.expected).toContain('cooked package');
    }
    expect(transport.fetchPack).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([PACK_INDEX_URL]);
  });
});
