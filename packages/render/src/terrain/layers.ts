import type { AssetChange } from '@forgeax/engine-assets-runtime/internal';
import type { RhiCommandEncoder, RhiDevice, Sampler, TextureView } from '@forgeax/engine-rhi';
import { terrainMaterialChannels } from '@forgeax/engine-terrain';
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import type { GpuResidencyCache } from '../device/gpu-residency';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { type RenderResourceScope, renderAsset } from '../publication/resource-scope';
import type { MaterialSnapshot } from '../render-system-extract';
import {
  type TerrainLayerArrays,
  TerrainLayerCache,
  type TerrainLayerInput,
  type TerrainLayerSelection,
} from './layer-cache';
import { type TerrainDrawSource, terrainSourceError } from './source';

interface MaterialRow {
  readonly id: number;
  readonly values: Float32Array;
}
interface Declaration {
  readonly heights: readonly number[];
}
interface LayerFrame {
  readonly selection: readonly TerrainLayerSelection[];
  readonly previous?: WeakRef<LayerFrame>;
}
interface Binding {
  readonly textureView: TextureView;
  readonly sampler: Sampler;
}
const CHANNELS = [
  'terrainColorLayers',
  'terrainNormalHeightLayers',
  'terrainOrmLayers',
  'terrainEmissionLayers',
] as const;
interface GpuFrame {
  readonly arrays: TerrainLayerArrays;
  track(completed: Promise<unknown>): void;
  release(completed?: Promise<unknown>): void;
}

/** Shared material facts follow the asset stream. Terrain instances hold no reverse dependencies. */
export class TerrainLayers {
  private scopes = new WeakMap<RenderResourceScope, Map<number, MaterialRow>>();
  private current = 0;
  private nextId = 1;
  private declarations = new WeakMap<TerrainDrawSource, Declaration>();
  private frames = new WeakMap<
    TerrainDrawSource,
    {
      readonly materials: number;
      readonly images: number;
      readonly frame: LayerFrame;
    }
  >();
  private readonly snapshots = new WeakMap<MaterialSnapshot, LayerFrame>();
  private readonly inputCache = new WeakMap<MaterialRow, TerrainLayerInput>();
  private readonly neutral: MaterialRow = {
    id: 0,
    values: new Float32Array([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
  };
  private device: RhiDevice | undefined;
  private gpu: LayerGpu | undefined;
  private store: GpuResidencyCache;
  constructor(
    private readonly getStore: () => GpuResidencyCache,
    private readonly getDevice: () => RhiDevice,
    private readonly shader: PipelineBuilderShaderModuleFactory,
  ) {
    this.store = getStore();
  }

  private syncStore(): void {
    const store = this.getStore();
    if (store === this.store) return;
    this.dispose();
    this.store = store;
    this.scopes = new WeakMap();
    this.declarations = new WeakMap();
    this.frames = new WeakMap();
    this.current++;
  }

  adopt(scope: RenderResourceScope, changes: readonly AssetChange[]): void {
    this.syncStore();
    const materials = this.scopes.get(scope);
    if (materials === undefined) return;
    for (const change of changes) {
      const before = materials.get(change.handle);
      if (before === undefined) continue;
      if (change.removed) {
        materials.delete(change.handle);
        this.current++;
      } else {
        const row = this.material(scope, change.handle, before.id);
        materials.set(change.handle, row);
        this.current++;
      }
    }
  }

  capture(scope: RenderResourceScope, source: TerrainDrawSource): LayerFrame {
    this.syncStore();
    let declaration = this.declarations.get(source);
    if (declaration === undefined) {
      const heights = Array<number>(source.layers.length).fill(0);
      for (let i = 0; i < source.layers.length; i++) {
        const layer = source.layers[i];
        if (layer === undefined) continue;
        const handle = Number(layer.material);
        let materials = this.scopes.get(scope);
        if (materials === undefined) {
          materials = new Map();
          this.scopes.set(scope, materials);
        }
        let row = materials.get(handle);
        if (row === undefined) {
          row = this.material(scope, handle, this.nextId++);
          materials.set(handle, row);
          this.current++;
        }
        if (layer.blend === 'height') {
          heights[i] = this.image(scope, Number(layer.height));
        }
      }
      declaration = { heights };
      this.declarations.set(source, declaration);
    }
    const images = this.store.imagePages.revision;
    const cached = this.frames.get(source);
    if (cached !== undefined && cached.materials === this.current && cached.images === images)
      return cached.frame;
    // Bounded author-roster admission, performed once per changed shared root;
    // there is no Material/Texture -> Terrain notification or section rebuilding.
    const referenced = new Set<number>();
    let bytes = 0;
    const selection: TerrainLayerSelection[] = [];
    const admit = (id: number, linear: boolean) => {
      if (id === 0) return;
      const image = this.store.imagePages.get(id);
      if (image === undefined || (linear && image.srgb))
        terrainSourceError(
          'terrain-layer-invalid',
          'layer image',
          'a resident source image, linear for data channels',
        );
      if (!referenced.has(id)) {
        referenced.add(id);
        bytes += image.width * image.height * 4;
      }
      return image;
    };
    for (const index of source.activeLayers) {
      const row = this.scopes.get(scope)?.get(Number(source.layers[index]?.material));
      if (row === undefined)
        terrainSourceError(
          'terrain-layer-invalid',
          'layer material',
          'a resident Standard material',
        );
      for (let channel = 0; channel < 5; channel++)
        admit(row.values[channel === 4 ? 13 : 16 + channel] ?? 0, channel > 0 && channel < 4);
      const heightId = declaration.heights[index] ?? 0;
      const height = admit(heightId, true);
      const layer = source.layers[index];
      if (layer === undefined)
        terrainSourceError('terrain-layer-invalid', 'layer index', 'an admitted author layer');
      selection.push({
        index,
        input: this.input(row),
        ...(height === undefined
          ? {}
          : {
              height,
              ...(layer.blend === 'height' ? { heightRange: layer.heightRange } : {}),
            }),
      });
    }
    if (bytes > 128 * 1024 * 1024)
      terrainSourceError(
        'terrain-layer-budget-exceeded',
        'layer image bytes',
        'at most 128 MiB of distinct active source images per Terrain',
      );
    selection.push({ index: -1, input: this.input(this.neutral) });
    const previous = cached?.frame;
    const frame =
      previous !== undefined &&
      previous.selection.length === selection.length &&
      selection.every((layer, index) => {
        const before = previous.selection[index];
        return (
          before !== undefined &&
          layer.index === before.index &&
          layer.input === before.input &&
          layer.height === before.height &&
          layer.heightRange === before.heightRange
        );
      })
        ? previous
        : { selection, ...(previous === undefined ? {} : { previous: new WeakRef(previous) }) };
    this.frames.set(source, { materials: this.current, images, frame });
    return frame;
  }

  bind(snapshot: MaterialSnapshot, frame: LayerFrame): void {
    this.snapshots.set(snapshot, frame);
  }
  texture(snapshot: MaterialSnapshot, parameter: string): Binding | undefined {
    const channel = CHANNELS.indexOf(parameter as (typeof CHANNELS)[number]);
    if (channel < 0) return undefined;
    const frame = this.snapshots.get(snapshot);
    return frame === undefined ? undefined : this.owner().capture(frame).arrays.bindings[channel];
  }
  detach(scope: RenderResourceScope): void {
    const materials = this.scopes.get(scope);
    if (materials !== undefined) this.current++;
    this.scopes.delete(scope);
    this.store.releaseImagePages(scope);
  }
  dispose(): void {
    this.gpu?.dispose();
    this.gpu = undefined;
    this.device = undefined;
  }

  private owner(): LayerGpu {
    this.syncStore();
    const device = this.getDevice();
    if (this.gpu === undefined || this.device !== device) {
      this.gpu?.dispose();
      this.device = device;
      this.gpu = new LayerGpu(device, this.store, this.shader);
    }
    return this.gpu;
  }
  private input(row: MaterialRow): TerrainLayerInput {
    const selected = Array.from({ length: 5 }, (_, channel) => {
      const image = this.store.imagePages.get(row.values[channel === 4 ? 13 : 16 + channel] ?? 0);
      if (image === undefined)
        terrainSourceError('terrain-layer-invalid', 'layer image', 'an admitted source image');
      return image;
    });
    const before = this.inputCache.get(row);
    if (before !== undefined && selected.every((image, index) => image === before.images[index]))
      return before;
    const input = { id: row.id, values: row.values, images: selected };
    this.inputCache.set(row, input);
    return input;
  }
  private material(scope: RenderResourceScope, handle: number, id: number): MaterialRow {
    const source = renderAsset<MaterialAsset>(scope, handle);
    if (source?.kind !== 'material')
      terrainSourceError(
        'terrain-layer-invalid',
        'layer material',
        'an admitted ordinary Standard material',
      );
    const channels = terrainMaterialChannels(source).unwrap();
    const values = new Float32Array(20);
    values.set(channels.values);
    if (channels.textures[1] === undefined) {
      values[8] = 0;
      values[9] = 0;
    }
    for (let index = 0; index < channels.textures.length; index++) {
      const reference = channels.textures[index];
      if (reference !== undefined)
        values[index === 4 ? 13 : 16 + index] = this.image(scope, Number(reference));
    }
    return { id, values };
  }
  private image(scope: RenderResourceScope, handle: number): number {
    const texture = renderAsset<TextureAsset>(scope, handle);
    if (texture?.kind !== 'texture')
      terrainSourceError('terrain-layer-invalid', 'layer image', 'an admitted Texture reference');
    return this.store.ensureImagePage(handle, texture, scope);
  }
}

/** Only actual prepared frames and queued GPU work retain derived arrays. */
class LayerGpu {
  private readonly cache: TerrainLayerCache;
  private readonly frames = new Map<LayerFrame, GpuFrame>();
  private used = new Map<LayerFrame, GpuFrame>();
  /** Prior actual uses become retirement candidates; reuse removes one in O(1). */
  private retiring = new Map<LayerFrame, GpuFrame>();
  private disposed = false;
  private readonly identities = new WeakMap<object, number>();
  private nextIdentity = 1;
  private readonly arrays = new Map<string, { arrays: TerrainLayerArrays; references: number }>();
  constructor(
    private readonly device: RhiDevice,
    private readonly store: GpuResidencyCache,
    shader: PipelineBuilderShaderModuleFactory,
  ) {
    this.cache = new TerrainLayerCache(device, store.imagePages, shader);
  }
  capture(frame: LayerFrame): GpuFrame {
    const cached = this.frames.get(frame);
    if (cached !== undefined) return this.use(frame, cached);
    const identity = (value: object | undefined) => {
      if (value === undefined) return 0;
      let id = this.identities.get(value);
      if (id === undefined) {
        id = this.nextIdentity++;
        this.identities.set(value, id);
      }
      return id;
    };
    const key = frame.selection
      .map((layer) =>
        [
          layer.index,
          identity(layer.input),
          identity(layer.height),
          ...(layer.heightRange ?? []),
        ].join(':'),
      )
      .join('/');
    let resident = this.arrays.get(key);
    if (resident === undefined) {
      const previous = frame.previous?.deref();
      resident = {
        arrays: this.cache.prepare(
          frame.selection,
          previous === undefined ? undefined : this.frames.get(previous)?.arrays,
        ),
        references: 0,
      };
      this.arrays.set(key, resident);
    }
    resident.references++;
    const selected = resident,
      arrays = resident.arrays;
    let submission: Promise<unknown> | undefined;
    let released = false;
    const result = {
      arrays,
      track: (done: Promise<unknown>) => {
        submission = done;
        arrays.life.track(done);
      },
      release: (done?: Promise<unknown>) => {
        if (released) return;
        released = true;
        done ??= submission;
        if (done !== undefined) arrays.life.track(done);
        if (--selected.references === 0) {
          this.arrays.delete(key);
          arrays.release();
        }
      },
    };
    this.frames.set(frame, result);
    return this.use(frame, result);
  }
  private use(frame: LayerFrame, gpu: GpuFrame): GpuFrame {
    this.retiring.delete(frame);
    this.used.set(frame, gpu);
    this.store.queueTextureProjection(this, this.device);
    return gpu;
  }
  encode(encoder: () => RhiCommandEncoder): { complete(submitted: boolean): void } | undefined {
    if (this.disposed || (this.used.size === 0 && this.retiring.size === 0 && !this.cache.pending))
      return undefined;
    const work = this.cache.pending ? this.cache.encode(encoder()) : undefined;
    const used = this.used,
      retiring = this.retiring;
    this.used = new Map();
    this.retiring = new Map();
    let settled = false;
    return {
      complete: (submitted) => {
        if (settled) return;
        settled = true;
        work?.complete(submitted);
        if (this.disposed) return;
        const completed = submitted ? this.device.queue.onSubmittedWorkDone() : undefined;
        // A binding made after preparation owns its use in the next transaction.
        // Only the prior-use candidates left untouched by actual bindings retire.
        for (const [frame, gpu] of retiring) {
          if (this.used.has(frame)) continue;
          this.frames.delete(frame);
          gpu.release(completed);
        }
        for (const [frame, gpu] of used) {
          if (completed !== undefined) gpu.track(completed);
          if (!this.used.has(frame)) this.retiring.set(frame, gpu);
        }
        if (this.retiring.size > 0 || this.used.size > 0 || this.cache.pending)
          this.store.queueTextureProjection(this, this.device);
      },
    };
  }
  dispose(): void {
    this.disposed = true;
    this.store.cancelTextureProjection(this);
    for (const gpu of this.frames.values()) gpu.release();
    this.frames.clear();
    this.used.clear();
    this.retiring.clear();
    this.cache.dispose();
  }
}
