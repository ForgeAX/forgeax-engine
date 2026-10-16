import { pluginAssetOutputProducer } from '@forgeax/engine-import';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { AssetPublicationTuple, PluginAsset } from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetRegistry, type ParsedPackFile } from '../asset-registry.js';
import { PackReader, validatePackEnvelope } from '../internal/pack-reader.js';
import { isRetainedJsonTree } from '../internal/retained-pack-json.js';

const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mesh = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
afterEach(() => vi.unstubAllGlobals());

describe('Pack plugin production and runtime transport', () => {
  it.each([
    false,
    true,
  ])('retains Catalog admission failure during native definition lookup with prior cache: %s', async (cached) => {
    const failure = new AssetError({
      code: 'asset-parse-failed',
      expected: 'scoped catalog snapshot authority to be authoritative before identity lookup',
      hint: 'repair the active game catalog before loading assets',
    });
    const registry = new AssetRegistry({} as never);
    if (cached) registry.packIndexCache = new Map();
    const fetcher = vi.fn<typeof fetch>();
    registry.setCatalogSource(
      {
        expectedScope: { scopeId: 'game', generation: 1 },
        enumerate: async () => err(failure),
        subscribe: () => () => {},
      },
      fetcher,
    );
    try {
      const result = await registry.readPluginDefinition(guid);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(failure);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      registry.clearCatalogSource();
    }
  });
  it('rejects a definition read whose Catalog source was replaced during transport', async () => {
    const packageUrl = 'https://project.invalid/player.pack.json';
    const publication = createRuntimePackPublication({
      scopeId: 'game',
      sourcePath: 'player',
      sourceRevision: 'fixed',
      packageUrl,
      pack: {
        assets: [
          {
            guid,
            kind: 'plugin',
            payload: { kind: 'plugin', program: 'player' },
            refs: [],
            artifacts: {},
          },
        ],
      },
    });
    const source = () => ({
      expectedScope: { scopeId: 'game', generation: 1 },
      enumerate: async () =>
        ok([
          {
            guid,
            kind: 'plugin',
            packageUrl,
            sourcePath: 'player',
            publication: publication.publication,
          },
        ]),
      subscribe: () => () => {},
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const registry = new AssetRegistry({} as never);
    registry.setCatalogSource(source(), async () => {
      enter();
      await gate;
      return new Response(JSON.stringify(publication.pack));
    });
    try {
      const pending = registry.readPluginDefinition(guid);
      await entered;
      registry.setCatalogSource(
        source(),
        async () => new Response(JSON.stringify(publication.pack)),
      );
      resume();
      expect((await pending).ok).toBe(false);
      expect(registry.packFiles.size).toBe(0);
      expect((await registry.readPluginDefinition(guid)).ok).toBe(true);
    } finally {
      resume();
      registry.clearCatalogSource();
    }
  });
  it('rejects an older body served at the current Catalog publication URL', async () => {
    const packageUrl = 'https://project.invalid/player.pack.json';
    const publication = (revision: number) =>
      createRuntimePackPublication({
        scopeId: 'game',
        sourcePath: 'assets/player.pack.json',
        sourceRevision: String(revision),
        packageUrl,
        pack: {
          assets: [
            {
              guid,
              kind: 'plugin',
              payload: {
                kind: 'plugin',
                program: 'project:player.js#default',
                config: { revision },
              },
              refs: [],
              artifacts: {},
            },
          ],
        },
      });
    const old = publication(1);
    const current = publication(2);
    const registry = new AssetRegistry({} as never);
    registry.setCatalogSource(
      {
        expectedScope: { scopeId: 'game', generation: 1 },
        enumerate: async () =>
          ok([
            {
              guid,
              kind: 'plugin',
              packageUrl,
              sourcePath: 'assets/player.pack.json',
              publication: current.publication,
            },
          ]),
        subscribe: () => () => {},
      },
      async () => new Response(JSON.stringify(old.pack)),
    );
    try {
      expect((await registry.readPluginDefinition(guid)).ok).toBe(false);
    } finally {
      registry.clearCatalogSource();
    }
  });
  it('reads the definition and atomic tuple without loading referenced custom kinds', async () => {
    const produced = await pluginAssetOutputProducer.produce({
      guid,
      sourceKey: 'plugin/player',
      sourcePath: '/game/assets/player.pack.ts',
      projectRoot: '/game',
      asset: {
        kind: 'plugin',
        module: { specifier: './player.pack.ts', export: 'player' },
        config: { mesh: { $asset: mesh }, speed: 4 },
      },
    });
    expect(produced.ok).toBe(true);
    const product = produced.unwrap();
    const tuple = {
      scopeId: 'game',
      generation: 4,
      digest: `sha256:${'a'.repeat(64)}`,
      outputSetDigest: `sha256:${'b'.repeat(64)}`,
    };
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      ...tuple,
      assets: [
        {
          guid,
          kind: 'plugin',
          payload: product.payload,
          refs: product.refs.map((ref) => ref.guid),
          artifacts: {},
        },
      ],
    };
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url === '/pack-index.json'
              ? [
                  {
                    guid,
                    kind: 'plugin',
                    packageUrl: '/player.pack.json',
                    sourcePath: 'assets/player.pack.ts',
                  },
                ]
              : pack,
          ),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const registry = new AssetRegistry({} as never);
    registry.configurePackIndex('/pack-index.json');
    expect(await registry.loadByGuid<PluginAsset>(registry.parseGuid(guid))).toMatchObject({
      ok: true,
      value: {
        kind: 'plugin',
        program: 'project:assets/player.pack.ts#player',
        config: { mesh, speed: 4 },
      },
    });
    expect(registry.lookup(mesh)).toBeUndefined();
    const definition = await registry.readPluginDefinition(guid);
    expect(definition).toMatchObject({
      ok: true,
      value: { guid, evidence: { kind: 'publication', publication: tuple } },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

function retainedPluginPack(mode: 'public' | 'http' = 'public') {
  const packageUrl = 'https://project.invalid/retained.pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'game',
    sourcePath: 'retained',
    sourceRevision: 'fixed',
    packageUrl,
    pack: {
      assets: [
        {
          guid,
          kind: 'plugin',
          payload: { kind: 'plugin', program: 'retained', config: { nested: { speed: 4 } } },
          refs: [],
          artifacts: {},
        },
        {
          guid: mesh,
          kind: 'mesh',
          payload: { kind: 'mesh', marker: 'mutable' },
          refs: [],
          artifacts: {
            body: {
              path: 'body.bin',
              mediaType: 'application/octet-stream',
              contentEncoding: 'identity',
              byteLength: 1,
              integrity: { algorithm: 'sha256', digest: `sha256:${'a'.repeat(64)}` },
            },
          },
        },
      ],
    },
  });
  const raw = JSON.parse(JSON.stringify(publication.pack)) as ParsedPackFile &
    AssetPublicationTuple;
  const registry = new AssetRegistry({} as never);
  registry.setCatalogSource(
    {
      expectedScope: { scopeId: 'game', generation: 1 },
      enumerate: async () =>
        ok(
          raw.assets.map((asset) => ({
            guid: asset.guid,
            kind: asset.kind,
            packageUrl,
            sourcePath: 'retained',
            publication: publication.publication,
          })),
        ),
      subscribe: () => () => {},
    },
    async () => new Response(JSON.stringify(raw)),
  );
  if (mode === 'public') registry.cachePackFile(packageUrl, raw);
  return { registry, raw, publication, packageUrl };
}

it('revalidates an unrelated descriptor damaged in the same retained Pack object', async () => {
  const f = retainedPluginPack();
  try {
    expect((await f.registry.readPluginDefinition(guid)).ok).toBe(true);
    const other = f.raw.assets.find((asset) => asset.guid === mesh);
    if (!other?.artifacts?.body) throw new Error('fixture descriptor missing');
    expect(Object.isFrozen(f.raw)).toBe(false);
    expect(Object.isFrozen(other.payload)).toBe(false);
    other.artifacts.body = { ...other.artifacts.body, byteLength: -1 };
    expect(await f.registry.readPluginDefinition(guid)).toMatchObject({
      ok: false,
      error: { code: 'asset-package-invalid', detail: { guid: mesh, reason: 'artifact body' } },
    });
  } finally {
    f.registry.clearCatalogSource();
  }
});

it('returns separately owned deeply frozen plugin configurations without freezing the cache', async () => {
  const f = retainedPluginPack();
  try {
    const first = await f.registry.readPluginDefinition(guid);
    const second = await f.registry.readPluginDefinition(guid);
    if (!first.ok || !second.ok) throw new Error('fixture definition rejected');
    expect(first.value.asset).toEqual(second.value.asset);
    expect(first.value.asset).not.toBe(second.value.asset);
    expect(first.value.asset.config).not.toBe(second.value.asset.config);
    const config = first.value.asset.config as { nested: { speed: number } };
    const otherConfig = second.value.asset.config as { nested: { speed: number } };
    expect(config.nested).not.toBe(otherConfig.nested);
    expect(Object.isFrozen(first.value.asset)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.nested)).toBe(true);
    expect(Object.isFrozen(otherConfig.nested)).toBe(true);
    expect(Object.isFrozen(f.raw.assets[0]?.payload)).toBe(false);
    const rawConfig = f.raw.assets[0]?.payload.config as { nested: { speed: number } };
    rawConfig.nested.speed = 9;
    expect(config.nested.speed).toBe(4);
    expect(otherConfig.nested.speed).toBe(4);
    const current = await f.registry.readPluginDefinition(guid);
    expect(current).toMatchObject({
      ok: true,
      value: { asset: { config: { nested: { speed: 9 } } } },
    });
  } finally {
    f.registry.clearCatalogSource();
  }
});

it('rechecks the publication tuple on the same retained object after a successful read', async () => {
  const f = retainedPluginPack();
  try {
    expect((await f.registry.readPluginDefinition(guid)).ok).toBe(true);
    expect(Reflect.set(f.raw, 'generation', f.raw.generation + 1)).toBe(true);
    expect(await f.registry.readPluginDefinition(guid)).toMatchObject({
      ok: false,
      error: { code: 'asset-package-invalid', detail: { reason: 'publication tuple mismatch' } },
    });
  } finally {
    f.registry.clearCatalogSource();
  }
});

it('keeps pure envelope validation separate from the existing frozen verify contract', () => {
  const f = retainedPluginPack();
  try {
    const tuple = {
      scopeId: f.raw.scopeId,
      generation: f.raw.generation,
      digest: f.raw.digest,
      outputSetDigest: f.raw.outputSetDigest,
    };
    expect(validatePackEnvelope(f.raw, tuple).ok).toBe(true);
    expect(Object.isFrozen(f.raw)).toBe(false);
    const owned = structuredClone(f.raw);
    const verified = new PackReader().verify(owned, tuple);
    expect(verified.ok).toBe(true);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.assets[0]?.payload)).toBe(true);
    expect(Object.isFrozen(f.raw)).toBe(false);
  } finally {
    f.registry.clearCatalogSource();
  }
});

it('keeps whole-clone rejection for an unrelated function in a public cached Pack', async () => {
  const f = retainedPluginPack();
  try {
    const other = f.raw.assets.find((asset) => asset.guid === mesh);
    if (!other) throw new Error('fixture asset missing');
    other.payload.uncloneable = () => 'unrelated';
    await expect(f.registry.readPluginDefinition(guid)).rejects.toMatchObject({
      name: 'DataCloneError',
    });
  } finally {
    f.registry.clearCatalogSource();
  }
});

it('evaluates a public tuple getter exactly once through the original whole clone', async () => {
  const f = retainedPluginPack();
  const generation = f.raw.generation;
  let reads = 0;
  Object.defineProperty(f.raw, 'generation', {
    configurable: true,
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? generation : generation + 1;
    },
  });
  try {
    const read = await f.registry.readPluginDefinition(guid);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('Expected original getter snapshot');
    expect(read.value.evidence).toMatchObject({ publication: { generation } });
    expect(reads).toBe(1);
  } finally {
    f.registry.clearCatalogSource();
  }
});

it('uses the intact HTTP JSON tree while retaining independent frozen selected definitions', async () => {
  const f = retainedPluginPack('http');
  try {
    const first = await f.registry.readPluginDefinition(guid);
    const retained = f.registry.packFiles.get(f.packageUrl)?.value;
    expect(isRetainedJsonTree(retained)).toBe(true);
    expect(Object.isFrozen(retained)).toBe(false);
    const second = await f.registry.readPluginDefinition(guid);
    if (!first.ok || !second.ok) throw new Error('fixture definition rejected');
    expect(first.value.asset).toEqual(second.value.asset);
    expect(first.value.asset.config).not.toBe(second.value.asset.config);
    expect(Object.isFrozen(first.value.asset.config)).toBe(true);
    expect(Object.isFrozen(second.value.asset.config)).toBe(true);
    const other = retained?.assets.find((asset) => asset.guid === mesh);
    if (!other?.artifacts?.body) throw new Error('fixture descriptor missing');
    expect(Reflect.set(other.artifacts.body, 'byteLength', -1)).toBe(true);
    expect(isRetainedJsonTree(retained)).toBe(true);
    expect(await f.registry.readPluginDefinition(guid)).toMatchObject({
      ok: false,
      error: { code: 'asset-package-invalid', detail: { guid: mesh, reason: 'artifact body' } },
    });
  } finally {
    f.registry.clearCatalogSource();
  }
});

it.each([
  'function',
  'proxy',
] as const)('falls back to whole-clone rejection after HTTP JSON receives an unbranded %s payload', async (replacement) => {
  const f = retainedPluginPack('http');
  try {
    expect((await f.registry.readPluginDefinition(guid)).ok).toBe(true);
    const retained = f.registry.packFiles.get(f.packageUrl)?.value;
    const other = retained?.assets.find((asset) => asset.guid === mesh);
    if (!other) throw new Error('fixture asset missing');
    other.payload =
      replacement === 'function'
        ? { kind: 'mesh', uncloneable: () => 'unrelated' }
        : new Proxy({ kind: 'mesh' }, {});
    expect(isRetainedJsonTree(retained)).toBe(false);
    await expect(f.registry.readPluginDefinition(guid)).rejects.toMatchObject({
      name: 'DataCloneError',
    });
  } finally {
    f.registry.clearCatalogSource();
  }
});

it.each([
  'custom-json',
  'native-json',
] as const)('preserves public Pack reads for a %s Response subclass', async (mode) => {
  const f = retainedPluginPack('http');
  let jsonCalls = 0;
  let textCalls = 0;
  class CustomJsonResponse extends Response {
    override async json() {
      jsonCalls++;
      return f.raw;
    }
  }
  Object.defineProperty(CustomJsonResponse.prototype, 'text', {
    get() {
      textCalls++;
      throw new Error('custom text getter must not be read');
    },
  });
  class NativeJsonResponse extends Response {
    override async text(): Promise<string> {
      textCalls++;
      throw new Error('custom text override must not be called');
    }
  }
  f.registry.setCatalogSource(
    {
      expectedScope: { scopeId: 'game', generation: 1 },
      enumerate: async () =>
        ok(
          f.raw.assets.map((asset) => ({
            guid: asset.guid,
            kind: asset.kind,
            packageUrl: f.packageUrl,
            sourcePath: 'retained',
            publication: f.publication.publication,
          })),
        ),
      subscribe: () => () => {},
    },
    async () =>
      mode === 'custom-json'
        ? new CustomJsonResponse('opaque custom body')
        : new NativeJsonResponse(JSON.stringify(f.raw)),
  );
  try {
    const result = await f.registry.readPluginDefinition(guid);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    expect(result.value.asset.config).toEqual({ nested: { speed: 4 } });
    expect(Object.isFrozen(result.value.asset.config)).toBe(true);
    expect(textCalls).toBe(0);
    expect(jsonCalls).toBe(mode === 'custom-json' ? 1 : 0);
    expect(isRetainedJsonTree(f.registry.packFiles.get(f.packageUrl)?.value)).toBe(false);
  } finally {
    f.registry.clearCatalogSource();
  }
});
