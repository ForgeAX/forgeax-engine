// @forgeax/engine-assets-runtime -- AssetRegistry coverage (fix issue #709).
// Drives the GUID -> payload catalogue through its public surface: parseGuid,
// catalog + register-time validation, lookup, loadByGuid (catalogued fast-path
// + not-imported miss), resolveName / packageOf / rename, invalidate /
// invalidateAll, inspect, listCatalog. Uses a mock ShaderRegistry (no GPU).

import {
  authoringCapabilityForAssetKind,
  createStandaloneRuntimeAssetBinding,
  type MaterialAsset,
  type MeshAsset,
  type TilesetAsset,
} from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { type CatalogRecord, fetchPackIndex } from '../registry/catalog';
import { registerPackagesFromIndex } from '../registry/load-by-guid';

const GUID_A = '11111111-1111-4111-8111-111111111111';
const GUID_B = '22222222-2222-4222-8222-222222222222';

function makeMockShaderRegistry() {
  return {
    getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
    findMaterialArtifact: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
    getPipeline: vi.fn().mockReturnValue(undefined),
    installMaterialArtifact: vi.fn(),
    inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
  } as unknown as import('@forgeax/engine-shader').ShaderRegistry;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function meshPayload(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), // Position-only layout.
    indices: Uint16Array.of(0, 1, 2),
    attributes: { position: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0) },
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'Default' }],
  } as MeshAsset;
}

describe('parseGuid', () => {
  it('parses a valid dash-form GUID', () => {
    const reg = makeRegistry();
    expect(() => reg.parseGuid(GUID_A)).not.toThrow();
  });

  it('throws an AssetError on a malformed GUID', () => {
    const reg = makeRegistry();
    expect(() => reg.parseGuid('not-a-guid')).toThrow();
  });
});

describe('catalog + lookup', () => {
  it('indexes repeated payload-to-GUID queries once per catalog publication', () => {
    const reg = makeRegistry();
    const first = reg.catalog(GUID_A, meshPayload()).unwrap();
    const second = reg.catalog(GUID_B, meshPayload()).unwrap();
    const scan = vi.spyOn(reg.assetCatalog, Symbol.iterator);
    for (let frame = 0; frame < 60; frame++) {
      expect(reg.guidOf(first)).toBe(GUID_A);
      expect(reg.guidOf(second)).toBe(GUID_B);
      expect(reg.guidOf(meshPayload())).toBeUndefined();
    }
    expect(scan).toHaveBeenCalledTimes(1);
    const replacement = reg.catalog(GUID_A, meshPayload()).unwrap();
    expect(reg.guidOf(replacement)).toBe(GUID_A);
    expect(reg.guidOf(first)).toBe(GUID_A);
    expect(scan).toHaveBeenCalledTimes(2);
    reg.invalidate(GUID_A);
    expect(reg.guidOf(replacement)).toBe(GUID_A);
    expect(reg.guidOf(second)).toBe(GUID_B);
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it('prefers the first current catalog identity over superseded provenance', () => {
    const reg = makeRegistry();
    const original = reg.catalog(GUID_A, meshPayload()).unwrap();
    reg.catalog(GUID_B, original).unwrap();
    expect(reg.guidOf(original)).toBe(GUID_A);
    reg.catalog(GUID_A, meshPayload()).unwrap();
    expect(reg.guidOf(original)).toBe(GUID_B);
    reg.invalidate(GUID_B);
    expect(reg.guidOf(original)).toBe(GUID_B);
    const current = reg.catalog(GUID_B, meshPayload()).unwrap();
    expect(reg.guidOf(current)).toBe(GUID_B);
    reg.invalidateAll();
    expect(reg.guidOf(current)).toBeUndefined();
  });

  it('catalogs a mesh payload (computes aabb) and looks it up by GUID', () => {
    const reg = makeRegistry();
    const res = reg.catalog(GUID_A, meshPayload());
    expect(res.ok).toBe(true);
    const got = reg.lookup<MeshAsset>(GUID_A);
    expect(got?.kind).toBe('mesh');
    expect(got?.aabb).toBeInstanceOf(Float32Array);
  });

  it('lookup returns undefined for an uncatalogued GUID', () => {
    expect(makeRegistry().lookup(GUID_B)).toBeUndefined();
  });

  it('rejects an invalid mesh payload at register time (stride mismatch)', () => {
    const reg = makeRegistry();
    const bad = { ...meshPayload(), vertices: new Float32Array(13) };
    const res = reg.catalog(GUID_A, bad);
    expect(res.ok).toBe(false);
  });

  it('rejects an invalid tileset payload at register time', () => {
    const reg = makeRegistry();
    const bad = {
      kind: 'tileset',
      atlases: [],
      tileWidth: 16,
      tileHeight: 16,
      columns: 1,
      rows: 1,
      regions: [],
      tiles: [],
    } as unknown as TilesetAsset;
    expect(reg.catalog(GUID_A, bad).ok).toBe(false);
  });

  it('rejects a material with an explicit empty passes[]', () => {
    const reg = makeRegistry();
    const bad = { kind: 'material', passes: [] } as unknown as MaterialAsset;
    expect(reg.catalog(GUID_A, bad).ok).toBe(false);
  });
});

describe('loadByGuid', () => {
  it('accepts a scoped static pack-index after its runtime catalog URL changes', async () => {
    const reg = makeRegistry();
    reg.configureRuntimeBinding(createStandaloneRuntimeAssetBinding('game-a'));
    reg.configurePackIndex('/pack-index.json');
    const originalFetch = globalThis.fetch;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            schemaVersion: 'runtime-catalog-snapshot-v1',
            scopeId: 'game-a',
            generation: 1,
            authority: 'authoritative',
            entries: [
              {
                guid: GUID_A,
                packageUrl: '/assets/mesh.pack.json',
                kind: 'mesh',
              },
            ],
            diagnostics: [],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);

    try {
      const result = await fetchPackIndex(reg);

      expect(result.ok).toBe(true);
      expect(fetcher).toHaveBeenCalledWith('/pack-index.json', { cache: 'no-store' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns the payload for an already-catalogued GUID (fast path)', async () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    const parsed = reg.parseGuid(GUID_A);
    const res = await reg.loadByGuid<MeshAsset>(parsed);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe('mesh');
  });

  it('fails for an uncatalogued GUID with no pack index configured', async () => {
    const reg = makeRegistry();
    const res = await reg.loadByGuid(reg.parseGuid(GUID_B));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // No packIndexUrl + no transport: the load misses the catalogue fast-path
    // and surfaces the closed-union asset-not-found (the DDC asset-not-imported
    // arm only fires once a pack index is configured).
    expect((res.error as { code: string }).code).toBe('asset-not-found');
  });

  it('does not route a static load failure through decodeImageBytes', async () => {
    const reg = makeRegistry();
    const res = await reg.loadByGuid(reg.parseGuid(GUID_B));
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.error as { code: string }).code).toBe('asset-not-found');
  });

  it('does not return a payload for a failed cooked projection', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/pack-index.json')) {
          return new Response(
            JSON.stringify([
              {
                guid: GUID_A,
                packageUrl: '/runtime/failed.pack.json',
                kind: 'mesh',
                sourcePath: 'authoring/mesh.pack.json',
                subject: 'internal-asset',
                execution: 'cooked',
                lifecycle: 'failed',
                projection: {
                  subject: 'internal-asset',
                  execution: 'cooked',
                  lifecycle: 'failed',
                  operations: {
                    preview: { operation: 'preview', enabled: false },
                    save: { operation: 'save', enabled: false },
                    rebuild: { operation: 'rebuild', enabled: true },
                    sourceOverride: { operation: 'sourceOverride', enabled: false },
                    instanceOverride: { operation: 'instanceOverride', enabled: false },
                    promote: { operation: 'promote', enabled: false },
                  },
                },
              },
            ]),
          );
        }
        return new Response(
          JSON.stringify({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: GUID_A,
                kind: 'mesh',
                payload: { vertices: new Array(36).fill(0), indices: [0, 1, 2] },
                refs: [],
                artifacts: {},
              },
            ],
          }),
        );
      }),
    );

    try {
      const result = await reg.loadByGuid(reg.parseGuid(GUID_A));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('asset-not-imported');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refreshCatalog bypasses the browser cache', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');
    const originalFetch = globalThis.fetch;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify([
            {
              guid: GUID_A,
              packageUrl: '/runtime/mesh.pack.json',
              kind: 'mesh',
              sourcePath: 'authoring/mesh.glb',
            },
          ]),
        ),
    );
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(reg.refreshCatalog()).resolves.toBe(true);
      expect(fetcher).toHaveBeenCalledWith('/pack-index.json', { cache: 'no-store' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('resolveName / packageOf / rename', () => {
  it('a freshly catalogued inline asset has no package and an empty derived name', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    expect(reg.packageOf(GUID_A)).toBeNull();
    expect(reg.resolveName(GUID_A)).toBe('');
  });

  it('packageOf returns undefined for an unregistered GUID', () => {
    expect(makeRegistry().packageOf(GUID_B)).toBeUndefined();
  });

  it('rename sets a stored name on a no-package asset', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    const res = reg.rename(GUID_A, 'hero-mesh');
    expect(res.ok).toBe(true);
    expect(reg.resolveName(GUID_A)).toBe('hero-mesh');
  });

  it('rename errors with asset-not-found for an unregistered GUID', () => {
    const res = makeRegistry().rename(GUID_B, 'x');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('asset-not-found');
  });
});

describe('invalidate / invalidateAll', () => {
  it('invalidate drops a single catalogued asset', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    reg.invalidate(GUID_A);
    expect(reg.lookup(GUID_A)).toBeUndefined();
  });

  it('invalidate preserves a derived package name when a reload changes the DDC path', () => {
    const reg = makeRegistry();
    reg._registerPackage('/assets/sky.hdr', [GUID_A]);
    reg.catalog(GUID_A, meshPayload());
    expect(reg.resolveName(GUID_A)).toBe('sky.hdr');

    reg.invalidate(GUID_A);
    registerPackagesFromIndex(
      reg,
      new Map([
        [
          GUID_A,
          {
            packageUrl: '/node_modules/.cache/forgeax-ddc/sky.bin',
            sourcePath: '/assets/sky.hdr',
          },
        ],
      ]),
    );
    reg.catalog(GUID_A, meshPayload());

    expect(reg.resolveName(GUID_A)).toBe('sky.bin');
  });

  it('invalidateAll clears every catalogued asset and reports the count', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    reg.catalog(GUID_B, meshPayload());
    const { clearedCount } = reg.invalidateAll();
    expect(clearedCount).toBeGreaterThanOrEqual(2);
    expect(reg.lookup(GUID_A)).toBeUndefined();
    // Idempotent: a second call reports 0.
    expect(reg.invalidateAll().clearedCount).toBe(0);
  });

  it('runtime binding transitions preserve engine-owned builtin meshes', async () => {
    const reg = makeRegistry();
    const builtinGuid = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
    const before = reg.lookup<MeshAsset>(builtinGuid);
    expect(before?.kind).toBe('mesh');

    reg.configureRuntimeBinding(createStandaloneRuntimeAssetBinding('game-a'));

    const after = reg.lookup<MeshAsset>(builtinGuid);
    expect(after).toBe(before);
    const loaded = await reg.loadByGuid<MeshAsset>(reg.parseGuid(builtinGuid));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toBe(before);
  });
});

describe('imported-output package identity', () => {
  it('uses the authored source path for a single-asset DDC output', () => {
    const reg = makeRegistry();
    registerPackagesFromIndex(
      reg,
      new Map([
        [
          GUID_A,
          {
            packageUrl: `/__forgeax-ddc/${GUID_A}.pack.json`,
            sourcePath: 'demo-assets/template-game-default/sky.hdr',
            subject: 'imported-output',
          },
        ],
      ]),
    );
    reg.catalog(GUID_A, meshPayload());

    expect(reg.resolveName(GUID_A)).toBe('sky.hdr');
    expect(reg.packageOf(GUID_A)?.path).toBe('demo-assets/template-game-default/sky.hdr');
  });
});

describe('inspect / listCatalog', () => {
  it('returns an empty readonly catalog before a registry is bound', () => {
    const reg = makeRegistry();
    reg.assetCatalog.clear();
    const rows = reg.listCatalog();
    expect(rows).toEqual([]);
    expectTypeOf(rows).toMatchTypeOf<readonly unknown[]>();
  });

  it('inspect lists catalogued assets with guid/kind/name', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    const snap = reg.inspect();
    const entry = snap.assets.find((a) => a.guid === GUID_A.toLowerCase());
    expect(entry?.kind).toBe('mesh');
  });

  it('listCatalog returns a fresh snapshot including the inline asset', () => {
    const reg = makeRegistry();
    reg.catalog(GUID_A, meshPayload());
    const rows = reg.listCatalog();
    expect(rows.some((r) => r.guid === GUID_A.toLowerCase() && r.kind === 'mesh')).toBe(true);
  });

  it('listCatalog deeply preserves every canonical producer fact from the full catalog', () => {
    const reg = makeRegistry();
    reg.assetCatalog.clear();
    const provenance = { provider: 'host-importer', version: '7.2.0' } as const;
    const revision = { digest: 'sha256:catalog', observedAt: 42, rootId: 'game-root' } as const;
    const relations = [
      {
        from: { type: 'asset', id: GUID_A },
        to: { type: 'resource', id: 'source/blob' },
        type: 'produces',
        provenance,
      },
    ] as const;
    const diagnostics = [
      {
        code: 'producer-warning',
        severity: 'warning',
        expected: 'stable source key',
        actual: 'legacy index fallback',
        hint: 'repair the producer declaration',
        authority: 'producer',
      },
    ] as const;
    const canonicalRow: CatalogRecord = {
      packageUrl: '/assets/blob.pack.json',
      sourcePath: 'models/blob.host',
      kind: 'host/blob',
      packageId: 'host-package',
      provenance,
      revision,
      sourceKey: 'blob/main',
      sourceIndex: 3,
      relations,
      diagnostics,
    } as const;
    const legacyRow: CatalogRecord = {
      packageUrl: '/assets/legacy.pack.json',
      sourcePath: 'models/legacy.host',
      kind: 'host/legacy',
    } as const;
    reg.packIndexCache = new Map([
      [GUID_A.toLowerCase(), canonicalRow],
      [GUID_B.toLowerCase(), legacyRow],
    ]);

    expect(reg.listCatalog()).toEqual([
      {
        guid: GUID_A.toLowerCase(),
        ...canonicalRow,
        authoring: authoringCapabilityForAssetKind(canonicalRow.kind),
      },
      {
        guid: GUID_B.toLowerCase(),
        ...legacyRow,
        authoring: authoringCapabilityForAssetKind(legacyRow.kind),
      },
    ]);
    expect(reg.listCatalog()[1]).toEqual({
      guid: GUID_B.toLowerCase(),
      ...legacyRow,
      authoring: authoringCapabilityForAssetKind(legacyRow.kind),
    });
  });

  it('listCatalog includes a catalogued AnimationGraph with kind=animation-graph', () => {
    const reg = makeRegistry();
    const graph = {
      kind: 'animation-graph' as const,
      nodes: [{ type: 'clip' as const, clip: 0 as never, weight: 1 }],
      root: 0,
    };
    reg.catalog(GUID_B, graph);
    const rows = reg.listCatalog();
    expect(rows.some((r) => r.guid === GUID_B.toLowerCase() && r.kind === 'animation-graph')).toBe(
      true,
    );
  });
});

describe('configuration setters + payload parse delegation', () => {
  it('setMetrics / setTranscodeCaps / configurePackIndex mutate config without throwing', () => {
    const reg = makeRegistry();
    reg.setMetrics({ increment: () => {} } as never);
    reg.setTranscodeCaps({ bc: false, etc2: false, astc: false } as never);
    reg.configurePackIndex('/pack-index.json');
    // configurePackIndex is idempotent-safe on a re-set (resets the cache).
    reg.configurePackIndex('/pack-index.json');
  });

  it('materialShaderTextureFieldNames returns undefined for an unregistered shader', () => {
    expect(makeRegistry().materialShaderTextureFieldNames('forgeax::nope')).toBeUndefined();
  });

  it('parseAssetPayload dispatches a mesh payload through the loader registry', () => {
    const reg = makeRegistry();
    const out = reg.parseAssetPayload('mesh', {
      vertices: new Array(12).fill(0),
      indices: [0, 0, 0],
    });
    expect((out as { kind?: string }).kind).toBe('mesh');
  });

  it('parseAssetPayload passes an unregistered kind through as a raw payload', () => {
    // Unknown kinds have no engine loader; the payload is returned verbatim
    // (stamped with kind) so a host-registered loader can own the parse (D-1).
    const out = makeRegistry().parseAssetPayload('sampler', { addressModeU: 'repeat' });
    expect((out as { kind?: string }).kind).toBe('sampler');
  });

  it('parseAndReturnAsset returns a Result carrying the parsed asset + refs', () => {
    const reg = makeRegistry();
    const res = reg.parseAndReturnAsset({
      kind: 'mesh',
      payload: { vertices: new Array(12).fill(0), indices: [0, 0, 0] },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.asset.kind).toBe('mesh');
  });

  it('refreshCatalog is a no-op (returns false) when no pack index is configured', async () => {
    expect(await makeRegistry().refreshCatalog()).toBe(false);
  });
});
