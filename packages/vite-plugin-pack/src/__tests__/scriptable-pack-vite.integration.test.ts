import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { borrowAudioClip } from '@forgeax/engine-audio/internal';
import { createHostAudioConsumer, WebAudioEngine } from '@forgeax/engine-audio-webaudio';
import { World } from '@forgeax/engine-ecs';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { defaultAssetDecoderContributions } from '@forgeax/engine-runtime';
import {
  assetPublicationReceiptMatches,
  type BuiltinAssetKind,
  createStandaloneRuntimeAssetBinding,
  type PackIndexEntry,
  type PackV2,
  type ParticleEffectAsset,
} from '@forgeax/engine-types';
import {
  loadVfxGpuEffect,
  PARTICLE_CODE_DEFAULT_MODULE_ID,
  ParticleEffectPlayer,
} from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { metaFixture } from '../../../pack/src/__tests__/support/direct-pack-fixture.js';
import { classifyWatchedPath } from '../dev/revision-observer.js';
import { createPluginPackInternal } from '../plugin-pack.js';
import {
  capturePackMiddleware,
  type Middleware,
  requestMiddleware as request,
} from './middleware-fixture.js';
import { installPackAuthorDependencies } from './pack-author-dependencies.js';

function derivedAssetSource(readResult: string): string {
  return `
const packageId = new Uint8Array(${JSON.stringify([...DERIVED_PACKAGE_ID])});
const dependency = new Uint8Array(${JSON.stringify(DEPENDENCY_GUID_BYTES)});
export default {
  schemaVersion: '2.0.0', packageId,
  async build({ readByGuid }) {
    const source = await readByGuid(dependency);
    if (!source.ok) return source;
    return { ok: true, value: ${readResult} };
  },
};
`;
}

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
      format: 'forgeax-vfx-program-5' as const,
      emitters: cooked.value.artifact.program.emitters,
    }),
  ) as ParticleEffectAsset['program'];
  const bytes = new TextEncoder().encode(canonical(program));
  return {
    ...program,
    fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

async function waitForCatalogRevision(
  middlewares: readonly Middleware[],
  url: string,
  previousDigest: string,
): Promise<readonly PackIndexEntry[]> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await request(middlewares, url);
    const snapshot = JSON.parse(String(response.body));
    if (snapshot.authority === 'authoritative') {
      const entries = decodeCatalogWire(snapshot).unwrap();
      if (entries[0]?.revision?.digest !== previousDigest) return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for a fresh ScriptablePack Catalog revision');
}

async function emitProduction(assets: string) {
  const plugin = createPluginPackInternal({ roots: [assets] });
  const emitted = new Map<string, string | Uint8Array>();
  try {
    await plugin.generateBundle.call({
      emitFile(asset) {
        const name = asset.fileName ?? `assets/${asset.name ?? 'asset'}`;
        emitted.set(name, asset.source);
        return name;
      },
      getFileName: (referenceId) => referenceId,
    });
    return emitted;
  } finally {
    await plugin.closeBundle();
  }
}

async function withDevPublication<T>(
  assets: string,
  scope: string,
  verify: (
    middlewares: readonly Middleware[],
    binding: ReturnType<typeof createStandaloneRuntimeAssetBinding>,
  ) => Promise<T>,
): Promise<T> {
  const plugin = createPluginPackInternal({ roots: [assets] });
  const middlewares = capturePackMiddleware(plugin);
  try {
    const binding = createStandaloneRuntimeAssetBinding(scope);
    await plugin.rebind(binding, [assets]);
    return await verify(middlewares, binding);
  } finally {
    await plugin.closeBundle();
  }
}

function bundleJson<T>(emitted: ReadonlyMap<string, string | Uint8Array>, name: string): T {
  const body = emitted.get(name);
  if (body === undefined) throw new Error(`missing production asset ${name}`);
  return JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)) as T;
}

function authoredScene(marker: number, packageSuffix = 0): string {
  return `export default {
    schemaVersion: '2.0.0',
    packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,${packageSuffix}]),
    build: () => ({ ok: true, value: { scene: { kind: 'scene', entities: [], marker: ${marker} } } }),
  };`;
}

describe.sequential('ScriptablePack Vite publication', () => {
  it('rejects an edited source captured before the initial Pack scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-stale-snapshot-'));
    const source = join(root, 'scene.pack.ts');
    await writeFile(source, authoredScene(1));
    const snapshot = createScriptablePackSourceSnapshot();
    await snapshot.inventory(source);
    await writeFile(source, authoredScene(2));
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

  it('uses one preparation snapshot and keeps refreshed content authoritative across repeated notifications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-initial-snapshot-'));
    const source = join(root, 'scene.pack.ts');
    await writeFile(source, authoredScene(1));
    const snapshot = createScriptablePackSourceSnapshot();
    await snapshot.inventory(source);
    const inventory = vi.spyOn(snapshot, 'inventory');
    // Discovery remains live even when a source already has captured bytes.
    await writeFile(join(root, 'sibling.pack.ts'), authoredScene(3, 1));
    const plugin = createPluginPackInternal({
      roots: [root],
      watch: false,
      takeInitialSourceSnapshot: () => snapshot,
    });
    try {
      const middlewares = capturePackMiddleware(plugin);
      await plugin.ready();
      expect(inventory).toHaveBeenCalled();
      expect(plugin.catalogSnapshot()).toHaveLength(2);
      const calls = inventory.mock.calls.length;
      const binding = createStandaloneRuntimeAssetBinding('initial-snapshot');
      await plugin.rebind(binding, [root]);
      const catalog = async () =>
        JSON.parse(String((await request(middlewares, binding.catalogUrl)).body));
      const digest = (body: unknown) =>
        decodeCatalogWire(body)
          .unwrap()
          .find((entry) => entry.sourcePath.endsWith('/scene.pack.ts'))?.revision?.digest;

      const baseline = await catalog();
      expect(baseline.authority).toBe('authoritative');
      expect(digest(baseline)).toBeDefined();
      await writeFile(source, authoredScene(2));
      expect(await plugin.rebuildCatalogInPlace([source])).toBe(true);
      const revised = await catalog();
      expect(revised.authority).toBe('authoritative');
      expect(digest(revised)).toBeDefined();
      expect(digest(revised)).not.toBe(digest(baseline));
      expect(inventory).toHaveBeenCalledTimes(calls);

      await plugin.rebuildCatalogInPlace([source]);
      const repeated = await catalog();
      expect(repeated.authority).toBe('authoritative');
      expect(decodeCatalogWire(repeated).unwrap()).toEqual(decodeCatalogWire(revised).unwrap());
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
        await installPackAuthorDependencies(root);
        const particleProgram = await cookExternalParticleProgram();
        await writeFile(join(assets, 'all-kinds.pack.ts'), allKindsSource(particleProgram));
        const emitted = await emitProduction(assets);
        const index = decodeCatalogWire(bundleJson(emitted, 'pack-index.json')).unwrap();
        expect(index.map(({ kind }) => kind).sort()).toEqual([...ALL_KINDS].sort());
        const packageUrls = new Set(index.map(({ packageUrl }) => packageUrl));
        expect(packageUrls.size).toBe(1);
        const packageUrl = index[0]?.packageUrl ?? '';
        expect(packageUrl).toMatch(/^\/assets\/[^/]+\.runtime-pack\.json$/);
        const pack = bundleJson<PackV2>(emitted, packageUrl.slice(1));
        expect(pack.assets).toHaveLength(ALL_KINDS.length);
        expect(new Set(index.map(({ cookReceiptUrl }) => cookReceiptUrl)).size).toBe(
          ALL_KINDS.length,
        );
        for (const row of index) {
          expect(row).toMatchObject({
            cookReceiptUrl: expect.stringMatching(/^\/assets\/[^/]+\.receipt\.json$/),
            revision: { digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
            refs: expect.any(Array),
          });
        }
        globalThis.fetch = async (input) => {
          const path = new URL(String(input), 'https://production.test').pathname.slice(1);
          const body = emitted.get(path);
          if (body === undefined) throw new Error(`missing emitted production asset: ${path}`);
          return new Response(typeof body === 'string' ? body : Buffer.from(body), { status: 200 });
        };
        const registry = new AssetRegistry({
          catalog: createCatalogSource({ entries: index }),
          fetcher: globalThis.fetch,
        });
        for (const contribution of defaultAssetDecoderContributions) {
          if (contribution.kind.kind === 'particle-effect') continue;
          registry.installDecoder(contribution.kind as never, contribution.decoder);
        }
        const vfxWorld = new World({ assets: registry });
        const vfxHost = createVfxRuntimeHost({ camera: { read: () => undefined } });
        expect(await vfxHost.attachWorld({ world: vfxWorld, assets: registry })).toMatchObject({
          ok: true,
          value: { state: 'attached' },
        });
        const loadPayload = async <K extends BuiltinAssetKind>(guid: string, kind: K) => {
          const handle = (await registry.load(guid, kind)).unwrap();
          return registry.read(handle).unwrap();
        };
        const loaded = await Promise.all(
          ALL_KINDS.map((kind) => loadPayload(ALL_KIND_GUIDS[kind], kind)),
        );
        expect(loaded.map(({ kind }) => kind)).toEqual(ALL_KINDS);
        for (const kind of ALL_KINDS) {
          expect(pack.assets.find(({ guid }) => guid === ALL_KIND_GUIDS[kind])).toMatchObject({
            kind,
            refs: expect.any(Array),
            artifacts: expect.any(Object),
          });
        }

        for (const kind of ['audio', 'particle-effect'] as const) {
          const asset = pack.assets.find(({ guid }) => guid === ALL_KIND_GUIDS[kind]);
          expect(Object.keys(asset?.artifacts ?? {})).not.toHaveLength(0);
        }
        const video = pack.assets.find(({ guid }) => guid === ALL_KIND_GUIDS.video);
        expect(video?.payload).toMatchObject({
          kind: 'video',
          url: 'https://example.test/video.webm',
        });

        const loadedParticleHandle = await loadVfxGpuEffect(
          registry,
          ALL_KIND_GUIDS['particle-effect'],
        );
        const loadedParticle = loadedParticleHandle.ok
          ? registry.read(loadedParticleHandle.value)
          : loadedParticleHandle;
        expect(loadedParticle).toMatchObject({ ok: true, value: { kind: 'particle-effect' } });
        if (loadedParticle.ok) {
          expect(loadedParticle.value.program.emitters[0]?.wgsl).toContain('@compute');
          expect(loadedParticle.value.program.emitters[0]?.reflection.entryPoints).toContain(
            'forgeax_vfx_spawn_main',
          );
        }
        const graph = await loadPayload(ALL_KIND_GUIDS['animation-graph'], 'animation-graph');
        expect(graph.nodes[0]).toMatchObject({
          type: 'clip',
          clip: (await registry.load(ALL_KIND_GUIDS['animation-clip'], 'animation-clip')).unwrap(),
        });

        const tileset = await loadPayload(ALL_KIND_GUIDS.tileset, 'tileset');
        const atlas = tileset.atlases[0];
        if (typeof atlas !== 'number') throw new Error('missing admitted Tileset atlas');
        expect(registry.read(atlas)).toMatchObject({ ok: true, value: { kind: 'texture' } });

        const audio = await loadPayload(ALL_KIND_GUIDS.audio, 'audio');
        const audioEngine = new WebAudioEngine();
        const decode = vi.spyOn(audioEngine, 'decode').mockResolvedValue({} as AudioBuffer);
        const play = vi.spyOn(audioEngine, 'play').mockImplementation(() => {});
        const audioConsumer = createHostAudioConsumer(audioEngine);
        audioConsumer.consume({
          kind: 'play',
          asset: borrowAudioClip(
            registry,
            (await registry.load(ALL_KIND_GUIDS.audio, 'audio')).unwrap(),
          ).identity,
          entityId: 1,
          sourceKey: audio.sourceKey,
          ...(audio.bytes ? { bytes: audio.bytes } : { stream: audio.stream }),
          options: { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' },
        });
        await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
        expect(decode).toHaveBeenCalledWith(audio.bytes);
        expect(play).toHaveBeenCalledWith(1, expect.anything(), {
          loop: false,
          volume: 1,
          spatialBlend: 0,
          bus: 'sfx',
        });
        audioConsumer.dispose();

        const effect = (
          await registry.load(ALL_KIND_GUIDS['particle-effect'], 'particle-effect')
        ).unwrap();
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
        registry.dispose();
        await withDevPublication(assets, 'all-kinds-dev', async (middlewares, binding) => {
          const { body } = await request(middlewares, binding.catalogUrl);
          const rows = decodeCatalogWire(JSON.parse(String(body))).unwrap();
          expect(rows.map(({ kind }) => kind).sort()).toEqual([...ALL_KINDS].sort());
          for (const guid of Object.values(ALL_KIND_GUIDS)) {
            const imported = await request(middlewares, `${binding.importUrlBase}/${guid}`, 'POST');
            expect(imported.statusCode).toBe(200);
            expect(JSON.parse(String(imported.body))).toEqual([
              expect.objectContaining({ guid, lifecycle: 'current' }),
            ]);
          }
        });
      } finally {
        globalThis.fetch = originalFetch;
        await rm(root, { recursive: true, force: true });
      }
    },
    SCRIPTABLE_PACK_INTEGRATION_TIMEOUT_MS,
  );

  it(
    'emits deterministic production bytes and keeps dev and build evidence aligned',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-vite-'));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const path = `assets/${GENERATED_PACKAGE_ID_TEXT}.runtime-pack.json`;
      const receiptPath = `assets/${GENERATED_GUID}.receipt.json`;
      await writeFile(
        join(root, 'generated.pack.ts'),
        `export default {
        schemaVersion: '2.0.0',
        packageId: new Uint8Array(${JSON.stringify([...GENERATED_PACKAGE_ID])}),
        build: () => ({ ok: true, value: { scene: { kind: 'scene', entities: [] } } }),
      };`,
      );
      const emitted = await emitProduction(root);
      expect([...(await emitProduction(root))]).toEqual([...emitted]);
      const [row] = decodeCatalogWire(bundleJson(emitted, 'pack-index.json')).unwrap();
      if (!row?.publication) throw new Error('missing emitted scene publication');
      expect(row).toMatchObject({
        guid: GENERATED_GUID,
        packageUrl: `/${path}`,
        cookReceiptUrl: `/${receiptPath}`,
        revision: {
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          rootId: row.sourcePath,
        },
        lifecycle: 'current',
      });
      expect(assetPublicationReceiptMatches(row.publication)).toBe(true);
      expect(row.publication.outputs).toMatchObject([
        { guid: GENERATED_GUID, sourceKey: 'scene', kind: 'scene', refs: [] },
      ]);
      expect(row.publication.current).toMatchObject({
        packageUrl: row.packageUrl,
        generation: row.publication.generation,
      });
      expect(bundleJson(emitted, receiptPath)).toMatchObject({
        guid: GENERATED_GUID,
        origin: 'authoredPack',
        status: 'succeeded',
        inputFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        outputDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });

      const pack = bundleJson<PackV2>(emitted, path);
      expect(pack.assets).toMatchObject([
        { guid: GENERATED_GUID, kind: 'scene', refs: [], artifacts: {} },
      ]);
      await withDevPublication(root, 'scriptable-parity', async (middlewares, binding) => {
        const catalog = await request(middlewares, binding.catalogUrl);
        const [dev] = decodeCatalogWire(JSON.parse(String(catalog.body))).unwrap();
        expect(dev).toMatchObject({
          guid: row.guid,
          lifecycle: 'current',
          revision: row.revision,
        });
        const response = await request(middlewares, dev?.packageUrl ?? '');
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(String(response.body)).assets).toEqual(pack.assets);
      });
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
    'reads native Meta image content without importing unread sources',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-meta-content-'));
      const assets = join(root, 'assets');
      const derivedGuid = AssetGuid.format(AssetGuid.derive(DERIVED_PACKAGE_ID, 'texture'));
      const importImage = vi.spyOn(imageImporter, 'import');
      const plugin = createPluginPackInternal({
        roots: [assets],
        watch: false,
        producerReadiness: 'on-demand',
        importers: [imageImporter],
        ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc', 'v2') },
      });
      try {
        await mkdir(assets);
        await writeFile(
          join(assets, 'atlas.png'),
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ),
        );
        await writeFile(join(assets, 'unread.png'), 'invalid image');
        for (const [source, guid] of [
          ['atlas.png', DEPENDENCY_GUID],
          ['unread.png', GENERATED_GUID],
        ] as const) {
          await writeFile(
            join(assets, `${source}.meta.json`),
            metaFixture(
              source,
              'image',
              [{ guid, sourceIndex: 0, kind: 'texture', sourceKey: 'texture' }],
              { colorSpace: 'linear', mipmap: false, compressionMode: 'none' },
            ),
          );
        }
        await writeFile(
          join(assets, 'derived.pack.ts'),
          derivedAssetSource('{ texture: source.value }'),
        );
        const middlewares = capturePackMiddleware(plugin);
        const binding = createStandaloneRuntimeAssetBinding('scriptable-meta-content');
        await plugin.rebind(binding, [assets]);
        const catalog = await request(middlewares, binding.catalogUrl);
        expect(catalog.statusCode, String(catalog.body)).toBe(200);
        const snapshot = decodeCatalogWire(JSON.parse(String(catalog.body))).unwrap();
        const derived = snapshot.find((entry) => entry.guid === derivedGuid);
        expect(derived).toMatchObject({ lifecycle: 'current' });
        const body = await request(middlewares, derived?.packageUrl ?? '');
        expect(body.statusCode).toBe(200);
        const pack = JSON.parse(String(body.body));
        expect(pack.assets).toEqual([
          expect.objectContaining({
            guid: derivedGuid,
            payload: expect.objectContaining({
              kind: 'texture',
              format: 'rgba8unorm',
              colorSpace: 'linear',
              shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
            }),
          }),
        ]);
        const artifactUrl = new URL(
          pack.assets[0].artifacts.body.path,
          `http://forgeax.test${derived?.packageUrl ?? ''}`,
        ).pathname;
        const artifact = await request(middlewares, artifactUrl);
        expect(artifact.statusCode).toBe(200);
        expect(artifact.body).toEqual(new Uint8Array([0, 0, 0, 255]));
        expect(importImage).toHaveBeenCalled();
        expect(
          importImage.mock.calls.every(([context]) => context.source.endsWith('atlas.png')),
        ).toBe(true);
      } finally {
        await plugin.closeBundle();
        importImage.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
    SCRIPTABLE_PACK_INTEGRATION_TIMEOUT_MS,
  );

  it(
    'uses a published Pack payload for ScriptablePack content reads',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-generation-owner-'));
      const assets = join(root, 'assets');
      onTestFinished(() => rm(root, { recursive: true, force: true }));
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
        derivedAssetSource(
          "{ scene: { kind: 'scene', entities: [], marker: source.value.bytes[0] } }",
        ),
      );
      const plugin = createPluginPackInternal({ roots: [assets] });
      const middlewares = capturePackMiddleware(plugin);
      const binding = createStandaloneRuntimeAssetBinding('scriptable-generation-owner');
      await plugin.rebind(binding, [assets]);
      const catalog = await request(middlewares, binding.catalogUrl);
      expect(catalog.statusCode).toBe(200);
      const snapshot = decodeCatalogWire(JSON.parse(String(catalog.body))).unwrap();
      expect(snapshot).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ guid: DEPENDENCY_GUID }),
          expect.objectContaining({
            guid: DERIVED_GUID,
            lifecycle: 'current',
          }),
        ]),
      );
      const generatedRows = snapshot.filter((entry) => entry.sourcePath.endsWith('.pack.ts'));
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
        packageUrl: expect.stringMatching(/\.runtime-pack\.json$/),
        generation: expect.any(Number),
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        outputSetDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      await plugin.closeBundle();
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
      const initial = decodeCatalogWire(JSON.parse(String(initialResponse.body))).unwrap();
      expect(initial).toHaveLength(2);
      const first = initial.find((entry) => entry.sourcePath.endsWith('/a.pack.ts'));
      const second = initial.find((entry) => entry.sourcePath.endsWith('/b.pack.ts'));
      if (first === undefined || second === undefined)
        throw new Error('ScriptablePack rows missing');
      await request(middlewares, `${binding.importUrlBase}/${first.guid}`, 'POST');
      await request(middlewares, `${binding.importUrlBase}/${second.guid}`, 'POST');
      const accepted = decodeCatalogWire(
        JSON.parse(String((await request(middlewares, binding.catalogUrl)).body)),
      ).unwrap();
      const acceptedFirst = accepted.find((entry) => entry.guid === first.guid);
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
      const beforeSnapshot = decodeCatalogWire(JSON.parse(String(beforeCatalog.body))).unwrap();
      const beforeEntry = beforeSnapshot[0];
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
      expect(afterRetrySnapshot).toHaveLength(1);
      const afterRetryEntry = afterRetrySnapshot[0];
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
