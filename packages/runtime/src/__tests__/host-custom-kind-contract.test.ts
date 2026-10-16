// feat-20260623 M4 / w13 + w14 -- AC-02/AC-03 contract: host custom kind
// end-to-end through engine.assets.loaders.register -> loadByGuid ->
// recursive refs + cross-kind mixed graph. The host payload type is NOT in
// the engine's Asset union; the test proves the generic registry pipeline
// works without touching the closed Asset union.
//
// AC-02 (w13): custom kind sans refs, dev + prod paths, negative path
// AC-03 (w14): refs recursion (host->host, host->engine, engine->host, cycle)

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Loader, LoaderOutput } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ── host-defined custom payload types (NOT in Asset union) ──────────

interface MyGameConfig {
  kind: string;
  title: string;
  resolution: { width: number; height: number };
  players: number;
}

// ── helpers ──────────────────────────────────────────────────────────

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function myGameConfigLoader(): Loader<MyGameConfig> {
  return {
    kind: 'my-game-config',
    load(payload: Record<string, unknown>): LoaderOutput<MyGameConfig> {
      return payload as unknown as MyGameConfig;
    },
  };
}

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test teardown
  delete (globalThis as any).fetch;
});

// ═════════════════════════════════════════════════════════════════════
// w13: AC-02 — host custom kind end-to-end contract (no refs)
// ═════════════════════════════════════════════════════════════════════

describe('AC-02 — host custom kind end-to-end (no refs)', () => {
  it('dev path: catalog custom payload then loadByGuid<MyGameConfig> returns the exact payload', async () => {
    const reg = makeRegistry();
    reg.loaders.register(myGameConfigLoader());

    const guid = parseGuid('c0000000-0000-4000-a000-000000000001');
    const config: MyGameConfig = {
      kind: 'my-game-config',
      title: 'Test Game',
      resolution: { width: 1920, height: 1080 },
      players: 4,
    };

    const catResult = reg.catalog(guid, config);
    expect(catResult.ok).toBe(true);

    const loadResult = await reg.loadByGuid<MyGameConfig>(guid);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) throw new Error('unreachable');
    // The value is MyGameConfig without any `as` cast.
    const cfg = loadResult.value;
    expect(cfg.title).toBe('Test Game');
    expect(cfg.resolution.width).toBe(1920);
    expect(cfg.players).toBe(4);
  });

  it('dev path: lookup<MyGameConfig> returns the custom payload', () => {
    const reg = makeRegistry();
    reg.loaders.register(myGameConfigLoader());

    const guid = parseGuid('c0000000-0000-4000-a000-000000000002');
    const config: MyGameConfig = {
      kind: 'my-game-config',
      title: 'Lookup Game',
      resolution: { width: 800, height: 600 },
      players: 2,
    };

    reg.catalog(guid, config);
    const cfg = reg.lookup<MyGameConfig>(guid);
    expect(cfg).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(cfg!.title).toBe('Lookup Game');
  });

  it('prod path: custom kind loaded through configurePackIndex + fetch + parseAssetPayload', async () => {
    const reg = makeRegistry();
    reg.loaders.register(myGameConfigLoader());

    const guidStr = 'c0000000-0000-4000-a000-000000000003';
    const packIndex = [
      { guid: guidStr, packageUrl: '/packs/config.pack.json', kind: 'my-game-config' },
    ];
    const configPayload: Record<string, unknown> = {
      kind: 'my-game-config',
      title: 'Prod Game',
      resolution: { width: 1280, height: 720 },
      players: 2,
    };
    const packFile = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: guidStr,
          kind: 'my-game-config',
          payload: configPayload,
        },
      ],
    };

    reg.configurePackIndex('/pack-index.json');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/config.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packFile) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock as typeof globalThis.fetch;

    const guid = parseGuid(guidStr);
    const loadResult = await reg.loadByGuid<MyGameConfig>(guid);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) throw new Error('unreachable');
    const cfg = loadResult.value;
    expect(cfg.title).toBe('Prod Game');
    expect(cfg.resolution.width).toBe(1280);
    expect(cfg.players).toBe(2);
  });

  it('prod path: dev (catalog) and prod (fetch) paths produce the same payload', async () => {
    const reg = makeRegistry();
    reg.loaders.register(myGameConfigLoader());

    const guidStr = 'c0000000-0000-4000-a000-000000000004';
    const configPayload: Record<string, unknown> = {
      kind: 'my-game-config',
      title: 'Same Game',
      resolution: { width: 1024, height: 768 },
      players: 3,
    };

    // dev path
    const devGuid = parseGuid('c0000000-0000-4000-a000-000000000005');
    reg.catalog(devGuid, configPayload as unknown as MyGameConfig);
    const devResult = await reg.loadByGuid<MyGameConfig>(devGuid);
    expect(devResult.ok).toBe(true);

    // prod path
    const packIndex = [
      { guid: guidStr, packageUrl: '/packs/same.pack.json', kind: 'my-game-config' },
    ];
    const packFile = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: guidStr,
          kind: 'my-game-config',
          payload: configPayload,
        },
      ],
    };

    reg.configurePackIndex('/pack-index.json');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/same.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packFile) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock as typeof globalThis.fetch;

    const prodGuid = parseGuid(guidStr);
    const prodResult = await reg.loadByGuid<MyGameConfig>(prodGuid);
    expect(prodResult.ok).toBe(true);

    if (!devResult.ok || !prodResult.ok) throw new Error('unreachable');
    expect(devResult.value).toEqual(prodResult.value);
  });

  it('negative: uncatalogued GUID returns asset-not-found structured error', async () => {
    const reg = makeRegistry();

    // GUID never catalogued, no pack-index configured -> dev-path miss
    const guid = parseGuid('c0000000-0000-4000-a000-000000000006');
    const loadResult = await reg.loadByGuid(guid);
    expect(loadResult.ok).toBe(false);
    if (loadResult.ok) throw new Error('expected error');
    expect(loadResult.error.code).toBe('asset-not-found');
    // Structured error carries .code / .expected / .hint (charter P3).
    const err = loadResult.error as { code: string; expected: string; hint: string };
    expect(err.code).toBe('asset-not-found');
    expect(typeof err.expected).toBe('string');
    expect(typeof err.hint).toBe('string');
  });
});

// ═════════════════════════════════════════════════════════════════════
// w14: AC-03 — host custom kind with refs recursion + cross-kind
// ═════════════════════════════════════════════════════════════════════

describe('AC-03 — host custom kind with refs (recursive loadByGuid)', () => {
  it('host->host: recursive refs are loaded from the same pack file', async () => {
    const reg = makeRegistry();
    reg.loaders.register(myGameConfigLoader());

    const parentGuidStr = 'c0000000-0000-4000-a000-000000000010';
    const childGuidStr = 'c0000000-0000-4000-a000-000000000011';

    const packIndex = [
      { guid: parentGuidStr, packageUrl: '/packs/refs.pack.json', kind: 'my-game-config' },
      { guid: childGuidStr, packageUrl: '/packs/refs.pack.json', kind: 'my-game-config' },
    ];
    const packFile = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: parentGuidStr,
          kind: 'my-game-config',
          payload: {
            kind: 'my-game-config',
            title: 'Parent Config',
            resolution: { width: 1920, height: 1080 },
            players: 4,
          },
          refs: [childGuidStr],
        },
        {
          guid: childGuidStr,
          kind: 'my-game-config',
          payload: {
            kind: 'my-game-config',
            title: 'Child Config',
            resolution: { width: 800, height: 600 },
            players: 1,
          },
        },
      ],
    };

    reg.configurePackIndex('/pack-index.json');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/refs.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packFile) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock as typeof globalThis.fetch;

    const parentGuid = parseGuid(parentGuidStr);
    const childGuid = parseGuid(childGuidStr);

    const result = await reg.loadByGuid<MyGameConfig>(parentGuid);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.title).toBe('Parent Config');
    expect(result.value.players).toBe(4);

    // Child was recursively loaded (registered in catalog).
    const child = reg.lookup<MyGameConfig>(childGuid);
    expect(child).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(child!.title).toBe('Child Config');
  });

  it('host->engine: host custom asset with refs to engine mesh asset', async () => {
    const reg = makeRegistry();
    reg.loaders.register(myGameConfigLoader());

    const hostGuidStr = 'c0000000-0000-4000-a000-000000000020';
    const meshGuidStr = 'c0000000-0000-4000-a000-000000000021';

    const packIndex = [
      { guid: hostGuidStr, packageUrl: '/packs/host-engine.pack.json', kind: 'my-game-config' },
      { guid: meshGuidStr, packageUrl: '/packs/host-engine.pack.json', kind: 'mesh' },
    ];
    const packFile = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: hostGuidStr,
          kind: 'my-game-config',
          payload: {
            kind: 'my-game-config',
            title: 'Host with engine ref',
            resolution: { width: 1024, height: 768 },
            players: 2,
          },
          refs: [meshGuidStr],
        },
        {
          guid: meshGuidStr,
          kind: 'mesh',
          payload: {
            kind: 'mesh',
            vertices: new Array(12 * 3).fill(0),
            indices: [0, 1, 2],
            submeshes: [
              { topology: 'triangle-list', indexOffset: 0, indexCount: 3, vertexOffset: 0 },
            ],
          },
        },
      ],
    };

    reg.configurePackIndex('/pack-index.json');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/host-engine.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packFile) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock as typeof globalThis.fetch;

    const hostGuid = parseGuid(hostGuidStr);
    const meshGuid = parseGuid(meshGuidStr);

    // Load the host custom kind; the engine mesh ref is also loaded.
    const result = await reg.loadByGuid<MyGameConfig>(hostGuid);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.title).toBe('Host with engine ref');

    // Engine mesh was recursively loaded.
    const mesh = reg.lookup(meshGuid);
    expect(mesh).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(mesh!.kind).toBe('mesh');
  });

  it('engine->host: engine mesh asset with refs to host custom kind', async () => {
    const reg = makeRegistry();
    const myConfigLoader = myGameConfigLoader();
    reg.loaders.register(myConfigLoader);

    const meshGuidStr = 'c0000000-0000-4000-a000-000000000030';
    const childGuidStr = 'c0000000-0000-4000-a000-000000000031';

    const packIndex = [
      { guid: meshGuidStr, packageUrl: '/packs/engine-host.pack.json', kind: 'mesh' },
      { guid: childGuidStr, packageUrl: '/packs/engine-host.pack.json', kind: 'my-game-config' },
    ];
    const packFile = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: meshGuidStr,
          kind: 'mesh',
          payload: {
            kind: 'mesh',
            vertices: new Array(12 * 3).fill(0),
            indices: [0, 1, 2],
            submeshes: [
              { topology: 'triangle-list', indexOffset: 0, indexCount: 3, vertexOffset: 0 },
            ],
          },
          refs: [childGuidStr],
        },
        {
          guid: childGuidStr,
          kind: 'my-game-config',
          payload: {
            kind: 'my-game-config',
            title: 'Config from mesh ref',
            resolution: { width: 720, height: 480 },
            players: 1,
          },
        },
      ],
    };

    reg.configurePackIndex('/pack-index.json');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/engine-host.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packFile) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock as typeof globalThis.fetch;

    const meshGuid = parseGuid(meshGuidStr);
    const childGuid = parseGuid(childGuidStr);

    // Load the mesh; the host custom kind in its refs[] is also loaded.
    const meshResult = await reg.loadByGuid(meshGuid);
    expect(meshResult.ok).toBe(true);

    // Host custom kind was recursively loaded via the mesh refs.
    const child = reg.lookup<MyGameConfig>(childGuid);
    expect(child).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(child!.title).toBe('Config from mesh ref');
  });

  it('host->engine->host mixed graph: A(host) -> B(engine) -> C(host)', async () => {
    const reg = makeRegistry();
    const myConfigLoader = myGameConfigLoader();
    reg.loaders.register(myConfigLoader);

    const aGuidStr = 'c0000000-0000-4000-a000-000000000040';
    const bGuidStr = 'c0000000-0000-4000-a000-000000000041';
    const cGuidStr = 'c0000000-0000-4000-a000-000000000042';

    const packIndex = [
      { guid: aGuidStr, packageUrl: '/packs/mixed.pack.json', kind: 'my-game-config' },
      { guid: bGuidStr, packageUrl: '/packs/mixed.pack.json', kind: 'mesh' },
      { guid: cGuidStr, packageUrl: '/packs/mixed.pack.json', kind: 'my-game-config' },
    ];
    const packFile = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: aGuidStr,
          kind: 'my-game-config',
          payload: {
            kind: 'my-game-config',
            title: 'Host A',
            resolution: { width: 1024, height: 768 },
            players: 2,
          },
          refs: [bGuidStr],
        },
        {
          guid: bGuidStr,
          kind: 'mesh',
          payload: {
            kind: 'mesh',
            vertices: new Array(12 * 3).fill(0),
            indices: [0, 1, 2],
            submeshes: [
              { topology: 'triangle-list', indexOffset: 0, indexCount: 3, vertexOffset: 0 },
            ],
          },
          refs: [cGuidStr],
        },
        {
          guid: cGuidStr,
          kind: 'my-game-config',
          payload: {
            kind: 'my-game-config',
            title: 'Host C',
            resolution: { width: 360, height: 240 },
            players: 1,
          },
        },
      ],
    };

    reg.configurePackIndex('/pack-index.json');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/mixed.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packFile) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock as typeof globalThis.fetch;

    const aGuid = parseGuid(aGuidStr);
    const bGuid = parseGuid(bGuidStr);
    const cGuid = parseGuid(cGuidStr);

    // Load the host A; B (engine mesh) and C (host) are loaded via refs.
    const result = await reg.loadByGuid<MyGameConfig>(aGuid);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.title).toBe('Host A');

    // Intermediate engine mesh was loaded.
    const mesh = reg.lookup(bGuid);
    expect(mesh).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(mesh!.kind).toBe('mesh');

    // Transitive host child was loaded.
    const child = reg.lookup<MyGameConfig>(cGuid);
    expect(child).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(child!.title).toBe('Host C');
  });

  it('cycle: refs loop does not cause infinite recursion', async () => {
    const reg = makeRegistry();
    reg.loaders.register(myGameConfigLoader());

    const aGuidStr = 'c0000000-0000-4000-a000-000000000050';
    const bGuidStr = 'c0000000-0000-4000-a000-000000000051';

    const packIndex = [
      { guid: aGuidStr, packageUrl: '/packs/cycle.pack.json', kind: 'my-game-config' },
      { guid: bGuidStr, packageUrl: '/packs/cycle.pack.json', kind: 'my-game-config' },
    ];
    const packFile = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: aGuidStr,
          kind: 'my-game-config',
          payload: {
            kind: 'my-game-config',
            title: 'Cycle A',
            resolution: { width: 640, height: 480 },
            players: 1,
          },
          refs: [bGuidStr],
        },
        {
          guid: bGuidStr,
          kind: 'my-game-config',
          payload: {
            kind: 'my-game-config',
            title: 'Cycle B',
            resolution: { width: 320, height: 240 },
            players: 1,
          },
          refs: [aGuidStr],
        },
      ],
    };

    reg.configurePackIndex('/pack-index.json');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === '/packs/cycle.pack.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packFile) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock as typeof globalThis.fetch;

    const aGuid = parseGuid(aGuidStr);

    // Loading A (A -> B -> A) must complete without hanging.
    const result = await reg.loadByGuid<MyGameConfig>(aGuid);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.title).toBe('Cycle A');
  });
});
