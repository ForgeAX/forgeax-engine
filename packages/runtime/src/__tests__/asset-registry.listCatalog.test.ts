// w1 TDD: listCatalog unit test (plan-strategy section 2 D1)
//
// Test-first approach — call listCatalog() before it exists on AssetRegistry,
// confirming the TDD "red" phase via TypeScript compile error (TS2339).
// w2 will add the implementation and turn these tests green.
//
// plan-strategy section 2 D1 (engine export for AC-03 asset panel enumeration);
// requirements AC-03 (asset panel = engine truth, no parallel discovery);
// research Finding 5 (AssetRegistry public API is all guid point-lookup;
// assetCatalog/packIndexCache are private — no enumeration primitive exists yet).

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeReg(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

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

describe('D-1 listCatalog() (TDD: red before w2 impl)', () => {
  it('returns non-empty array for catalogued assets matching inspect() truth', () => {
    const reg = makeReg();
    const guid = AssetGuid.format(AssetGuid.random());
    const mesh = makeMeshFixture();
    reg.catalog(guid, mesh);

    const list = reg.listCatalog();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);

    const found = list.find(
      (e: { guid: string; kind: string; name?: string; packageUrl: string }) =>
        e.guid === guid.toLowerCase(),
    );
    expect(found).toBeDefined();
    expect(found?.guid).toBe(guid.toLowerCase());
    expect(found?.kind).toBe('mesh');
    // name derived via resolveName (empty for no-package catalogued asset)
    expect(found).toHaveProperty('name');
    expect(found).toHaveProperty('packageUrl');
  });

  it('returns empty array for a registry with zero catalogued assets (boundary E3)', () => {
    const reg = makeReg();
    // Fresh registry still has builtins. Clear them via invalidateAll.
    reg.invalidateAll();
    const list = reg.listCatalog();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0);
  });

  it('surfaces dev-path refs as flattened GUID edges (Content Browser dependency graph)', () => {
    const reg = makeReg();
    const guid = AssetGuid.format(AssetGuid.random());
    const dep1 = AssetGuid.format(AssetGuid.random());
    const dep2 = AssetGuid.format(AssetGuid.random());
    const mesh = makeMeshFixture();
    // catalog(guid, asset, refs) stores the rich AssetRef[] on the envelope;
    // listCatalog must flatten it to plain GUID strings.
    reg.catalog(guid, mesh, [{ guid: dep1, sourceField: { fieldName: 'a' } }, { guid: dep2 }]);

    const found = reg.listCatalog().find((e) => e.guid === guid.toLowerCase());
    expect(found?.refs).toEqual([dep1, dep2]);
  });

  it('omits refs when an asset has no outgoing edges (add-only, undefined not [])', () => {
    const reg = makeReg();
    const guid = AssetGuid.format(AssetGuid.random());
    reg.catalog(guid, makeMeshFixture());

    const found = reg.listCatalog().find((e) => e.guid === guid.toLowerCase());
    expect(found).toBeDefined();
    expect(found?.refs).toBeUndefined();
  });

  it('returns a snapshot — two calls return distinct array objects (no internal Map leak, charter P4)', () => {
    const reg = makeReg();
    const guid = AssetGuid.format(AssetGuid.random());
    const mesh = makeMeshFixture();
    reg.catalog(guid, mesh);

    const first = reg.listCatalog();
    const firstLen = first.length;

    const second = reg.listCatalog();
    expect(second.length).toBe(firstLen);
    // Snapshot identity: two calls return distinct array objects
    // (no internal Map reference leak — charter P4).
    expect(first).not.toBe(second);
  });
});

// Prod path: sourcePath is only present on the pack-index (fetchPackIndex ->
// packIndexCache), never on dev-path catalog() envelopes. Editors need it to
// locate the `.meta.json` sidecar for external-asset CRUD; `packageUrl`
// points at the Pack v2 package and cannot
// be reversed to the source path.
describe('listCatalog() prod-path sourcePath (editor CRUD sidecar lookup)', () => {
  const PACK_INDEX_URL = '/pack-index.json';
  const MESH_GUID = 'a0000000-0000-4000-a000-000000000001';
  const MESH_URL = '/assets/arrow_bow.fbx.a0000000.pack.json';
  const MESH_SOURCE = 'games/marscraft/assets/arrow_bow.fbx';
  // A row that omits sourcePath (legacy / malformed pack-index) must surface as
  // undefined, not '', so consumers can distinguish "no source" from "empty".
  const INLINE_GUID = 'a0000000-0000-4000-a000-000000000002';

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

  it('surfaces sourcePath from the pack-index; omits it for rows that lack one', async () => {
    const reg = makeReg();
    reg.configurePackIndex(PACK_INDEX_URL);

    const packIndex = [
      { guid: MESH_GUID, packageUrl: MESH_URL, kind: 'mesh', sourcePath: MESH_SOURCE },
      { guid: INLINE_GUID, packageUrl: '/assets/other.pack.json', kind: 'mesh' },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof globalThis.fetch;

    // Populate packIndexCache without needing the (missing) pack bodies:
    // refreshCatalog fetches + parses the pack-index into packIndexCache, which
    // is the source listCatalog reads for prod rows.
    await reg.refreshCatalog();

    const withSource = reg.listCatalog().find((e) => e.guid === MESH_GUID.toLowerCase());
    expect(withSource?.sourcePath).toBe(MESH_SOURCE);

    const withoutSource = reg.listCatalog().find((e) => e.guid === INLINE_GUID.toLowerCase());
    expect(withoutSource).toBeDefined();
    expect(withoutSource?.sourcePath).toBeUndefined();
  });
});
