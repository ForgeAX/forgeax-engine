import { pluginAssetOutputProducer } from '@forgeax/engine-import';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { AssetPublicationTuple, PackV2 } from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { PackReader, validatePackEnvelope } from '../internal/pack-reader.js';

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
    const registry = new AssetRegistry({ scopeId: 'game' });

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
      if (cached) await registry.readPluginDefinition(guid);
      const result = await registry.readPluginDefinition(guid);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({
          code: 'asset-package-invalid',
          detail: { reason: failure.message },
        });
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
    const registry = new AssetRegistry({ scopeId: 'game' });
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
      expect(registry.inspectSource()?.ready).toEqual([]);
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
    const registry = new AssetRegistry({ scopeId: 'game' });
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
    const published = createRuntimePackPublication({
      scopeId: 'game',
      sourcePath: 'assets/player.pack.ts',
      sourceRevision: 'fixture',
      packageUrl: '/player.pack.json',
      pack: {
        assets: [
          {
            guid,
            kind: 'plugin',
            payload: product.payload,
            refs: product.refs.map((ref) => ref.guid),
            artifacts: {},
          },
        ],
      },
    });
    const pack = published.pack;
    const { scopeId, generation, digest, outputSetDigest } = pack;
    const tuple = { scopeId, generation, digest, outputSetDigest };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(pack)));
    const registry = new AssetRegistry({ scopeId: 'game' });
    registry.setCatalogSource(
      {
        expectedScope: { scopeId: 'game', generation: 1 },
        enumerate: async () =>
          ok([
            {
              guid,
              kind: 'plugin',
              packageUrl: '/player.pack.json',
              sourcePath: 'assets/player.pack.ts',
              publication: published.publication,
            },
          ]),
        subscribe: () => () => {},
      },
      fetcher,
    );
    const handle = (await registry.load(guid, 'plugin')).unwrap();
    expect(registry.read(handle)).toMatchObject({
      ok: true,
      value: {
        kind: 'plugin',
        program: 'project:assets/player.pack.ts#player',
        config: { mesh, speed: 4 },
      },
    });
    expect(registry.inspectSource()?.ready).not.toContain(mesh);
    const definition = await registry.readPluginDefinition(guid);
    expect(definition).toMatchObject({
      ok: true,
      value: { guid, evidence: { kind: 'publication', publication: tuple } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    registry.dispose();
  });
});

function retainedPluginPack() {
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
  const raw = JSON.parse(JSON.stringify(publication.pack)) as PackV2<Record<string, unknown>> &
    AssetPublicationTuple;
  const registry = new AssetRegistry({ scopeId: 'game' });
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
  return { registry, raw, publication, packageUrl };
}

it('validates every artifact envelope before selecting a deferred plugin definition', async () => {
  const f = retainedPluginPack();
  const other = f.raw.assets.find((asset) => asset.guid === mesh);
  if (!other?.artifacts.body) throw new Error('missing fixture descriptor');
  Object.assign(other.artifacts.body, { byteLength: -1 });
  expect(await f.registry.readPluginDefinition(guid)).toMatchObject({
    ok: false,
    error: { code: 'asset-package-invalid', detail: { reason: 'artifact body' } },
  });
  f.registry.dispose();
});

it('shares immutable source definitions and isolates the caller-owned transport input', async () => {
  const f = retainedPluginPack();
  const first = (await f.registry.readPluginDefinition(guid)).unwrap();
  const second = (await f.registry.readPluginDefinition(guid)).unwrap();
  expect(first.asset).toBe(second.asset);
  const config = first.asset.config as { nested: { speed: number } };
  expect(Object.isFrozen(config.nested)).toBe(true);
  expect(Reflect.set(config.nested, 'speed', 17)).toBe(false);
  const rawConfig = f.raw.assets[0]?.payload.config as { nested: { speed: number } };
  expect(Object.isFrozen(rawConfig)).toBe(false);
  rawConfig.nested.speed = 9;
  expect((await f.registry.readPluginDefinition(guid)).unwrap().asset.config).toEqual({
    nested: { speed: 4 },
  });
  f.registry.dispose();
});

it('rejects a body that does not match the admitted publication tuple', async () => {
  const f = retainedPluginPack();
  Object.assign(f.raw, { generation: f.raw.generation + 1 });
  expect(await f.registry.readPluginDefinition(guid)).toMatchObject({
    ok: false,
    error: { code: 'asset-package-invalid', detail: { reason: 'publication tuple mismatch' } },
  });
  f.registry.dispose();
});

it('keeps pure envelope validation separate from owned frozen verification', () => {
  const f = retainedPluginPack();
  const tuple = {
    scopeId: f.raw.scopeId,
    generation: f.raw.generation,
    digest: f.raw.digest,
    outputSetDigest: f.raw.outputSetDigest,
  };
  expect(validatePackEnvelope(f.raw, tuple).ok).toBe(true);
  expect(Object.isFrozen(f.raw)).toBe(false);
  const owned = structuredClone(f.raw);
  expect(new PackReader().verify(owned, tuple).ok).toBe(true);
  expect(Object.isFrozen(owned.assets[0]?.payload)).toBe(true);
  expect(Object.isFrozen(f.raw)).toBe(false);
  f.registry.dispose();
});

it.each([
  'custom-json',
  'native-json',
] as const)('accepts a %s Response without invoking text overrides', async (mode) => {
  const f = retainedPluginPack();
  let jsonCalls = 0,
    textCalls = 0;
  class CustomJsonResponse extends Response {
    override async json() {
      jsonCalls++;
      return structuredClone(f.raw);
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
  const result = await f.registry.readPluginDefinition(guid);
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  expect(result.unwrap().asset.config).toEqual({ nested: { speed: 4 } });
  expect(Object.isFrozen(result.unwrap().asset.config)).toBe(true);
  expect(textCalls).toBe(0);
  expect(jsonCalls).toBe(mode === 'custom-json' ? 1 : 0);
  f.registry.dispose();
});
