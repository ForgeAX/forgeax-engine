import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAnimationAsset } from '@forgeax/engine-animation';
import { createAssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createHostAudioConsumer, WebAudioEngine } from '@forgeax/engine-audio-webaudio';
import { World } from '@forgeax/engine-ecs';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { resolveTilesetRuntime } from '@forgeax/engine-render/internal';
import { defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import {
  type Asset,
  createStandaloneRuntimeAssetBinding,
  type PackIndexEntry,
  type ParticleEffectAsset,
} from '@forgeax/engine-types';
import {
  loadVfxGpuEffect,
  PARTICLE_CODE_DEFAULT_MODULE_ID,
  ParticleEffectPlayer,
} from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { describe, expect, it, vi } from 'vitest';
import { classifyWatchedPath } from '../dev/watcher.js';
import { createPluginPackInternal } from '../plugin-pack.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

type Middleware = (
  request: {
    readonly url?: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
  },
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  },
  next: () => void,
) => void | Promise<void>;

async function request(
  middlewares: readonly Middleware[],
  url: string,
  method: 'GET' | 'POST' = 'GET',
  headers: Readonly<Record<string, string>> = {},
) {
  const result = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '' as string | Uint8Array,
  };
  for (const middleware of middlewares) {
    let next = false;
    await middleware(
      { url, method, headers },
      {
        get statusCode() {
          return result.statusCode;
        },
        set statusCode(value: number) {
          result.statusCode = value;
        },
        setHeader(name, value) {
          result.headers[name] = value;
        },
        end(body) {
          result.body = body ?? '';
        },
      },
      () => {
        next = true;
      },
    );
    if (!next) break;
  }
  return result;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for ScriptablePack rebuild');
}

const SCRIPTABLE_PACK_INTEGRATION_TIMEOUT_MS = 60_000;

const ALL_KINDS = [
  'mesh',
  'material',
  'scene',
  'texture',
  'equirect',
  'sampler',
  'font',
  'render-pipeline',
  'tileset',
  'video',
  'skeleton',
  'skin',
  'animation-clip',
  'animation-graph',
  'audio',
  'particle-effect',
] as const;

const ALL_KIND_PACKAGE_ID = (() => {
  const parsed = PackageId.parse('019ffa97-9000-7000-8000-000000000099');
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();

const ALL_KIND_GUIDS = Object.fromEntries(
  ALL_KINDS.map((kind) => [kind, AssetGuid.format(AssetGuid.derive(ALL_KIND_PACKAGE_ID, kind))]),
) as Record<(typeof ALL_KINDS)[number], string>;

function packageId(value: string): PackageId {
  const parsed = PackageId.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

const GENERATED_PACKAGE_ID_TEXT = '019ffa97-0000-7000-8000-000000000000';
const GENERATED_PACKAGE_ID = packageId(GENERATED_PACKAGE_ID_TEXT);
const GENERATED_GUID = AssetGuid.format(AssetGuid.derive(GENERATED_PACKAGE_ID, 'scene'));
const DEPENDENCY_PACKAGE_ID_TEXT = '019ffa97-0000-7000-8000-000000000028';
const DEPENDENCY_PACKAGE_ID = packageId(DEPENDENCY_PACKAGE_ID_TEXT);
const DEPENDENCY_GUID = AssetGuid.format(AssetGuid.derive(DEPENDENCY_PACKAGE_ID, 'audio'));
const DEPENDENCY_GUID_BYTES = [...AssetGuid.derive(DEPENDENCY_PACKAGE_ID, 'audio')];
const DERIVED_PACKAGE_ID_TEXT = '019ffa97-0000-7000-8000-00000000003d';
const DERIVED_PACKAGE_ID = packageId(DERIVED_PACKAGE_ID_TEXT);
const DERIVED_GUID = AssetGuid.format(AssetGuid.derive(DERIVED_PACKAGE_ID, 'scene'));

function allKindsSource(particleProgram: ParticleEffectAsset['program']): string {
  return `
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ok } from '@forgeax/engine-types';
import type {
  AnimationClip,
  AnimationGraph,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  MaterialAsset,
  MeshAsset,
  ParticleEffectAsset,
  RenderPipelineAsset,
  SamplerAsset,
  SceneAsset,
  SkeletonAsset,
  SkinAsset,
  TextureAsset,
  TilesetAsset,
  VideoAsset,
} from '@forgeax/engine-types';

const parseGuid = (value: string) => {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const packageId = parseGuid('019ffa97-9000-7000-8000-000000000099');
const guid = (sourceKey: string) => AssetGuid.format(AssetGuid.derive(packageId, sourceKey));
const assetGuid = (sourceKey: string) => parseGuid(guid(sourceKey));
const ids = {
  mesh: assetGuid('mesh'),
  material: assetGuid('material'),
  scene: assetGuid('scene'),
  texture: assetGuid('texture'),
  equirect: assetGuid('equirect'),
  sampler: assetGuid('sampler'),
  font: assetGuid('font'),
  'render-pipeline': assetGuid('render-pipeline'),
  tileset: assetGuid('tileset'),
  video: assetGuid('video'),
  skeleton: assetGuid('skeleton'),
  skin: assetGuid('skin'),
  'animation-clip': assetGuid('animation-clip'),
  'animation-graph': assetGuid('animation-graph'),
  audio: assetGuid('audio'),
  'particle-effect': assetGuid('particle-effect'),
};
const build = async () => {
  return ok({
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array([
        0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0,
        1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0,
        0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0,
      ]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {
        position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uv: new Float32Array([0, 0, 1, 0, 0, 1]),
        tangent: new Float32Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]),
      },
      submeshes: [{ topology: 'triangle-list', indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0 }],
      materialSlots: [{ slotName: 'default' }],
    },
    material: {
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::default-unlit' } }],
      values: { roughness: 0.5 },
    },
    scene: { kind: 'scene', entities: [] },
    texture: {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      data: new Uint8Array([255, 255, 255, 255]),
      colorSpace: 'srgb',
      mips: { kind: 'none' },
    },
    equirect: {
      kind: 'equirect', width: 1, height: 1, format: 'rgba16float',
      data: new Uint8Array(8), colorSpace: 'linear',
    },
    sampler: { kind: 'sampler', magFilter: 'linear' },
    font: {
      kind: 'font', atlas: ids.texture, sampler: ids.sampler, glyphs: {},
      common: { lineHeight: 1, base: 1, distanceRange: 4, pxRange: 4, atlasWidth: 1, atlasHeight: 1 },
    },
    'render-pipeline': { kind: 'render-pipeline', pipelineId: 'forgeax::standard' },
    tileset: {
      kind: 'tileset', atlases: [AssetGuid.format(ids.texture)], tileWidth: 1, tileHeight: 1,
      columns: 1, rows: 1, regions: [{ x: 0, y: 0, width: 1, height: 1 }], tiles: [{ regionIndex: 0 }],
    },
    video: { kind: 'video', url: 'https://example.test/video.webm' },
    skeleton: { kind: 'skeleton', inverseBindMatrices: new Float32Array(16), jointCount: 1 },
    skin: { kind: 'skin', skeletonGuid: AssetGuid.format(ids.skeleton), jointPaths: ['root'] },
    'animation-clip': { kind: 'animation-clip', duration: 1, channels: [] },
    'animation-graph': {
      kind: 'animation-graph', nodes: [{ type: 'clip', clip: AssetGuid.format(ids['animation-clip']), weight: 1 }], root: 0,
    },
    audio: { kind: 'audio', sourceKey: 'external/audio', mediaType: 'audio/wav', bytes: new Uint8Array([82, 73, 70, 70]) },
    'particle-effect': {
      kind: 'particle-effect', schemaVersion: 3, programFingerprint: ${JSON.stringify(particleProgram.fingerprint)},
      emitters: ${JSON.stringify(particleProgram.emitters.map(({ id, capacity }) => ({ id, capacity })))}, program: ${JSON.stringify(particleProgram)},
    },
  });
};

export default {
  schemaVersion: '2.0.0',
  packageId,
  build,
};
`;
}

async function cookExternalParticleProgram(): Promise<ParticleEffectAsset['program']> {
  const cooked = await cookParticleCodeEffect(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'default',
          capacity: 16,
          backend: { required: 'gpu' },
          space: 'local',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
          schedule: { rate: 2 },
          program: { module: PARTICLE_CODE_DEFAULT_MODULE_ID },
          renderers: [{ kind: 'billboard', material: ALL_KIND_GUIDS.material }],
          simulationWhenCulled: 'pause',
        },
      ],
    },
    {},
  );
  if (!cooked.ok) throw new Error(cooked.error.hint);
  const program = JSON.parse(
    JSON.stringify({
      format: 'forgeax-vfx-program-4' as const,
      emitters: cooked.value.artifact.program.emitters,
    }),
  ) as ParticleEffectAsset['program'];
  const bytes = new TextEncoder().encode(canonical(program));
  return {
    ...program,
    fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

interface ScopedCatalog {
  readonly entries: readonly PackIndexEntry[];
}

async function waitForCatalogRevision(
  middlewares: readonly Middleware[],
  url: string,
  previousDigest: string,
): Promise<ScopedCatalog> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await request(middlewares, url);
    const snapshot = JSON.parse(String(response.body)) as ScopedCatalog;
    if (snapshot.entries[0]?.revision?.digest !== previousDigest) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for a fresh ScriptablePack Catalog revision');
}

describe.sequential('ScriptablePack Vite publication', () => {
  it('rejects an edited source captured before the initial Pack scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-stale-snapshot-'));
    const source = join(root, 'scene.pack.ts');
    const authored = (marker: number) => `export default {
      schemaVersion: '2.0.0',
      packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,0]),
      build: () => ({ ok: true, value: { scene: { kind: 'scene', entities: [], marker: ${marker} } } }),
    };`;
    await writeFile(source, authored(1));
    const snapshot = createScriptablePackSourceSnapshot();
    await snapshot.inventory(source);
    await writeFile(source, authored(2));
    const plugin = createPluginPackInternal({
      roots: [root],
      watch: false,
      takeInitialSourceSnapshot: () => snapshot,
    });
    try {
      plugin.configureServer({
        middlewares: { use: () => {} },
        ws: { send: () => {} },
      });
      await expect(plugin.ready()).rejects.toBeDefined();
      expect(plugin.catalogSnapshot()).toEqual([]);
    } finally {
      await plugin.closeBundle();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the preparation snapshot once and reads fresh source on a later generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-initial-snapshot-'));
    const source = join(root, 'scene.pack.ts');
    const authored = (marker: number, packageSuffix = 0) => `export default {
      schemaVersion: '2.0.0',
      packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,${packageSuffix}]),
      build: () => ({ ok: true, value: { scene: { kind: 'scene', entities: [], marker: ${marker} } } }),
    };`;
    await writeFile(source, authored(1));
    const snapshot = createScriptablePackSourceSnapshot();
    await snapshot.inventory(source);
    const inventory = vi.spyOn(snapshot, 'inventory');
    // Directory discovery stays live even though existing source bytes are shared.
    await writeFile(join(root, 'sibling.pack.ts'), authored(3, 1));
    const plugin = createPluginPackInternal({
      roots: [root],
      watch: false,
      takeInitialSourceSnapshot: () => snapshot,
    });
    try {
      plugin.configureServer({
        middlewares: { use: () => {} },
        ws: { send: () => {} },
      });
      await plugin.ready();
      expect(inventory).toHaveBeenCalled();
      expect(plugin.catalogSnapshot()).toHaveLength(2);
      const calls = inventory.mock.calls.length;
      const binding = createStandaloneRuntimeAssetBinding('initial-snapshot');
      await plugin.rebind(binding, [root]);
      const first = plugin
        .catalogSnapshot()
        .find((entry) => entry.sourcePath.endsWith('/scene.pack.ts'))?.revision?.digest;
      expect(first).toBeDefined();
      await writeFile(source, authored(2));
      expect(await plugin.rebuildCatalogInPlace([source])).toBe(true);
      expect(
        plugin.catalogSnapshot().find((entry) => entry.sourcePath.endsWith('/scene.pack.ts'))
          ?.revision?.digest,
      ).not.toBe(first);
      expect(inventory).toHaveBeenCalledTimes(calls);
    } finally {
      await plugin.closeBundle();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an accepted Pack authoritative when a later file notification has identical bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-duplicate-notification-'));
    const source = join(root, 'scene.pack.ts');
    const authored = (marker: number) => `export default {
      schemaVersion: '2.0.0',
      packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,0]),
      build: () => ({ ok: true, value: { scene: { kind: 'scene', entities: [], marker: ${marker} } } }),
    };`;
    const plugin = createPluginPackInternal({ roots: [root], watch: false });
    try {
      await writeFile(source, authored(1));
      const middlewares: Middleware[] = [];
      plugin.configureServer({
        middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
        ws: { send: () => {} },
      });
      const binding = createStandaloneRuntimeAssetBinding('duplicate-notification');
      await plugin.rebind(binding, [root]);
      const catalog = async () =>
        JSON.parse(String((await request(middlewares, binding.catalogUrl)).body));
      const baseline = await catalog();
      expect(baseline.authority).toBe('authoritative');

      await writeFile(source, authored(2));
      await plugin.rebuildCatalogInPlace([source]);
      const revised = await catalog();
      expect(revised.authority).toBe('authoritative');
      expect(revised.entries[0].revision.digest).not.toBe(baseline.entries[0].revision.digest);

      // A queued watch batch can arrive after the producer already read these
      // bytes. The explicit content-refresh route uses the same batch applier.
      await plugin.rebuildCatalogInPlace([source]);
      const repeated = await catalog();
      expect(repeated.authority).toBe('authoritative');
      expect(repeated.entries).toEqual(revised.entries);
      expect(repeated.diagnostics).toEqual([]);
    } finally {
      await plugin.closeBundle();
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    'loads the exact 16-kind external consumer from a production Pack URL',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-all-kinds-'));
      const assets = join(root, 'assets');
      const originalFetch = globalThis.fetch;
      try {
        await mkdir(assets);
        await mkdir(join(root, 'node_modules', '@forgeax'), { recursive: true });
        await symlink(
          join(repositoryRoot, 'packages', 'pack', 'node_modules', 'uuidv7'),
          join(root, 'node_modules', 'uuidv7'),
          'dir',
        );
        await symlink(
          join(repositoryRoot, 'packages', 'pack'),
          join(root, 'node_modules', '@forgeax', 'engine-pack'),
          'dir',
        );
        await symlink(
          join(repositoryRoot, 'packages', 'types'),
          join(root, 'node_modules', '@forgeax', 'engine-types'),
          'dir',
        );
        const particleProgram = await cookExternalParticleProgram();
        await writeFile(join(assets, 'all-kinds.pack.ts'), allKindsSource(particleProgram));
        const plugin = createPluginPackInternal({ roots: [assets] });
        const emitted = new Map<string, string | Uint8Array>();
        await plugin.generateBundle.call({
          emitFile(asset) {
            const fileName = asset.fileName ?? asset.name ?? 'asset';
            emitted.set(fileName, asset.source);
            return fileName;
          },
          getFileName(referenceId) {
            return referenceId;
          },
        });
        await plugin.closeBundle();

        const index = decodeCatalogWire(
          JSON.parse(String(emitted.get('pack-index.json'))),
        ).unwrap() as readonly PackIndexEntry[];
        expect(new Set(index.map((entry) => entry.kind))).toEqual(new Set(ALL_KINDS));
        for (const entry of index) {
          expect(entry.packageUrl).toMatch(/^\/assets\/[^/]+\.pack\.json$/);
          expect(entry.cookReceiptUrl).toMatch(/^\/assets\/[^/]+\.receipt\.json$/);
          expect(entry.revision?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(entry.refs).toBeDefined();
        }
        const packs = new Map<
          string,
          {
            readonly assets: readonly {
              readonly guid: string;
              readonly kind: string;
              readonly refs: readonly string[];
              readonly artifacts?: Readonly<Record<string, unknown>>;
            }[];
          }
        >();
        for (const entry of index) {
          const path = new URL(entry.packageUrl, 'https://production.test').pathname.slice(1);
          const source = emitted.get(path);
          expect(source, `production Pack ${path}`).toBeDefined();
          packs.set(
            entry.guid,
            JSON.parse(typeof source === 'string' ? source : new TextDecoder().decode(source)),
          );
        }
        expect(new Set(index.map((entry) => entry.packageUrl)).size).toBe(1);
        expect(new Set(index.map((entry) => entry.cookReceiptUrl)).size).toBe(ALL_KINDS.length);
        expect([...packs.values()].some((pack) => pack.assets.length === ALL_KINDS.length)).toBe(
          true,
        );
        globalThis.fetch = async (input) => {
          const path = new URL(String(input), 'https://production.test').pathname.slice(1);
          const body = emitted.get(path);
          if (body === undefined) throw new Error(`missing emitted production asset: ${path}`);
          return new Response(typeof body === 'string' ? body : Buffer.from(body), { status: 200 });
        };
        const registry = createAssetRegistry({
          catalog: createCatalogSource({ entries: index }),
          fetcher: globalThis.fetch,
        });
        for (const contribution of defaultAssetDecoderContributions) {
          if (contribution.kind.kind === 'particle-effect') continue;
          registry.installDecoder(contribution.kind as never, contribution.decoder);
        }
        const vfxWorld = new World();
        const vfxHost = createVfxRuntimeHost({ camera: { read: () => undefined } });
        expect(await vfxHost.attachWorld({ world: vfxWorld, assets: registry })).toMatchObject({
          ok: true,
          value: { state: 'attached' },
        });
        const loadResults = await Promise.all([
          registry.load(ALL_KIND_GUIDS.mesh, 'mesh'),
          registry.load(ALL_KIND_GUIDS.material, 'material'),
          registry.load(ALL_KIND_GUIDS.scene, 'scene'),
          registry.load(ALL_KIND_GUIDS.texture, 'texture'),
          registry.load(ALL_KIND_GUIDS.equirect, 'equirect'),
          registry.load(ALL_KIND_GUIDS.sampler, 'sampler'),
          registry.load(ALL_KIND_GUIDS.font, 'font'),
          registry.load(ALL_KIND_GUIDS['render-pipeline'], 'render-pipeline'),
          registry.load(ALL_KIND_GUIDS.tileset, 'tileset'),
          registry.load(ALL_KIND_GUIDS.video, 'video'),
          registry.load(ALL_KIND_GUIDS.skeleton, 'skeleton'),
          registry.load(ALL_KIND_GUIDS.skin, 'skin'),
          registry.load(ALL_KIND_GUIDS['animation-clip'], 'animation-clip'),
          registry.load(ALL_KIND_GUIDS['animation-graph'], 'animation-graph'),
          registry.load(ALL_KIND_GUIDS.audio, 'audio'),
          loadVfxGpuEffect(registry, ALL_KIND_GUIDS['particle-effect']),
        ]);
        const [
          ,
          ,
          ,
          ,
          ,
          ,
          ,
          ,
          tilesetResult,
          ,
          ,
          ,
          animationClipResult,
          animationGraphResult,
          audioResult,
          particleResult,
        ] = loadResults;
        const loadedKinds = loadResults.map((result) => {
          if (!result.ok) throw result.error;
          return result.value.kind;
        });
        expect(loadedKinds).toEqual(ALL_KINDS);
        const loadedAssets = new Map<string, Asset>();
        for (const [index, result] of loadResults.entries()) {
          if (!result.ok) throw result.error;
          const kind = ALL_KINDS[index];
          if (kind === undefined) throw new Error(`missing test kind at index ${index}`);
          loadedAssets.set(ALL_KIND_GUIDS[kind].toLowerCase(), result.value);
        }
        const lookup = (guid: string): Asset | undefined => loadedAssets.get(guid.toLowerCase());
        const loadedParticle = await loadVfxGpuEffect(registry, ALL_KIND_GUIDS['particle-effect']);
        expect(loadedParticle).toMatchObject({ ok: true, value: { kind: 'particle-effect' } });
        if (loadedParticle.ok) {
          expect(loadedParticle.value.program.emitters[0]?.wgsl).toContain('@compute');
          expect(loadedParticle.value.program.emitters[0]?.reflection.entryPoints).toContain(
            'forgeax_vfx_spawn_main',
          );
        }
        if (!animationClipResult.ok || !animationGraphResult.ok) {
          throw new Error('animation assets did not load');
        }
        const animationWorld = new World();
        const resolvedClip = resolveAnimationAsset(
          animationWorld,
          ALL_KIND_GUIDS['animation-clip'],
          'animation-clip',
          lookup,
        );
        const resolvedGraph = resolveAnimationAsset(
          animationWorld,
          ALL_KIND_GUIDS['animation-graph'],
          'animation-graph',
          lookup,
        );
        expect(resolvedClip).toMatchObject({
          ok: true,
          value: { asset: { kind: 'animation-clip' } },
        });
        expect(resolvedGraph).toMatchObject({
          ok: true,
          value: { asset: { kind: 'animation-graph' } },
        });
        const firstGraphNode = animationGraphResult.value.nodes[0];
        expect(firstGraphNode?.type).toBe('clip');
        if (firstGraphNode?.type === 'clip') {
          expect(firstGraphNode.clip).toBe(ALL_KIND_GUIDS['animation-clip']);
        }

        if (!tilesetResult.ok) throw new Error('tileset asset did not load');
        const atlasGuid = tilesetResult.value.atlases[0];
        if (atlasGuid === undefined) throw new Error('tileset fixture has no atlas');
        const tileWorld = new World();
        const resolvedTileset = resolveTilesetRuntime(tileWorld, atlasGuid, lookup);
        expect(resolvedTileset).toMatchObject({
          ok: true,
          value: { payload: { kind: 'texture' } },
        });

        if (!audioResult.ok) throw new Error('audio asset did not load');
        const audioEngine = new WebAudioEngine();
        const decode = vi.spyOn(audioEngine, 'decode').mockResolvedValue({} as AudioBuffer);
        const play = vi.spyOn(audioEngine, 'play').mockImplementation(() => {});
        const audioConsumer = createHostAudioConsumer(audioEngine);
        audioConsumer.consume({
          kind: 'play',
          entityId: 1,
          sourceKey: audioResult.value.sourceKey,
          ...(audioResult.value.bytes
            ? { bytes: audioResult.value.bytes }
            : { stream: audioResult.value.stream }),
          options: { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' },
        });
        await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
        expect(decode).toHaveBeenCalledWith(audioResult.value.bytes);
        expect(play).toHaveBeenCalledWith(1, expect.anything(), {
          loop: false,
          volume: 1,
          spatialBlend: 0,
          bus: 'sfx',
        });
        audioConsumer.dispose();

        if (!particleResult.ok) throw new Error('particle-effect asset did not load');
        const effect = vfxWorld.allocSharedRef('ParticleEffectAsset', particleResult.value);
        const player = vfxWorld
          .spawn({
            component: ParticleEffectPlayer,
            data: { effect, playing: true, seed: 7, timeScale: 1 },
          })
          .unwrap();
        vfxWorld.update(1 / 60).unwrap();
        expect(vfxHost.inspect(vfxWorld)?.players.some((entry) => entry.player === player)).toBe(
          true,
        );
        expect(await vfxHost.detachWorld({ world: vfxWorld })).toMatchObject({
          ok: true,
          value: { state: 'detached' },
        });
        for (const [index, kind] of ALL_KINDS.entries()) {
          const guid = ALL_KIND_GUIDS[kind];
          const pack = packs.get(guid);
          const asset = pack?.assets.find((candidate) => candidate.guid === guid);
          expect(asset?.kind).toBe(kind);
          expect(asset?.refs).toBeDefined();
          expect(asset?.artifacts).toBeDefined();
          expect(loadedAssets.get(guid.toLowerCase())?.kind).toBe(kind);
          expect(loadResults[index]?.ok).toBe(true);
        }
        const devPlugin = createPluginPackInternal({ roots: [assets] });
        const middlewares: Middleware[] = [];
        devPlugin.configureServer({
          middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
          ws: { send: () => {} },
        });
        const binding = createStandaloneRuntimeAssetBinding('all-kinds-dev');
        await devPlugin.rebind(binding, [assets]);
        const devCatalog = JSON.parse(
          String((await request(middlewares, binding.catalogUrl)).body),
        ) as {
          readonly entries: readonly PackIndexEntry[];
        };
        expect(new Set(devCatalog.entries.map((entry) => entry.kind))).toEqual(new Set(ALL_KINDS));
        for (const guid of Object.values(ALL_KIND_GUIDS)) {
          const imported = await request(middlewares, `${binding.importUrlBase}/${guid}`, 'POST');
          expect(imported.statusCode).toBe(200);
          expect(JSON.parse(String(imported.body))).toEqual([
            expect.objectContaining({ guid, lifecycle: 'current' }),
          ]);
        }
        await devPlugin.closeBundle();
      } finally {
        globalThis.fetch = originalFetch;
        await rm(root, { recursive: true, force: true });
      }
    },
    SCRIPTABLE_PACK_INTEGRATION_TIMEOUT_MS,
  );

  it(
    'discovers, emits Pack v2 from ScriptablePack sources, and publishes current Catalog rows',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-vite-'));
      try {
        await mkdir(join(root, 'assets'));
        await writeFile(
          join(root, 'assets', 'generated.pack.ts'),
          `const packageId = new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,0]);
export default {
  schemaVersion: '2.0.0',
  packageId,
  build: () => ({ ok: true, value: { scene: { kind: 'scene', entities: [] } } }),
};\n`,
        );
        const plugin = createPluginPackInternal({ roots: [join(root, 'assets')] });
        const emitted = new Map<string, string | Uint8Array>();
        await plugin.generateBundle.call({
          emitFile(asset) {
            const key = asset.fileName ?? `assets/${asset.name ?? 'asset'}`;
            emitted.set(key, asset.source);
            return key;
          },
          getFileName(referenceId) {
            return referenceId;
          },
        });
        await plugin.closeBundle();

        const catalog = decodeCatalogWire(
          JSON.parse(String(emitted.get('pack-index.json'))),
        ).unwrap() as readonly PackIndexEntry[];
        expect(catalog).toHaveLength(1);
        expect(catalog[0]).toMatchObject({
          guid: GENERATED_GUID,
          packageUrl: `/assets/${GENERATED_PACKAGE_ID_TEXT}.pack.json`,
          cookReceiptUrl: `/assets/${GENERATED_GUID}.receipt.json`,
          revision: {
            digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            observedAt: expect.any(Number),
          },
          lifecycle: 'current',
        });
        const publicationSourcePath = catalog[0]?.sourcePath;
        expect(catalog[0]?.publication).toMatchObject({
          schemaVersion: 'asset-publication/1',
          sourcePath: publicationSourcePath,
          sourceRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          generation: expect.any(Number),
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          outputSetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          outputs: [
            expect.objectContaining({
              guid: GENERATED_GUID,
              sourceKey: 'scene',
              kind: 'scene',
              digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
              refs: [],
            }),
          ],
          receipt: expect.objectContaining({
            schemaVersion: 'asset-publication-receipt/1',
            sourcePath: publicationSourcePath,
            sourceRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            inputFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            outputDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            outputSetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          }),
          current: expect.objectContaining({
            generation: expect.any(Number),
            packageUrl: `/assets/${GENERATED_PACKAGE_ID_TEXT}.pack.json`,
          }),
        });
        expect(catalog[0]?.publication?.current).toMatchObject({
          packageUrl: `/assets/${GENERATED_PACKAGE_ID_TEXT}.pack.json`,
          generation: expect.any(Number),
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          outputSetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        });
        expect(catalog[0]?.revision?.rootId).toBe(catalog[0]?.sourcePath);
        const receipt = JSON.parse(
          String(emitted.get(`assets/${GENERATED_GUID}.receipt.json`)),
        ) as {
          readonly guid: string;
          readonly origin: string;
          readonly status: string;
          readonly inputFingerprint: string;
          readonly outputDigest: string;
        };
        expect(receipt).toMatchObject({
          guid: GENERATED_GUID,
          origin: 'authoredPack',
          status: 'succeeded',
        });
        expect(receipt.inputFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(receipt.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        const packSource = emitted.get(`assets/${GENERATED_PACKAGE_ID_TEXT}.pack.json`);
        if (packSource === undefined) throw new Error('missing emitted ScriptablePack body');
        const pack = JSON.parse(
          typeof packSource === 'string' ? packSource : new TextDecoder().decode(packSource),
        ) as {
          readonly assets: readonly {
            readonly guid: string;
            readonly kind: string;
            readonly refs: readonly string[];
            readonly artifacts: Readonly<Record<string, unknown>>;
          }[];
        };
        expect(pack.assets).toEqual([
          expect.objectContaining({
            guid: GENERATED_GUID,
            kind: 'scene',
            refs: [],
            artifacts: {},
          }),
        ]);

        const secondEmitted = new Map<string, string | Uint8Array>();
        const secondPlugin = createPluginPackInternal({ roots: [join(root, 'assets')] });
        await secondPlugin.generateBundle.call({
          emitFile(asset) {
            const key = asset.fileName ?? `assets/${asset.name ?? 'asset'}`;
            secondEmitted.set(key, asset.source);
            return key;
          },
          getFileName(referenceId) {
            return referenceId;
          },
        });
        await secondPlugin.closeBundle();
        expect([...secondEmitted.entries()]).toEqual([...emitted.entries()]);

        const devPlugin = createPluginPackInternal({ roots: [join(root, 'assets')] });
        const middlewares: Middleware[] = [];
        devPlugin.configureServer({
          middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
          ws: { send: () => {} },
        });
        const binding = createStandaloneRuntimeAssetBinding('scriptable-parity');
        await devPlugin.rebind(binding, [join(root, 'assets')]);
        const snapshot = JSON.parse(
          String((await request(middlewares, binding.catalogUrl)).body),
        ) as {
          readonly entries: readonly PackIndexEntry[];
        };
        const devRow = snapshot.entries[0];
        expect(devRow).toMatchObject({
          guid: catalog[0]?.guid,
          lifecycle: 'current',
          revision: catalog[0]?.revision,
        });
        const devPack = JSON.parse(
          String(
            await request(middlewares, devRow?.packageUrl ?? '').then((result) => result.body),
          ),
        ) as {
          readonly assets: readonly {
            readonly guid: string;
            readonly kind: string;
            readonly payload: unknown;
            readonly refs: readonly string[];
            readonly artifacts?: Readonly<
              Record<
                string,
                {
                  readonly path: string;
                  readonly mediaType: string;
                  readonly byteLength: number;
                  readonly integrity: unknown;
                }
              >
            >;
          }[];
        };
        const productionPack = JSON.parse(
          typeof packSource === 'string' ? packSource : new TextDecoder().decode(packSource),
        ) as typeof devPack;
        const semantic = (pack: typeof devPack) =>
          pack.assets.map((asset) => ({
            guid: asset.guid,
            kind: asset.kind,
            payload: asset.payload,
            refs: asset.refs,
            artifacts: Object.fromEntries(
              Object.entries(asset.artifacts ?? {}).map(([key, descriptor]) => [
                key,
                {
                  mediaType: descriptor.mediaType,
                  byteLength: descriptor.byteLength,
                  integrity: descriptor.integrity,
                },
              ]),
            ),
          }));
        expect(semantic(devPack)).toEqual(semantic(productionPack));
        await devPlugin.closeBundle();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    SCRIPTABLE_PACK_INTEGRATION_TIMEOUT_MS,
  );

  it('classifies pack sources as catalog-bearing watch inputs', () => {
    expect(classifyWatchedPath('generated.pack.ts')).toEqual({ kind: 'sidecar' });
    expect(classifyWatchedPath('helpers/geometry.ts')).toEqual({ kind: 'source' });
    expect(classifyWatchedPath('hud.ui.html')).toEqual({ kind: 'source' });
    expect(classifyWatchedPath('fonts/hud.woff2')).toEqual({ kind: 'source' });
  });

  it(
    'uses a published Pack payload for ScriptablePack content reads',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-generation-owner-'));
      const assets = join(root, 'assets');
      try {
        await mkdir(assets);
        await writeFile(
          join(assets, 'dependency.pack.ts'),
          [
            `const packageId = new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,40]);`,
            'export default {',
            "schemaVersion: '2.0.0', packageId,",
            "build: () => ({ ok: true, value: { audio: { kind: 'audio', sourceKey: 'dependency', mediaType: 'audio/wav', bytes: new Uint8Array([17]) } } }),",
            '};',
          ].join('\n'),
        );
        await writeFile(
          join(assets, 'derived.pack.ts'),
          [
            `const packageId = new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,61]);`,
            `const dependency = new Uint8Array(${JSON.stringify(DEPENDENCY_GUID_BYTES)});`,
            'export default {',
            "schemaVersion: '2.0.0', packageId,",
            'build: async ({ readByGuid }: { readByGuid: (guid: Uint8Array) => Promise<{ ok: true; value: { bytes: Uint8Array } } | { ok: false; error: unknown }> }) => {',
            '  const source = await readByGuid(dependency);',
            '  if (!source.ok) return source;',
            "  return { ok: true, value: { scene: { kind: 'scene', entities: [], marker: source.value.bytes[0] } } };",
            '},',
            '};',
          ].join('\n'),
        );
        const plugin = createPluginPackInternal({ roots: [assets] });
        const middlewares: Middleware[] = [];
        plugin.configureServer({
          middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
          ws: { send: () => {} },
        });
        const binding = createStandaloneRuntimeAssetBinding('scriptable-generation-owner');
        await plugin.rebind(binding, [assets]);
        const catalog = await request(middlewares, binding.catalogUrl);
        expect(catalog.statusCode).toBe(200);
        const snapshot = JSON.parse(String(catalog.body)) as {
          readonly entries: readonly PackIndexEntry[];
        };
        expect(snapshot.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ guid: DEPENDENCY_GUID }),
            expect.objectContaining({
              guid: DERIVED_GUID,
              lifecycle: 'current',
            }),
          ]),
        );
        const generatedRows = snapshot.entries.filter((entry) =>
          entry.sourcePath.endsWith('.pack.ts'),
        );
        expect(generatedRows).toHaveLength(2);
        const generatedPublication = generatedRows.find((entry) =>
          entry.sourcePath.endsWith('/derived.pack.ts'),
        )?.publication;
        expect(generatedPublication?.outputs).toEqual([
          expect.objectContaining({
            guid: DERIVED_GUID,
            sourceKey: 'scene',
          }),
        ]);
        expect(generatedPublication?.current).toMatchObject({
          packageUrl: expect.stringMatching(/\.pack\.json$/),
          generation: expect.any(Number),
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          outputSetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        });
        await plugin.closeBundle();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    SCRIPTABLE_PACK_INTEGRATION_TIMEOUT_MS,
  );

  it('keeps the prior accepted Pack readable when a later ScriptablePack fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-dev-atomic-'));
    const assets = join(root, 'assets');
    const source = (lastByte: number, marker: number, fail = false) => `
const packageId = new Uint8Array([...Array(15).fill(0), ${lastByte + 20}]);
export default {
  schemaVersion: '2.0.0', packageId,
  build: ${fail ? "() => ({ ok: false, error: { code: 'fixture-domain-failed', expected: 'the staged Pack to build', hint: 'repair the fixture and rebuild' } })" : `() => ({ ok: true, value: { scene: { kind: 'scene', entities: [], marker: ${marker} } } })`},
};
`;
    const plugin = createPluginPackInternal({ roots: [assets] });
    const middlewares: Middleware[] = [];
    try {
      await mkdir(assets);
      const firstPath = join(assets, 'a.pack.ts');
      const secondPath = join(assets, 'b.pack.ts');
      await writeFile(firstPath, source(31, 1));
      await writeFile(secondPath, source(32, 1));
      plugin.configureServer({
        middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
        ws: { send: () => {} },
      });
      const binding = createStandaloneRuntimeAssetBinding('scriptable-atomic');
      await plugin.rebind(binding, [assets]);
      const initialResponse = await request(middlewares, binding.catalogUrl);
      const initial = JSON.parse(String(initialResponse.body)) as {
        readonly entries: readonly PackIndexEntry[];
      };
      expect(initial.entries).toHaveLength(2);
      const first = initial.entries.find((entry) => entry.sourcePath.endsWith('/a.pack.ts'));
      const second = initial.entries.find((entry) => entry.sourcePath.endsWith('/b.pack.ts'));
      if (first === undefined || second === undefined)
        throw new Error('ScriptablePack rows missing');
      await request(middlewares, `${binding.importUrlBase}/${first.guid}`, 'POST');
      await request(middlewares, `${binding.importUrlBase}/${second.guid}`, 'POST');
      const accepted = JSON.parse(
        String((await request(middlewares, binding.catalogUrl)).body),
      ) as {
        readonly entries: readonly PackIndexEntry[];
      };
      const acceptedFirst = accepted.entries.find((entry) => entry.guid === first.guid);
      if (acceptedFirst === undefined) {
        throw new Error('accepted ScriptablePack rows missing');
      }
      const acceptedPack = await request(middlewares, acceptedFirst.packageUrl);

      await writeFile(secondPath, source(32, 2, true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const failed = await request(middlewares, `${binding.importUrlBase}/${second.guid}`, 'POST', {
        'x-forgeax-import-mode': 'rebuild',
      });
      expect(failed.statusCode).toBe(422);
      expect(failed.body).toContain('source-package-failed');
      expect(failed.body).toContain('source-package-conversion-failed');
      expect((await request(middlewares, acceptedFirst.packageUrl)).body).toBe(acceptedPack.body);

      await writeFile(secondPath, source(32, 2));
      const retried = await request(
        middlewares,
        `${binding.importUrlBase}/${second.guid}`,
        'POST',
        { 'x-forgeax-import-mode': 'rebuild' },
      );
      expect(retried.statusCode).toBe(200);
      expect(JSON.parse(String(retried.body))).toEqual([
        expect.objectContaining({ guid: second.guid, lifecycle: 'current' }),
      ]);
    } finally {
      await plugin.closeBundle();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('times out a real worker build, preserves the healthy publication, and retries in a fresh generation', async () => {
    const root = await mkdtemp(join(process.cwd(), '.forgeax-m38-scriptable-dev-timeout-retry-'));
    const assets = join(root, 'assets');
    const sourcePath = join(assets, 'retry.pack.ts');
    const source = (buildBody: string) => `
const packageId = new Uint8Array([...Array(15).fill(0), 52]);
export default {
  schemaVersion: '2.0.0', packageId,
  build: ${buildBody},
};
`;
    const healthyBuild =
      "() => ({ ok: true, value: { scene: { kind: 'scene', entities: [], marker: 1 } } })";
    const correctedBuild =
      "() => ({ ok: true, value: { scene: { kind: 'scene', entities: [], marker: 2 } } })";
    const neverSettlesBuild = '() => new Promise(() => undefined)';
    const replaceSource = async (body: string) => {
      // Keep the watched inode stable: this test exercises timeout recovery and
      // fresh publication, not platform-specific atomic-save rename semantics.
      await writeFile(sourcePath, body);
    };
    const plugin = createPluginPackInternal({ roots: [assets] });
    const middlewares: Middleware[] = [];
    const wsCalls: Array<{ readonly type?: string }> = [];
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await mkdir(assets);
      await writeFile(sourcePath, source(healthyBuild));
      plugin.configureServer({
        middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
        ws: { send: (payload) => wsCalls.push(payload) },
      });
      const binding = createStandaloneRuntimeAssetBinding('scriptable-timeout-retry');
      await plugin.rebind(binding, [assets]);
      wsCalls.length = 0;
      warnings.mockClear();

      const beforeCatalog = await request(middlewares, binding.catalogUrl);
      const beforeSnapshot = JSON.parse(String(beforeCatalog.body)) as {
        readonly entries: readonly PackIndexEntry[];
      };
      const beforeEntry = beforeSnapshot.entries[0];
      const beforeDigest = beforeEntry?.revision?.digest;
      if (beforeDigest === undefined) throw new Error('healthy ScriptablePack row has no revision');
      const beforePackUrl = beforeEntry?.packageUrl;
      expect(beforePackUrl).toBeDefined();
      const beforePack = await request(middlewares, beforePackUrl ?? '');
      const isAssetChangedWarning = (call: readonly unknown[]) =>
        typeof call[0] === 'string' && call[0].startsWith('[forgeax-pack] assets changed:');

      const timeoutReloads = warnings.mock.calls.filter(isAssetChangedWarning).length;
      await replaceSource(source(neverSettlesBuild));
      const isBuildTimeoutWarning = (call: readonly unknown[]) => {
        if (call[0] !== '[forgeax-pack] rebuild state.catalog error:') return false;
        const failure = call[1];
        if (failure === null || typeof failure !== 'object') return false;
        const detail = (failure as { readonly detail?: unknown }).detail;
        return (
          detail !== null &&
          typeof detail === 'object' &&
          (detail as { readonly reason?: unknown }).reason === 'timeout'
        );
      };
      await waitFor(() => warnings.mock.calls.some(isBuildTimeoutWarning));
      await waitFor(
        () => warnings.mock.calls.filter(isAssetChangedWarning).length >= timeoutReloads + 1,
      );
      const timeoutCall = warnings.mock.calls.find(isBuildTimeoutWarning);
      expect(timeoutCall?.[1]).toMatchObject({
        code: 'pack-parameter-invalid',
        detail: {
          sourcePath,
          reason: 'timeout',
          phase: 'build',
          timeoutMs: 15_000,
          diagnostic: 'ScriptablePack build exceeded 15000ms',
        },
      });
      const afterTimeoutCatalog = await request(middlewares, binding.catalogUrl);
      const afterTimeoutPack = await request(middlewares, beforePackUrl ?? '');
      expect(JSON.parse(String(afterTimeoutCatalog.body))).toMatchObject({
        authority: 'degraded',
        entries: JSON.parse(String(beforeCatalog.body)).entries,
      });
      expect(afterTimeoutPack.body).toBe(beforePack.body);
      expect(wsCalls.some((payload) => payload.type === 'full-reload')).toBe(false);

      const retryReloads = warnings.mock.calls.filter(isAssetChangedWarning).length;
      await replaceSource(source(correctedBuild));
      await waitFor(
        () => warnings.mock.calls.filter(isAssetChangedWarning).length >= retryReloads + 1,
      );
      const afterRetrySnapshot = await waitForCatalogRevision(
        middlewares,
        binding.catalogUrl,
        beforeDigest,
      );
      expect(afterRetrySnapshot.entries).toHaveLength(1);
      const afterRetryEntry = afterRetrySnapshot.entries[0];
      const afterRetryPackUrl = afterRetryEntry?.packageUrl;
      expect(afterRetryPackUrl).toBeDefined();
      expect(afterRetryPackUrl).not.toBe(beforePackUrl);
      expect(afterRetryEntry?.revision?.digest).not.toBe(beforeEntry?.revision?.digest);
      const afterRetryPack = await request(middlewares, afterRetryPackUrl ?? '');
      expect(afterRetryPack.body).not.toBe(beforePack.body);
      expect(unhandled).toEqual([]);
    } finally {
      await plugin.closeBundle();
      process.off('unhandledRejection', onUnhandled);
      warnings.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
