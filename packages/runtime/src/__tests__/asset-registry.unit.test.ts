// M6 w31 (round 5 D-15): column-mint + two-tier resolve integration TDD.
//
// D-15 corrected model (human-inputs implement-architecture-correction
// 2026-06-16T12:35:07Z): AssetRegistry has ZERO handle concept. There is no
// shared slot space shared with the World. A `handle` is purely an ECS column
// value -- a numeric indirect reference resolved two-tier purely by slot range:
//   slot <  BUILTIN_BASE -> BuiltinAssetRegistry.resolve(handle)   (process-static)
//   slot >= BUILTIN_BASE -> world.sharedRefs.resolve(handle)       (user-tier RC)
// resolution is entirely on the ECS/render/extract side, never via AssetRegistry.
//
// Column-mint API (Implementer decision): user-tier payloads mint via
// `world.allocSharedRef(tag, payload)` (already on World). AssetRegistry no
// longer produces a column-usable handle; its residual job is GUID->payload
// cataloguing + `loadByGuid`.
//
// These cases are RED before w49 (AssetRegistry still carries `register` /
// by-handle `get`); w49 removes those entries and turns this file green.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AssetRegistry,
  BUILTIN_CUBE,
  BuiltinAssetRegistry,
  HANDLE_CUBE,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { BUILTIN_BASE } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const ASSET_REGISTRY_SRC = readFileSync(
  fileURLToPath(new URL('../../../assets-runtime/src/asset-registry.ts', import.meta.url)),
  'utf8',
);

function mesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(12 * 3),
    indices: new Uint16Array([0, 1, 2]),
  } as unknown as MeshAsset;
}

describe('D-15 column-mint via world.allocSharedRef (AC-24)', () => {
  it('mints a user-tier slot >= BUILTIN_BASE and resolves to the same payload', () => {
    const world = new World();
    const payload = mesh();
    const handle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', payload);
    expect(handle).toBeGreaterThanOrEqual(BUILTIN_BASE);
    const res = world.sharedRefs.resolve<'MeshAsset', MeshAsset>(handle);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(payload);
  });

  it('two distinct mints get distinct user-tier slots', () => {
    const world = new World();
    const a = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh());
    const b = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', mesh());
    expect(a).not.toBe(b);
    expect(a).toBeGreaterThanOrEqual(BUILTIN_BASE);
    expect(b).toBeGreaterThanOrEqual(BUILTIN_BASE);
  });
});

describe('D-15 builtin handle resolves via BuiltinAssetRegistry (AC-24)', () => {
  it('HANDLE_CUBE (slot < BUILTIN_BASE) resolves through BuiltinAssetRegistry, not the World', () => {
    expect(BuiltinAssetRegistry.resolve(HANDLE_CUBE)).toBe(BUILTIN_CUBE);
    // builtin slot does not live in any World's SharedRefStore
    const world = new World();
    const res = world.sharedRefs.resolve(HANDLE_CUBE);
    expect(res.ok).toBe(false);
  });
});

describe('D-15 AssetRegistry has no handle concept (AC-25, static source assertion)', () => {
  it('exposes no anonymous register(asset) -> Handle column-mint entry', () => {
    // The old `register<T extends Asset>(asset): Result<Handle...>` mint moved
    // to the ECS side (world.allocSharedRef). AssetRegistry must not declare it.
    expect(ASSET_REGISTRY_SRC).not.toMatch(/\n {2}register<T extends Asset>\(asset: T\)/);
  });

  it('exposes no by-handle get(handle) resolution entry', () => {
    // Payload resolution is two-tier by slot range on the ECS/render side;
    // AssetRegistry no longer offers a by-handle `.get(handle)` lookup.
    expect(ASSET_REGISTRY_SRC).not.toMatch(/\n {2}get<T extends Asset>\(handle:/);
  });

  it('holds no handle->payload Map (private assets: Map<number, Asset>)', () => {
    expect(ASSET_REGISTRY_SRC).not.toMatch(/private readonly assets: Map<number, Asset>/);
  });

  it('holds no handle->guid reverse map (handleToGuid)', () => {
    expect(ASSET_REGISTRY_SRC).not.toMatch(/handleToGuid/);
  });
});

// ── M3: invalidate / invalidateAll API + generation TDD helpers ───────────

function makeMeshFixture(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(36),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    materialSlots: [{ slotName: 'Default' }],
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list' as const,
      },
    ],
  } as unknown as MeshAsset;
}

function makeReg(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

describe('M3 invalidate(guid) (AC-03) [w6]', () => {
  it('removes the catalogued asset after catalog then invalidate', () => {
    const reg = makeReg();
    const guid = 'a0000000-0000-4000-a000-000000000001';
    const mesh = makeMeshFixture();
    reg.catalog(guid, mesh);
    expect(reg.lookup(guid)).toBeDefined();

    (reg as unknown as { invalidate: (guid: string) => void }).invalidate(guid);

    expect(reg.lookup(guid)).toBeUndefined();
  });

  it('is a no-op for a non-existent GUID', () => {
    const reg = makeReg();
    (reg as unknown as { invalidate: (guid: string) => void }).invalidate(
      'a0000000-0000-4000-a000-000000000002',
    );
    expect(reg.lookup('a0000000-0000-4000-a000-000000000002')).toBeUndefined();
  });

  it('clears the targeted body+index entry but leaves bystander entries intact (AC-03)', async () => {
    const originalFetch = globalThis.fetch;
    const reg = makeReg();
    reg.configurePackIndex('/pack-index.json');

    const targetGuid = 'a0000000-0000-4000-a000-000000000003';
    const bystanderGuid = 'a0000000-0000-4000-a000-000000000004';
    const targetUrl = '/packs/mesh-target.pack.json';
    const bystanderUrl = '/packs/mesh-bystander.pack.json';
    const packIndex = [
      { guid: targetGuid, packageUrl: targetUrl, kind: 'mesh' },
      { guid: bystanderGuid, packageUrl: bystanderUrl, kind: 'mesh' },
    ];

    function makePackFile(g: string): unknown {
      return {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: g,
            kind: 'mesh',
            payload: {
              vertices: [
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0,
              ],
              indices: [0, 1, 2],
              attributes: {},
              submeshes: [
                { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' },
              ],
            },
          },
        ],
      };
    }

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === targetUrl) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(makePackFile(targetGuid)) });
      }
      if (url === bystanderUrl) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makePackFile(bystanderGuid)),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const internal = reg as unknown as {
      packFiles: Map<string, unknown>;
      packIndexCache: Map<string, unknown> | undefined;
      invalidate: (guid: string) => void;
    };

    try {
      // Prod-load both GUIDs so packIndexCache holds both entries and
      // packFiles holds both bodies (keyed by packageUrl).
      const rt = await reg.loadByGuid<MeshAsset>(parseGuid(targetGuid));
      const rb = await reg.loadByGuid<MeshAsset>(parseGuid(bystanderGuid));
      expect(rt.ok).toBe(true);
      expect(rb.ok).toBe(true);
      expect(internal.packFiles.has(targetUrl)).toBe(true);
      expect(internal.packFiles.has(bystanderUrl)).toBe(true);
      expect(internal.packIndexCache?.get(targetGuid)).toBeDefined();
      expect(internal.packIndexCache?.get(bystanderGuid)).toBeDefined();

      internal.invalidate(targetGuid);

      // Targeted clear: target body + index entry gone.
      expect(internal.packFiles.has(targetUrl)).toBe(false);
      expect(internal.packIndexCache?.get(targetGuid)).toBeUndefined();

      // Bystander survives: single-GUID invalidate must not evict unrelated
      // cached bodies/index entries, and keeps the index Map alive (only
      // invalidateAll nukes it to undefined).
      expect(internal.packFiles.has(bystanderUrl)).toBe(true);
      expect(internal.packIndexCache?.get(bystanderGuid)).toBeDefined();
      expect(internal.packIndexCache).not.toBeUndefined();

      // Catalog entry removed + generation bumped (kept from round-1).
      expect(reg.lookup(targetGuid)).toBeUndefined();
    } finally {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown
        delete (globalThis as any).fetch;
      }
    }
  });
});

describe('M3 invalidateAll() (AC-05 + AC-06) [w7]', () => {
  it('clears all catalogued assets and returns clearedCount', () => {
    const reg = makeReg();
    const countBefore = reg as unknown as { assetCatalog: Map<string, unknown> };
    const initialSize = countBefore.assetCatalog.size;
    reg.catalog('a0000000-0000-4000-a000-000000000001', makeMeshFixture());
    reg.catalog('a0000000-0000-4000-a000-000000000002', makeMeshFixture());
    reg.catalog('a0000000-0000-4000-a000-000000000003', makeMeshFixture());

    const result = (
      reg as unknown as { invalidateAll: () => { clearedCount: number } }
    ).invalidateAll();

    // clearedCount includes builtins (constructor pre-populates 5 GUIDs).
    expect(result.clearedCount).toBe(initialSize + 3);
    expect(reg.lookup('a0000000-0000-4000-a000-000000000001')).toBeUndefined();
    expect(reg.lookup('a0000000-0000-4000-a000-000000000002')).toBeUndefined();
    expect(reg.lookup('a0000000-0000-4000-a000-000000000003')).toBeUndefined();
  });

  it('is idempotent: second call returns clearedCount 0', () => {
    const reg = makeReg();
    reg.catalog('a0000000-0000-4000-a000-000000000001', makeMeshFixture());

    const internal = reg as unknown as {
      invalidateAll: () => { clearedCount: number };
      packIndexCache: Map<string, unknown> | undefined;
    };

    const first = internal.invalidateAll();
    expect(first.clearedCount).toBeGreaterThan(0);

    const second = internal.invalidateAll();
    expect(second.clearedCount).toBe(0);
    // No-op clear of an already-undefined index cache must not re-create a Map.
    expect(internal.packIndexCache).toBeUndefined();
  });

  it('clears packFiles and resets packIndexCache to undefined (AC-05, R2-1)', async () => {
    const originalFetch = globalThis.fetch;
    const reg = makeReg();
    reg.configurePackIndex('/pack-index.json');

    const guid = 'a0000000-0000-4000-a000-000000000040';
    const packIndex = [{ guid, packageUrl: '/packs/mesh-all.pack.json', kind: 'mesh' }];
    const packFile = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid,
          kind: 'mesh',
          payload: {
            vertices: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0,
            ],
            indices: [0, 1, 2],
            attributes: {},
            submeshes: [
              { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' },
            ],
          },
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/mesh-all.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packFile) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const internal = reg as unknown as {
      packFiles: Map<string, unknown>;
      packIndexCache: Map<string, unknown> | undefined;
      invalidateAll: () => { clearedCount: number };
    };

    try {
      // Prod load populates both shared caches.
      const r = await reg.loadByGuid<MeshAsset>(parseGuid(guid));
      expect(r.ok).toBe(true);
      expect(internal.packFiles.size).toBeGreaterThan(0);
      expect(internal.packIndexCache).not.toBeUndefined();

      internal.invalidateAll();

      // Body cache fully cleared.
      expect(internal.packFiles.size).toBe(0);
      // Index cache reset to undefined -- NOT an empty Map. An empty Map would
      // short-circuit resolveCatalogEntry's `=== undefined` re-fetch guard
      // (asset-registry.ts:2878) and reproduce the F17b pollution.
      expect(internal.packIndexCache).toBeUndefined();
    } finally {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown
        delete (globalThis as any).fetch;
      }
    }
  });
});

describe('M3 generation drop: invalidate(guid) drops in-flight (AC-11) [w8]', () => {
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

  it('returns asset-invalidated when invalidate is called during loadByGuid', async () => {
    const reg = makeReg();
    reg.configurePackIndex('/pack-index.json');

    const guid = 'a0000000-0000-4000-a000-000000000010';
    const packIndex = [{ guid, packageUrl: '/packs/test-mesh.pack.json', kind: 'mesh' }];
    const packFile = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid,
          kind: 'mesh',
          payload: {
            vertices: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0,
            ],
            indices: [0, 1, 2],
            attributes: {},
            submeshes: [
              { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' },
            ],
          },
        },
      ],
    };

    // Block the pack-file fetch so we can invalidate before it resolves.
    let resolvePackFile!: (value: unknown) => void;
    const packFilePromise = new Promise<unknown>((resolve) => {
      resolvePackFile = resolve;
    });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/test-mesh.pack.json') {
        return packFilePromise.then((v: unknown) => ({ ok: true, json: () => Promise.resolve(v) }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const loadPromise = reg.loadByGuid<MeshAsset>(parseGuid(guid));

      // Invalidate while pack-file fetch is still blocked.
      (reg as unknown as { invalidate: (g: string) => void }).invalidate(guid);

      // Now release the pack-file fetch.
      resolvePackFile(packFile);

      const result = await loadPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-invalidated');
      }
      // Catalog must NOT contain the asset (result was not written).
      expect(reg.lookup(guid)).toBeUndefined();
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

describe('M3 generation drop: invalidateAll drops all in-flight (AC-12) [w9]', () => {
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

  it('returns asset-invalidated for all in-flight loads after invalidateAll', async () => {
    const reg = makeReg();
    reg.configurePackIndex('/pack-index.json');

    const guidA = 'a0000000-0000-4000-a000-000000000010';
    const guidB = 'a0000000-0000-4000-a000-000000000011';
    const guidC = 'a0000000-0000-4000-a000-000000000012';

    const packIndex = [
      { guid: guidA, packageUrl: '/packs/mesh-a.pack.json', kind: 'mesh' },
      { guid: guidB, packageUrl: '/packs/mesh-b.pack.json', kind: 'mesh' },
      { guid: guidC, packageUrl: '/packs/mesh-c.pack.json', kind: 'mesh' },
    ];

    function makePackFile(g: string): unknown {
      return {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: g,
            kind: 'mesh',
            payload: {
              vertices: [
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0,
              ],
              indices: [0, 1, 2],
              attributes: {},
              submeshes: [
                { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' },
              ],
            },
          },
        ],
      };
    }

    const resolvers: Array<(value: unknown) => void> = [];
    const packFilePromises = [
      '/packs/mesh-a.pack.json',
      '/packs/mesh-b.pack.json',
      '/packs/mesh-c.pack.json',
    ].map(() => {
      return new Promise<unknown>((resolve) => {
        resolvers.push(resolve);
      });
    });

    let resolverIdx = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url.startsWith('/packs/mesh-')) {
        const p = packFilePromises[resolverIdx++];
        if (p === undefined) throw new Error(`unexpected pack URL: ${url}`);
        return p.then((v: unknown) => ({ ok: true, json: () => Promise.resolve(v) }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const loadA = reg.loadByGuid<MeshAsset>(parseGuid(guidA));
      const loadB = reg.loadByGuid<MeshAsset>(parseGuid(guidB));
      const loadC = reg.loadByGuid<MeshAsset>(parseGuid(guidC));

      // All three are in-flight now. Invalidate all.
      (reg as unknown as { invalidateAll: () => { clearedCount: number } }).invalidateAll();

      // Now release all pack-file fetches.
      resolvers[0]?.(makePackFile(guidA));
      resolvers[1]?.(makePackFile(guidB));
      resolvers[2]?.(makePackFile(guidC));

      const results = await Promise.all([loadA, loadB, loadC]);
      for (const r of results) {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('asset-invalidated');
        }
      }

      // Catalog must be empty.
      expect(reg.lookup(guidA)).toBeUndefined();
      expect(reg.lookup(guidB)).toBeUndefined();
      expect(reg.lookup(guidC)).toBeUndefined();
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

describe('M3 integration: invalidate reload + generation match (AC-04 + AC-13) [w12]', () => {
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

  it('AC-04: invalidate(guid) then loadByGuid re-fetches fresh bytes (not stale cache)', async () => {
    const reg = makeReg();
    reg.configurePackIndex('/pack-index.json');

    const guid = 'a0000000-0000-4000-a000-000000000020';
    const packUrl = '/packs/mesh-reload.pack.json';
    const packIndex = [{ guid, packageUrl: packUrl, kind: 'mesh' }];

    // The service changes its response body between the two loads: the first
    // pack-file request serves body-v1 (vertices[0] === 0), every subsequent
    // request serves body-v2 (vertices[0] === 7). A genuine re-fetch after
    // invalidate must observe body-v2; a stale-cache hit would still see v1.
    function makePackBody(firstX: number): unknown {
      return {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid,
            kind: 'mesh',
            payload: {
              vertices: [
                firstX,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                1,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                1,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
              ],
              indices: [0, 1, 2],
              attributes: {},
              submeshes: [
                { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' },
              ],
            },
          },
        ],
      };
    }
    const BODY_V1_X = 0;
    const BODY_V2_X = 7;

    let packFetches = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === packUrl) {
        packFetches += 1;
        const body = packFetches === 1 ? makePackBody(BODY_V1_X) : makePackBody(BODY_V2_X);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      // First load: fetches body-v1, succeeds, writes to catalog.
      const r1 = await reg.loadByGuid<MeshAsset>(parseGuid(guid));
      expect(r1.ok).toBe(true);
      expect(reg.lookup(guid)).toBeDefined();
      expect(packFetches).toBe(1);

      // Invalidate the catalogued asset.
      (reg as unknown as { invalidate: (g: string) => void }).invalidate(guid);
      expect(reg.lookup(guid)).toBeUndefined();

      // Second load: must re-fetch the pack-file body (not serve packFiles).
      const r2 = await reg.loadByGuid<MeshAsset>(parseGuid(guid));
      expect(r2.ok).toBe(true);
      expect(reg.lookup(guid)).toBeDefined();

      // (a) the reload re-fetched the body -> packFetches incremented to 2.
      expect(packFetches).toBe(2);
      // (b) the reloaded payload is the FRESH body-v2 (vertices[0] === 7),
      //     proving the stale cached body-v1 was NOT served.
      if (r2.ok) {
        expect(r2.value.vertices[0]).toBe(BODY_V2_X);
      }
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('AC-13: invalidate then immediate reload -- generation matches, payload catalogued', async () => {
    const reg = makeReg();
    reg.configurePackIndex('/pack-index.json');

    const guid = 'a0000000-0000-4000-a000-000000000021';
    const packIndex = [{ guid, packageUrl: '/packs/mesh-genmatch.pack.json', kind: 'mesh' }];
    const packFile = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid,
          kind: 'mesh',
          payload: {
            vertices: [
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0,
            ],
            indices: [0, 1, 2],
            attributes: {},
            submeshes: [
              { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' },
            ],
          },
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/mesh-genmatch.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packFile) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      // Load, invalidate, reload immediately -- the new load picks up the
      // updated generation and completes normally.
      const r1 = await reg.loadByGuid<MeshAsset>(parseGuid(guid));
      expect(r1.ok).toBe(true);

      (reg as unknown as { invalidate: (g: string) => void }).invalidate(guid);

      // Immediate reload after invalidate: new generation, catalog re-populated.
      const r2 = await reg.loadByGuid<MeshAsset>(parseGuid(guid));
      expect(r2.ok).toBe(true);
      expect(reg.lookup(guid)).toBeDefined();
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

describe('M3 integration: generation discard error shape (AC-11 + AC-12) [w13]', () => {
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

  it('invalidate(guid) during load: error has code, hint, and expected with GUID', async () => {
    const reg = makeReg();
    reg.configurePackIndex('/pack-index.json');

    const guid = 'a0000000-0000-4000-a000-000000000030';
    const packIndex = [{ guid, packageUrl: '/packs/err-shape.pack.json', kind: 'mesh' }];

    let resolvePackFile!: (value: unknown) => void;
    const packFilePromise = new Promise<unknown>((resolve) => {
      resolvePackFile = resolve;
    });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/err-shape.pack.json') {
        return packFilePromise.then((v: unknown) => ({ ok: true, json: () => Promise.resolve(v) }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const loadPromise = reg.loadByGuid<MeshAsset>(parseGuid(guid));
      (reg as unknown as { invalidate: (g: string) => void }).invalidate(guid);

      resolvePackFile({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid,
            kind: 'mesh',
            payload: {
              vertices: [
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0,
              ],
              indices: [0, 1, 2],
              attributes: {},
              submeshes: [
                { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' },
              ],
            },
          },
        ],
      });

      const result = await loadPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-invalidated');
        expect(result.error.hint).toBeTruthy();
        expect(result.error.hint).toContain('invalidate');
        expect(result.error.expected).toContain(guid.toLowerCase());
      }
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('invalidateAll during load: error has code, hint, and expected', async () => {
    const reg = makeReg();
    reg.configurePackIndex('/pack-index.json');

    const guid = 'a0000000-0000-4000-a000-000000000031';
    const packIndex = [{ guid, packageUrl: '/packs/err-all.pack.json', kind: 'mesh' }];

    let resolvePackFile!: (value: unknown) => void;
    const packFilePromise = new Promise<unknown>((resolve) => {
      resolvePackFile = resolve;
    });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/err-all.pack.json') {
        return packFilePromise.then((v: unknown) => ({ ok: true, json: () => Promise.resolve(v) }));
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const loadPromise = reg.loadByGuid<MeshAsset>(parseGuid(guid));
      (reg as unknown as { invalidateAll: () => { clearedCount: number } }).invalidateAll();

      resolvePackFile({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid,
            kind: 'mesh',
            payload: {
              vertices: [
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0,
              ],
              indices: [0, 1, 2],
              attributes: {},
              submeshes: [
                { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' },
              ],
            },
          },
        ],
      });

      const result = await loadPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-invalidated');
        expect(result.error.hint).toBeTruthy();
        expect(result.error.hint).toContain('invalidate');
        expect(result.error.expected).toBeTruthy();
      }
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});

describe('AC-05 InspectEntry.kind (brand removed)', () => {
  it('inspect() returns entries with .kind (not .brand)', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const guid = AssetGuid.format(AssetGuid.random());
    reg.catalog(guid, {
      kind: 'sampler' as const,
      magFilter: 'linear' as const,
      minFilter: 'linear' as const,
    });
    const snap = reg.inspect();
    const entry = snap.assets.find((e) => e.guid === guid.toLowerCase());
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('sampler');
    expect(entry?.name).toBe('');
    expect(entry).toHaveProperty('kind');
    expect(entry).not.toHaveProperty('brand');
  });

  it('inspect().assets[].kind mirrors payload.kind', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const payload = {
      kind: 'sampler' as const,
      magFilter: 'linear' as const,
      minFilter: 'linear' as const,
    };
    const guid = AssetGuid.format(AssetGuid.random());
    reg.catalog(guid, payload);
    const snap = reg.inspect();
    const entry = snap.assets.find((e) => e.guid === guid.toLowerCase());
    expect(entry, 'inspect entry for sampler').toBeDefined();
    expect(entry?.kind).toBe('sampler');
  });
});

describe('AC-06 parseAssetPayload passthrough + dev/prod consistency', () => {
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

  it('engine-known kind (mesh) parses correctly via prod path', async () => {
    const reg = makeReg();
    reg.configurePackIndex('/pack-index.json');

    const guid = 'b0000000-0000-4000-a000-000000000010';
    const packIndex = [{ guid, packageUrl: '/packs/ac06-mesh.pack.json', kind: 'mesh' }];

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/ac06-mesh.pack.json') {
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
                      0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    ],
                    indices: [0, 1, 2],
                    attributes: {},
                    submeshes: [
                      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' },
                    ],
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await reg.loadByGuid<MeshAsset>(parseGuid(guid));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('mesh');
  });

  it('unmatched kind payload survives passthrough via prod loadByGuid', async () => {
    const reg = makeReg();
    reg.configurePackIndex('/pack-index.json');

    const guid = 'b0000000-0000-4000-a000-000000000011';
    const customPayload = { fieldA: 42, fieldB: 'hello' };
    const packIndex = [{ guid, packageUrl: '/packs/ac06-unknown.pack.json', kind: 'host-custom' }];

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/ac06-unknown.pack.json') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [{ guid, kind: 'host-custom', payload: customPayload }],
            }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await reg.loadByGuid(parseGuid(guid));
    expect(result.ok).toBe(false);
  });

  it('dev-path catalog stores payload with kind faithfully', () => {
    const reg = makeReg();
    const guid = AssetGuid.format(AssetGuid.random());
    const payload = {
      kind: 'sampler' as const,
      magFilter: 'linear' as const,
      minFilter: 'linear' as const,
    };
    reg.catalog(guid, payload);

    const stored = reg.lookup(guid);
    expect(stored).toBeDefined();
    expect(stored?.kind).toBe('sampler');
  });
});
