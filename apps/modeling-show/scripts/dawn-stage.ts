import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { type AssetRegistry, createCatalogSource, createMaterialLoader } from '@forgeax/engine/assets-runtime';
import { animationPlugin } from '@forgeax/engine/animation';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { serializeCookedMaterialRecord, validateCookedMaterialRecord } from '@forgeax/engine/pack';
import { AssetGuid, type PackageId } from '@forgeax/engine/pack/guid';
import { createRuntimePackPublication } from '@forgeax/engine/pack/runtime';
import { type RenderTargetAuthoring, renderComponentsPlugin } from '@forgeax/engine/render';
import { constructRuntimeRendererHost } from '@forgeax/engine/runtime/internal/renderer-host';
import { scenePlugin } from '@forgeax/engine/scene';
import { createMaterialPackCooker } from '@forgeax/engine/shader-compiler';
import type { Asset, AssetHandle, MaterialAsset } from '@forgeax/engine/types';
import { buildEngineShaderManifest, publishShaderManifest } from '@forgeax/engine/vite-plugin-shader';
import { drawReadyFrame } from '../../../scripts/test/ready-render-frame.mjs';

/**
 * Dawn host of the Show for the smoke and the C-111 evidence: one real Renderer on an
 * offscreen canvas, a World with the Scene, Animation and render-component plugins,
 * and a readback of the presented frame. Pack outputs are built in-process; materials
 * go through the ordinary Cook and Catalog route (cooked Standard specializations),
 * other outputs become runtime assets with their GUID references resolved to handles,
 * as the Catalog would.
 */
export interface DawnStage {
  readonly world: World;
  readonly assets: AssetRegistry;
  /** Logical render target authoring of the real Renderer. */
  readonly renderTargets: RenderTargetAuthoring;
  /** Draw `count` ready frames after one World update of `dt` seconds each; returns RGBA of the last. */
  frame(dt: number, count?: number): Promise<Uint8Array>;
  readonly width: number;
  readonly height: number;
  errors(): readonly string[];
  dispose(): Promise<void>;
}

export async function createDawnStage(width: number, height: number): Promise<DawnStage> {
  const manifest = await buildEngineShaderManifest();
  const manifestUrl = URL.createObjectURL(
    new Blob(
      [JSON.stringify('toJSON' in manifest ? manifest : publishShaderManifest(manifest.entries, manifest.materialShaders))],
      { type: 'application/json' },
    ),
  );
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const gpu = globalThis.navigator.gpu;
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (adapterOptions) => {
    const adapter = await requestAdapter(adapterOptions);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const created = await requestDevice(descriptor);
      device ??= created;
      return created;
    };
    return adapter;
  };
  const canvas = {
    width,
    height,
    getContext: () => ({
      configure(configuration: GPUCanvasConfiguration) {
        target ??= configuration.device.createTexture({
          size: [width, height],
          format: configuration.format,
          usage: 0x11,
          viewFormats: [configuration.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
  try {
    host = await constructRuntimeRendererHost(canvas, {}, { shaderManifestUrl: manifestUrl });
  } finally {
    gpu.requestAdapter = requestAdapter;
  }
  if (!host.ok) throw host.error;
  const { renderer, assets } = host.value;
  const errors: string[] = [];
  renderer.subscribe?.((event: { kind: string }) => {
    if (event.kind === 'error') errors.push(JSON.stringify(event).slice(0, 600));
  });
  // One frame may cover a long stretch of the timeline (the smoke plays it in 60 frames).
  const world = new World({ assets, time: { maxDeltaSeconds: 10 } });
  await createWorldContext(world, [renderComponentsPlugin(), scenePlugin(), animationPlugin()]);
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  return {
    renderTargets: renderer,
    world,
    assets,
    width,
    height,
    errors: () => errors,
    async frame(dt, count = 1) {
      for (let i = 0; i < count; i++) {
        world.update(dt).unwrap();
        await drawReadyFrame(renderer, { leases: [lease], camera: { lease }, environment: { lease } });
      }
      if (device === undefined || target === undefined) throw new Error('device not captured');
      const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x0001 | 0x0008 });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height, 1]);
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      await buffer.mapAsync(0x0001);
      const padded = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      buffer.destroy();
      const bgra = target.format.startsWith('bgra');
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const s = y * bytesPerRow + x * 4;
          const o = (y * width + x) * 4;
          rgba[o] = padded[s + (bgra ? 2 : 0)] as number;
          rgba[o + 1] = padded[s + 1] as number;
          rgba[o + 2] = padded[s + (bgra ? 0 : 2)] as number;
          rgba[o + 3] = 255;
        }
      }
      return rgba;
    },
    dispose: async () => {
      await renderer.dispose();
    },
  };
}

async function cached<T>(directory: string, guid: string, source: unknown, cook: () => T | Promise<T>): Promise<T> {
  const key = createHash('sha256')
    .update(guid)
    .update(serialize(source))
    .digest('hex');
  const file = join(directory, `material-${key.slice(0, 24)}.bin`);
  if (existsSync(file)) return deserialize(readFileSync(file)) as T;
  const result = await cook();
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, serialize(result));
  return result;
}

/** Pack outputs by source key, as a Pack build returns them. */
export type PackOutputs = Readonly<Record<string, Asset>>;

/**
 * Register built Pack outputs: materials through Cook and a runtime Catalog
 * publication, everything else as runtime assets. Returns handles by GUID.
 */
export async function publishPackOutputs(
  assets: AssetRegistry,
  packs: readonly { readonly packageId: PackageId; readonly outputs: PackOutputs }[],
  /** Directory caching cooked materials by their source (a recorder re-runs the same Packs). */
  materialCache?: string,
): Promise<Map<string, AssetHandle>> {
  const handles = new Map<string, AssetHandle>();
  const entries = packs.flatMap(({ packageId, outputs }) =>
    Object.entries(outputs).map(([key, asset]) => ({ guid: AssetGuid.format(AssetGuid.derive(packageId, key)), asset })),
  );
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') return handles.get(value) ?? value;
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
    }
    return value;
  };
  // Textures and meshes first, then materials (their textures resolve through the Catalog), then scenes.
  const cooked: { guid: string; asset: Asset; refs: string[] }[] = [];
  const cooker = createMaterialPackCooker();
  for (const { guid, asset } of entries) {
    if (asset.kind === 'material') {
      const cook = () => cooker.cook({ guid, source: asset as MaterialAsset });
      const result = materialCache === undefined ? await cook() : await cached(materialCache, guid, asset, cook);
      const record = validateCookedMaterialRecord((result.payload as { readonly cooked: unknown }).cooked).unwrap();
      const ready = await createMaterialLoader({
        loadPublication: async () => ({
          guid,
          record,
          artifacts: Object.fromEntries(
            record.programs.map(({ artifact }) => [artifact.path, { mediaType: artifact.mediaType, bytes: artifact.bytes }]),
          ),
        }),
        loadReference: async () => true,
      }).load({ guid, specializationKey: record.specializationKey ?? '' });
      if (ready.status !== 'Ready') throw new Error(`material ${guid}: ${JSON.stringify(ready)}`);
      const r = ready.record;
      cooked.push({
        guid,
        refs: [...r.refs.parent, ...r.refs.textures, ...r.refs.samplers, ...r.refs.modules].filter(
          (reference) => AssetGuid.parse(reference).ok,
        ),
        asset: { kind: 'material', ...r.resolved, cooked: JSON.parse(serializeCookedMaterialRecord(r)) } as unknown as Asset,
      });
    } else if (asset.kind === 'texture') {
      cooked.push({ guid, asset, refs: [] });
    } else if (asset.kind !== 'scene') {
      handles.set(guid, assets.create(asset as never).unwrap() as AssetHandle);
    }
  }
  // One runtime publication per package: a whole program's textures in one JSON body
  // exceed the string limit.
  const byPackage = new Map<string, typeof cooked>();
  for (const entry of cooked) {
    const owner = packs.findIndex(({ packageId, outputs }) =>
      Object.keys(outputs).some((key) => AssetGuid.format(AssetGuid.derive(packageId, key)) === entry.guid),
    );
    byPackage.set(String(owner), [...(byPackage.get(String(owner)) ?? []), entry]);
  }
  const catalog: Exclude<Parameters<typeof createCatalogSource>[0]['entries'], undefined>[number][] = [];
  const bodies = new Map<string, string>();
  for (const [owner, members] of byPackage) {
    const packageUrl = `https://modeling-show.invalid/pack-${owner}.json`;
    const sourcePath = `show-${owner}.pack`;
    const publication = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath,
      sourceRevision: 'show',
      packageUrl,
      sourceKeys: new Map(),
      pack: {
        assets: members.map(({ guid, asset, refs }) => ({ guid, kind: asset.kind, payload: asset, refs, artifacts: {} })),
      },
    });
    bodies.set(
      packageUrl,
      JSON.stringify(publication.pack, (_key, value) => (ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value)),
    );
    for (const { guid, asset } of members) {
      catalog.push({ guid, kind: asset.kind, packageUrl, sourcePath, publication: publication.publication });
    }
  }
  if (catalog.length > 0) {
    assets.setCatalogSource(
      createCatalogSource({
        entries: catalog,
        fetch: async (url: string | URL | Request) => new Response(bodies.get(String(url instanceof Request ? url.url : url)) ?? ''),
      }),
    );
    for (const { guid, asset } of cooked) {
      if (asset.kind !== 'material') continue;
      const loaded = await assets.load(guid, 'material');
      if (!loaded.ok) throw loaded.error;
      handles.set(guid, loaded.value as AssetHandle);
    }
    // The JSON bodies (texture bytes as number arrays) are only needed for these loads.
    bodies.clear();
  }
  for (const { guid, asset } of entries) {
    if (asset.kind === 'scene') handles.set(guid, assets.create(resolve(asset) as never).unwrap() as AssetHandle);
  }
  return handles;
}
