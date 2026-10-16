// asset-registry.pack-cache.spec — M3/Fix B in-memory pack-file cache + in-flight
// dedup (TDD red phase for AC-02 / AC-06). The test file compiles and the
// "red" stage is intentional (type=test task) because fetchPackFile currently
// has no cache.
//
// Coverage:
//   AC-02-sequential — pack.json fetched once per URL for sequential loads
//   AC-02-concurrent  — pack.json fetched once per URL for concurrent loads
//   AC-02-reject      — fetch reject clears in-flight, retry re-fetches

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  authoringCapabilityForAssetKind,
  type PackIndexEntry,
  type MeshAsset as TypesMeshAsset,
} from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ── test GUIDs ──────────────────────────────────────────────────────────────
const MESH_A_GUID = 'f0000000-0000-4000-f000-000000000001';
const MESH_B_GUID = 'f0000000-0000-4000-f000-000000000002';
const SHARED_PACK_URL = '/packs/shared-mesh.pack.json';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

// ── registry setup ──────────────────────────────────────────────────────────

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

// ── pack fixture: two meshes sharing the same .pack.json ────────────────────

function makePackIndex(): Array<{ guid: string; packageUrl: string; kind: string }> {
  return [
    { guid: MESH_A_GUID, packageUrl: SHARED_PACK_URL, kind: 'mesh' },
    { guid: MESH_B_GUID, packageUrl: SHARED_PACK_URL, kind: 'mesh' },
  ];
}

function makeSharedPack(): unknown {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: MESH_A_GUID,
        kind: 'mesh',
        payload: {
          vertices: [
            -0.5, 0, 0.5, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0.5, 0, 0.5, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5, 0,
            -0.5, 0, 1, 0, 1, 1, 1, 0, 0, 1,
          ],
          indices: [0, 1, 2],
          attributes: {},
          submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
        },
      },
      {
        guid: MESH_B_GUID,
        kind: 'mesh',
        payload: {
          vertices: [
            0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0,
            0, 0, 1, 1, 1, 0, 0,
          ],
          indices: [1, 0, 2],
          attributes: {},
          submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
        },
      },
    ],
  };
}

// ── AC-02 / AC-06: pack-file dedup ──────────────────────────────────────────

describe('pack-file cache', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('AC-02 sequential: two loadByGuid calls sharing one pack URL trigger one fetch', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const packIndex = makePackIndex();
    const sharedPack = makeSharedPack();

    let packFetchCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === SHARED_PACK_URL) {
        packFetchCount++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sharedPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const guidA = parseGuid(MESH_A_GUID);
      const guidB = parseGuid(MESH_B_GUID);

      const rA = await reg.loadByGuid<TypesMeshAsset>(guidA);
      const rB = await reg.loadByGuid<TypesMeshAsset>(guidB);

      expect(rA.ok).toBe(true);
      expect(rB.ok).toBe(true);

      // RED assertion: without cache, fetchPackFile is called twice (once per
      // loadByGuid). With cache (after M3 impl), this must be 1.
      expect(packFetchCount).toBe(1);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('resolves a relative catalog entry against an absolute pack-index URL', async () => {
    const reg = makeRegistry();
    const packIndexUrl = 'http://127.0.0.1:15173/preview/pack-index/cow-survivor.json';
    const packUrl =
      'http://127.0.0.1:15173/preview/.forgeax/games/cow-survivor/assets/shared.pack.json';
    reg.configurePackIndex(packIndexUrl);

    const packIndex = [
      {
        guid: MESH_A_GUID,
        packageUrl: '../.forgeax/games/cow-survivor/assets/shared.pack.json',
        kind: 'mesh',
      },
    ];
    const sharedPack = makeSharedPack();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === packIndexUrl)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      if (url === packUrl)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sharedPack) });
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const result = await reg.loadByGuid<TypesMeshAsset>(parseGuid(MESH_A_GUID));
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([packIndexUrl, packUrl]);
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenNthCalledWith(1, packIndexUrl, { cache: 'no-store' });
      expect(fetchMock).toHaveBeenNthCalledWith(2, packUrl);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('keeps an absolute catalog entry URL authoritative', async () => {
    const reg = makeRegistry();
    const packIndexUrl = 'http://127.0.0.1:15173/preview/pack-index/cow-survivor.json';
    const packUrl = 'https://cdn.example.test/cow/shared.pack.json';
    reg.configurePackIndex(packIndexUrl);

    const packIndex = [{ guid: MESH_A_GUID, packageUrl: packUrl, kind: 'mesh' }];
    const sharedPack = makeSharedPack();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === packIndexUrl)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      if (url === packUrl)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sharedPack) });
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const result = await reg.loadByGuid<TypesMeshAsset>(parseGuid(MESH_A_GUID));
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenNthCalledWith(1, packIndexUrl, { cache: 'no-store' });
      expect(fetchMock).toHaveBeenNthCalledWith(2, packUrl);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('AC-02 concurrent: two concurrent loadByGuid calls share one in-flight fetch', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const packIndex = makePackIndex();
    const sharedPack = makeSharedPack();

    let packFetchCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === SHARED_PACK_URL) {
        packFetchCount++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sharedPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const guidA = parseGuid(MESH_A_GUID);
      const guidB = parseGuid(MESH_B_GUID);

      const [rA, rB] = await Promise.all([
        reg.loadByGuid<TypesMeshAsset>(guidA),
        reg.loadByGuid<TypesMeshAsset>(guidB),
      ]);

      expect(rA.ok).toBe(true);
      expect(rB.ok).toBe(true);

      // RED assertion: without in-flight dedup, concurrent loads each trigger
      // a fetch. With dedup (after M3 impl), this must be 1.
      expect(packFetchCount).toBe(1);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('AC-02 reject: fetch failure clears in-flight entry, retry fetches again', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const packIndex = makePackIndex();
    const sharedPack = makeSharedPack();

    let packFetchCount = 0;
    let shouldReject = true;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === SHARED_PACK_URL) {
        packFetchCount++;
        if (shouldReject) {
          return Promise.reject(new Error('network failure'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sharedPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const guidA = parseGuid(MESH_A_GUID);

      // First attempt: reject.
      const r1 = await reg.loadByGuid<TypesMeshAsset>(guidA);
      expect(r1.ok).toBe(false);
      expect(packFetchCount).toBe(1);

      // Second attempt: should fetch again (error not cached).
      shouldReject = false;
      const r2 = await reg.loadByGuid<TypesMeshAsset>(guidA);
      expect(r2.ok).toBe(true);
      expect(packFetchCount).toBe(2);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

// ── M1 / F17b: pack-index fetch transient failure retry + no negative cache ───

describe('pack-index cache (F17b)', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('AC-01 pack-index transient failure: retry succeeds after fetch recovery [w1]', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const packIndex = makePackIndex();
    const sharedPack = makeSharedPack();

    let packIndexFetchCount = 0;
    let packIndexShouldReject = true;

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        packIndexFetchCount++;
        if (packIndexShouldReject) {
          return Promise.reject(new Error('network failure'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === SHARED_PACK_URL) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sharedPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const guidA = parseGuid(MESH_A_GUID);

      // Phase 1: pack-index fetch rejects -> loadByGuid fails.
      const r1 = await reg.loadByGuid<TypesMeshAsset>(guidA);
      expect(r1.ok).toBe(false);
      expect(packIndexFetchCount).toBe(1);

      // Phase 2: pack-index fetch recovers -> retry succeeds.
      // RED assertion: with current HEAD (line 2814 new Map() pollution),
      // packIndexCache is set to an empty Map on first failure, so
      // resolveCatalogEntry skips re-fetch and returns undefined.
      // After F17b fix, packIndexCache stays undefined -> re-fetches -> ok.
      packIndexShouldReject = false;
      const r2 = await reg.loadByGuid<TypesMeshAsset>(guidA);
      expect(r2.ok).toBe(true);
      expect(packIndexFetchCount).toBe(2);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('AC-02 no negative cache: fetch called N times for N consecutive failures [w2]', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    let packIndexFetchCount = 0;

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        packIndexFetchCount++;
        return Promise.reject(new Error('network failure'));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const guidA = parseGuid(MESH_A_GUID);

      // Three consecutive failures.
      await reg.loadByGuid<TypesMeshAsset>(guidA);
      await reg.loadByGuid<TypesMeshAsset>(guidA);
      await reg.loadByGuid<TypesMeshAsset>(guidA);

      // RED assertion: current HEAD sets packIndexCache = new Map() on first
      // failure, short-circuiting subsequent re-fetches -> fetchCount == 1.
      // After F17b fix, packIndexCache stays undefined -> each call re-fetches.
      expect(packIndexFetchCount).toBe(3);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

// -- M4 / F20: transportOrFail packIndexCache concurrent patch (AC-08) [w14] --

describe('transportOrFail packIndexCache concurrent patch (F20 / AC-08) [w14]', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('N>=2 concurrent patch via transportOrFail: packIndexCache final state contains all entries', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const GUID_1 = 'f0000000-0000-4000-f000-000000000010';
    const GUID_2 = 'f0000000-0000-4000-f000-000000000011';
    const PACK_1 = '/packs/mesh-1.pack.json';
    const PACK_2 = '/packs/mesh-2.pack.json';

    // pack-index contains NEITHER GUID -> both fall through to transportOrFail.
    const emptyPackIndex: never[] = [];

    // Wire an ImportTransport that returns entries for each GUID.
    const resolvers: Array<(value: unknown) => void> = [];
    const blockedFetches = [GUID_1, GUID_2].map(() => {
      return new Promise<unknown>((resolve) => {
        resolvers.push(resolve);
      });
    });

    let callIdx = 0;
    const importTransport = {
      fetchPack: vi.fn().mockImplementation(() => {
        const blocked = blockedFetches[callIdx++];
        if (blocked === undefined) throw new Error('unexpected fetchPack call');
        return blocked;
      }),
    } as unknown as { fetchPack: ReturnType<typeof vi.fn> };

    // Override the constructor to pass the importTransport.
    const regWithTransport = new AssetRegistry(
      makeMockShaderRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      importTransport as any,
    );
    regWithTransport.configurePackIndex('/pack-index.json');

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(emptyPackIndex) });
      }
      for (const [idx, packUrl] of [PACK_1, PACK_2].entries()) {
        if (url === packUrl) {
          const guid = idx === 0 ? GUID_1 : GUID_2;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                schemaVersion: '2.0.0',
                kind: 'internal-text-package',
                assets: [
                  {
                    guid,
                    kind: 'mesh',
                    payload: {
                      vertices: [
                        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                      ],
                      indices: [0, 1, 2],
                      attributes: {},
                      submeshes: [
                        {
                          indexOffset: 0,
                          indexCount: 3,
                          vertexCount: 3,
                          topology: 'triangle-list',
                        },
                      ],
                    },
                  },
                ],
              }),
          });
        }
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      // Start two concurrent loadByGuid calls. Both miss the catalog
      // (pack-index is empty) and reach transportOrFail. The fetchPack
      // promises are blocked, so both calls land in the race window.
      const load1 = regWithTransport.loadByGuid<TypesMeshAsset>(parseGuid(GUID_1));
      const load2 = regWithTransport.loadByGuid<TypesMeshAsset>(parseGuid(GUID_2));

      // Settle the transport fetchPack calls with entries.
      resolvers[0]?.({
        ok: true,
        entries: [{ guid: GUID_1, packageUrl: PACK_1, kind: 'mesh' }],
      });
      resolvers[1]?.({
        ok: true,
        entries: [{ guid: GUID_2, packageUrl: PACK_2, kind: 'mesh' }],
      });

      await Promise.all([load1, load2]);

      // AC-08: packIndexCache final state must contain BOTH GUID entries.
      // RED: with current HEAD (no serialisation), only the last new Map()
      // survives -- one GUID's entry is lost. After F20 fix, both survive.
      const internal = regWithTransport as unknown as {
        packIndexCache: Map<string, unknown> | undefined;
      };
      const cache = internal.packIndexCache;
      expect(cache).toBeDefined();
      expect(cache?.size).toBe(2);
      expect(cache?.get(GUID_1.toLowerCase())).toBeDefined();
      expect(cache?.get(GUID_2.toLowerCase())).toBeDefined();
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

// -- transportOrFail patch preserves the transport's derived display name --
// Regression: the incremental patch loop copied packageUrl/kind/metadata but
// dropped `name`, so a GLB imported at runtime (studio Content Browser) showed
// its 1000+ sub-assets as blank rows. buildCatalog already derives the name
// (basename of the source), the transport carries it, and listCatalog reads it
// back via `entry.name` -- so the patch must persist it.

describe('transportOrFail packIndexCache patch preserves entry.name', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('carries the transport entry name into the cache row and listCatalog', async () => {
    const GUID = 'f0000000-0000-4000-f000-000000000020';
    const PACK = '/packs/city.glb';
    const NAME = 'city_Sample_512.glb';

    const importTransport = {
      fetchPack: vi.fn().mockResolvedValue({
        ok: true,
        entries: [{ guid: GUID, packageUrl: PACK, kind: 'scene', name: NAME }],
      }),
    } as unknown as { fetchPack: ReturnType<typeof vi.fn> };

    const reg = new AssetRegistry(
      makeMockShaderRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      importTransport as any,
    );
    reg.configurePackIndex('/pack-index.json');

    // pack-index is empty -> the GUID falls through to transportOrFail. The pack
    // body fetch fails (404) after the patch lands, so loadByGuid rejects -- but
    // the packIndexCache patch (the unit under test) has already run by then.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      await reg.loadByGuid(parseGuid(GUID)).catch(() => undefined);

      const internal = reg as unknown as {
        packIndexCache: Map<string, { name?: string }> | undefined;
      };
      expect(internal.packIndexCache?.get(GUID.toLowerCase())?.name).toBe(NAME);

      const row = reg.listCatalog().find((e) => e.guid === GUID.toLowerCase());
      expect(row?.name).toBe(NAME);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

// -- M4 / F20: integration - two-GUID concurrent transportOrFail (AC-07) [w18] --

describe('integration: concurrent transportOrFail dual GUID (F20 / AC-07) [w18]', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('two concurrent loadByGuid through transportOrFail: both catalogued + packIndexCache has both', async () => {
    const GUID_1 = 'f0000000-0000-4000-f000-000000000020';
    const GUID_2 = 'f0000000-0000-4000-f000-000000000021';
    const PACK_1 = '/packs/integ-mesh-1.pack.json';
    const PACK_2 = '/packs/integ-mesh-2.pack.json';

    // pack-index is empty -- both GUIDs fall through to transportOrFail.
    const emptyPackIndex: never[] = [];

    // Block the transport fetchPack calls to create concurrency.
    const resolvers: Array<(value: unknown) => void> = [];
    const blockedFetches = [GUID_1, GUID_2].map(() => {
      return new Promise<unknown>((resolve) => {
        resolvers.push(resolve);
      });
    });

    let transportCallIdx = 0;
    const importTransport = {
      fetchPack: vi.fn().mockImplementation(() => {
        const blocked = blockedFetches[transportCallIdx++];
        if (blocked === undefined) throw new Error('unexpected fetchPack call');
        return blocked;
      }),
    };

    const reg = new AssetRegistry(
      makeMockShaderRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      importTransport as any,
    );
    reg.configurePackIndex('/pack-index.json');

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(emptyPackIndex) });
      }
      for (const [idx, packUrl] of [PACK_1, PACK_2].entries()) {
        if (url === packUrl) {
          const guid = idx === 0 ? GUID_1 : GUID_2;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                schemaVersion: '2.0.0',
                kind: 'internal-text-package',
                assets: [
                  {
                    guid,
                    kind: 'mesh',
                    payload: {
                      vertices: [
                        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                      ],
                      indices: [0, 1, 2],
                      attributes: {},
                      submeshes: [
                        {
                          indexOffset: 0,
                          indexCount: 3,
                          vertexCount: 3,
                          topology: 'triangle-list',
                        },
                      ],
                    },
                  },
                ],
              }),
          });
        }
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const load1 = reg.loadByGuid<TypesMeshAsset>(parseGuid(GUID_1));
      const load2 = reg.loadByGuid<TypesMeshAsset>(parseGuid(GUID_2));

      // Both are blocked at fetchPack. Release both transports.
      resolvers[0]?.({
        ok: true,
        entries: [{ guid: GUID_1, packageUrl: PACK_1, kind: 'mesh' }],
      });
      resolvers[1]?.({
        ok: true,
        entries: [{ guid: GUID_2, packageUrl: PACK_2, kind: 'mesh' }],
      });

      const [r1, r2] = await Promise.all([load1, load2]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      // AC-07: packIndexCache must contain BOTH entries.
      const internal = reg as unknown as {
        packIndexCache: Map<string, unknown> | undefined;
      };
      const cache = internal.packIndexCache;
      expect(cache?.size).toBe(2);
      expect(cache?.get(GUID_1.toLowerCase())).toBeDefined();
      expect(cache?.get(GUID_2.toLowerCase())).toBeDefined();

      // Both assets must be in the catalog.
      expect(reg.lookup(GUID_1)).toBeDefined();
      expect(reg.lookup(GUID_2)).toBeDefined();
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

// ── refreshCatalog: re-fetch pack-index NOW so listCatalog reflects new assets ──
// Regression: after an import writes a new pack-index on disk, the registry kept
// its boot-time cache; listCatalog stayed stale until a page reload. refreshCatalog
// re-fetches immediately so the Content Browser + Add-to-Scene see the new asset.

describe('refreshCatalog re-fetches the pack-index immediately', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
    // biome-ignore lint/suspicious/noExplicitAny: test teardown
    else delete (globalThis as any).fetch;
  });

  it('surfaces a newly-added entry in listCatalog without any loadByGuid', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const NEW_GUID = 'f0000000-0000-4000-f000-0000000000a1';
    // First served index is empty; the second (post-"import") carries one row.
    let served: Array<{ guid: string; packageUrl: string; kind: string; name?: string }> = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(served) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    try {
      // Prime the cache with the empty index — the new GUID is absent.
      const first = await reg.refreshCatalog();
      expect(first).toBe(true);
      expect(reg.listCatalog().find((e) => e.guid === NEW_GUID.toLowerCase())).toBeUndefined();

      // Simulate an import writing a fresh pack-index, then refresh.
      served = [
        {
          guid: NEW_GUID,
          packageUrl: '/preview/new.pack.json',
          kind: 'scene',
          name: 'new.pack.json',
        },
      ];
      const second = await reg.refreshCatalog();
      expect(second).toBe(true);

      const row = reg.listCatalog().find((e) => e.guid === NEW_GUID.toLowerCase());
      expect(row).toBeDefined();
      expect(row?.kind).toBe('scene');
      expect(row?.name).toBe('new.pack.json');
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('returns false (keeps stale cache) when no pack-index URL is configured', async () => {
    const reg = makeRegistry();
    expect(await reg.refreshCatalog()).toBe(false);
  });
});

// -- M5 / w36: real import patch preserves the complete producer row ---------

const M5_PACK_INDEX_URL = 'https://assets.example.test/game/pack-index.json';
const M5_GUID_A = 'f0000000-0000-4000-f000-0000000000a2';
const M5_GUID_B = 'f0000000-0000-4000-f000-0000000000a3';

function makeRichImportedEntry(
  guid: string,
  packageUrl: string,
  sourceIndex: number,
): PackIndexEntry {
  const provenance = {
    provider: 'fixture-importer',
    version: '2.4.0',
    source: 'fixture-source',
  };
  return {
    guid,
    packageUrl,
    kind: 'mesh',
    authoring: authoringCapabilityForAssetKind('mesh'),
    sourcePath: `models/${guid}.source`,
    packageId: 'fixture-package',
    provenance,
    revision: {
      digest: 'sha256:fixture-revision',
      observedAt: 17,
      rootId: 'fixture-root',
    },
    sourceKey: `mesh/${guid}/main`,
    sourceIndex,
    relations: [
      {
        from: { type: 'asset', id: guid },
        to: { type: 'resource', id: 'fixture-source' },
        type: 'produces',
        provenance,
      },
    ],
    diagnostics: [
      {
        code: 'fixture-import-warning',
        severity: 'warning',
        expected: 'stable producer identity',
        actual: 'imported during test',
        hint: 'retain the producer row while resolving the locator',
        authority: 'producer',
      },
    ],
  };
}

function makeImportedMeshPack(guid: string): unknown {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid,
        kind: 'mesh',
        payload: {
          vertices: [
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0,
          ],
          indices: [0, 1, 2],
          attributes: {},
          submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
        },
        refs: [],
        artifacts: {},
      },
    ],
  };
}

describe('M5 real import patch preserves CatalogRecord facts', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('keeps producer identity while resolving the imported locator', async () => {
    const packageUrl = './packs/imported-a.pack.json';
    const resolvedUrl = 'https://assets.example.test/game/packs/imported-a.pack.json';
    const entry = makeRichImportedEntry(M5_GUID_A, packageUrl, 4);
    const importTransport = {
      fetchPack: vi.fn().mockResolvedValue({ ok: true, entries: [entry] }),
    };
    const reg = new AssetRegistry(
      makeMockShaderRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: focused transport fixture
      importTransport as any,
    );
    reg.configurePackIndex(M5_PACK_INDEX_URL);
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === M5_PACK_INDEX_URL) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url === resolvedUrl) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeImportedMeshPack(M5_GUID_A)),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    const result = await reg.loadByGuid<TypesMeshAsset>(parseGuid(M5_GUID_A));
    expect(result.ok).toBe(true);
    expect(importTransport.fetchPack).toHaveBeenCalledWith(M5_GUID_A, undefined);
    expect(reg.listCatalog()).toContainEqual({
      ...entry,
      packageUrl: resolvedUrl,
    });
  });

  it('keeps complete rows for concurrent import patches', async () => {
    const entries = [
      makeRichImportedEntry(M5_GUID_A, './packs/imported-a.pack.json', 4),
      makeRichImportedEntry(M5_GUID_B, './packs/imported-b.pack.json', 5),
    ];
    const resolvers: Array<(value: unknown) => void> = [];
    const importTransport = {
      fetchPack: vi.fn().mockImplementation(() => {
        return new Promise((resolve) => resolvers.push(resolve));
      }),
    };
    const reg = new AssetRegistry(
      makeMockShaderRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: focused transport fixture
      importTransport as any,
    );
    reg.configurePackIndex(M5_PACK_INDEX_URL);
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === M5_PACK_INDEX_URL) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      const entry = entries.find(
        (candidate) => url === new URL(candidate.packageUrl, M5_PACK_INDEX_URL).href,
      );
      if (entry !== undefined) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeImportedMeshPack(entry.guid)),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    const loads = [
      reg.loadByGuid<TypesMeshAsset>(parseGuid(M5_GUID_A)),
      reg.loadByGuid<TypesMeshAsset>(parseGuid(M5_GUID_B)),
    ];
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.({ ok: true, entries: [entries[1]] });
    resolvers[0]?.({ ok: true, entries: [entries[0]] });
    const results = await Promise.all(loads);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(reg.listCatalog()).toEqual(
      expect.arrayContaining(
        entries.map((entry) => ({
          ...entry,
          packageUrl: new URL(entry.packageUrl, M5_PACK_INDEX_URL).href,
        })),
      ),
    );
  });
});
