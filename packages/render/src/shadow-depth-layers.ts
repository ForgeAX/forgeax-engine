import { type RhiDevice, RhiError, type Texture, type TextureView } from '@forgeax/engine-rhi';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from './gpu-texture-usage';
import {
  isStaticShadowProduct,
  StaticShadowMemory,
  type StaticShadowProduct,
} from './static-shadow-memory';

/**
 * Accesses of a retained shadow depth array: raster, sample and static-layer copies.
 */
export const SHADOW_DEPTH_LAYER_USAGE =
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
  GPU_TEXTURE_USAGE_COPY_SRC |
  GPU_TEXTURE_USAGE_COPY_DST |
  GPU_TEXTURE_USAGE_TEXTURE_BINDING;

/**
 * wgpu's GL backend maps a one-layer texture to TEXTURE_2D, which cannot be
 * sampled as `texture_depth_2d_array`; layered shadow maps keep two or more.
 */
export const MIN_SHADOW_ARRAY_LAYERS = 2;

interface ShadowDepthArray {
  readonly texture: Texture;
  readonly size: number;
  readonly format: 'depth32float' | 'rg16float';
  readonly layers: number;
  readonly views: Map<string, TextureView>;
  /** Layers whose raster reached a successful submit. */
  readonly retained: Set<number>;
  /** Layers rastered by the frame being staged. */
  readonly pending: Set<number>;
}

interface ShadowTextureRetirement {
  readonly texture: Texture;
  phase: 'pending' | 'destroying' | 'destroyed' | 'failed';
}

/**
 * Renderer-owned depth arrays behind retained shadow layers. Compiled graphs
 * import them instead of allocating them, so a recompile keeps every retained
 * layer and the view pool's cache decision still describes the depth behind
 * it. A layer counts as retained only after a submit that rastered it
 * succeeds; a fresh or replaced array holds none.
 */
export class ShadowDepthLayers {
  private readonly arrays = new Map<string, ShadowDepthArray>();
  private readonly retiring = new Map<Texture, ShadowTextureRetirement>();
  private readonly stagedShapes = new Map<string, ShadowDepthArray | undefined>();
  private stagingShapes = false;
  private retirementFailure: AggregateError | undefined;
  private disposed = false;

  private staticMemory?: StaticShadowMemory;

  constructor(private readonly device: RhiDevice) {}

  get staticPlan() {
    return this.staticMemory?.revision ? this.staticMemory : undefined;
  }

  beginStaticPlan(ceiling: number): StaticShadowMemory {
    this.requireCurrent();
    this.staticMemory ??= new StaticShadowMemory(this.device);
    this.staticMemory.begin(ceiling);
    return this.staticMemory;
  }

  admitStatic(label: StaticShadowProduct, size: number, layers: number): boolean {
    this.requireCurrent();
    return (
      this.residentTexture(label, size, layers) !== undefined ||
      this.staticMemory?.promise(label, size * size * layers * 4) === true
    );
  }

  /** Preserve admitted static depth while a replacement frame can still abort. */
  beginReplacement(): void {
    this.stagingShapes = true;
  }

  /** Borrow only an already issued physical view from this original array owner. */
  residentView(label: string, layer?: number, arrayLayerCount?: number): TextureView | undefined {
    const array = this.arrays.get(label);
    return this.disposed || array === undefined
      ? undefined
      : array.views.get(
          `${layer ?? 'array'}:${arrayLayerCount ?? (layer === undefined ? array.layers : 1)}`,
        );
  }

  /** Exact requested shape, without allocation or descriptor renewal. */
  residentTexture(
    label: string,
    size: number,
    layers: number,
    format: 'depth32float' | 'rg16float' = 'depth32float',
  ): Texture | undefined {
    if (this.disposed) return undefined;
    const actual = this.arrays.get(label);
    return actual?.size === size && actual.layers === layers && actual.format === format
      ? actual.texture
      : undefined;
  }

  /** Prepare absent or already matching storage; never resize shadows an old world is using. */
  *prepareTexture(
    label: string,
    size: number,
    layers: number,
    current: () => boolean,
    sampledLayerCount = layers,
  ): Generator<void, Texture> {
    this.requireCurrent(current);
    if (this.arrays.has(label) && this.residentTexture(label, size, layers) === undefined)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'unchanged persistent shadow allocation while preparing off-frame',
        hint: 'prepare a replacement generation before changing the active shadow shape',
      });
    const texture = this.texture(label, size, layers, 'depth32float', current);
    this.requireCurrent(current);
    yield;
    this.requireCurrent(current);
    if (this.residentTexture(label, size, layers) !== texture) throw this.stalePreparation();
    this.view(label, undefined, sampledLayerCount, current);
    this.requireCurrent(current);
    yield;
    this.requireCurrent(current);
    if (this.residentTexture(label, size, layers) !== texture) throw this.stalePreparation();
    return texture;
  }

  private stalePreparation(): RhiError {
    return new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'the original live shadow depth owner and native preparation demand',
      hint: 'discard stale preparation and retry from current shadow owners',
    });
  }
  private requireCurrent(current?: () => boolean): void {
    if (this.disposed || current?.() === false || this.disposed) throw this.stalePreparation();
  }

  /** Views resolve after their imported array and share its lifetime. */
  view(
    label: string,
    layer?: number,
    arrayLayerCount?: number,
    isCurrent?: () => boolean,
  ): TextureView {
    this.requireCurrent(isCurrent);
    const array = this.arrays.get(label);
    if (array === undefined) {
      throw new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'static shadow texture resolves before its views',
        hint: 'import the static shadow array before resolving its views',
      });
    }
    const count = arrayLayerCount ?? (layer === undefined ? array.layers : 1);
    const key = `${layer ?? 'array'}:${count}`;
    const current = array.views.get(key);
    if (current !== undefined) return current;
    const created = this.device.createTextureView(array.texture, {
      label: layer === undefined ? `${label}.view` : `${label}.layer.${layer}`,
      dimension: layer === undefined ? '2d-array' : '2d',
      aspect: array.format === 'depth32float' ? 'depth-only' : 'all',
      baseArrayLayer: layer ?? 0,
      arrayLayerCount: count,
    });
    if (!created.ok) throw created.error;
    this.requireCurrent(isCurrent);
    if (this.arrays.get(label) !== array) throw this.stalePreparation();
    array.views.set(key, created.value);
    return created.value;
  }

  /**
   * The array for `label`, allocated on first use and replaced when its shape
   * changes. A replacement that only changes the layer count carries every
   * retained layer it still holds across with one GPU copy, so an array sized
   * to its present lights grows or shrinks without discarding the other
   * lights' retained depth. Called from graph import resolution, so
   * allocation failure throws.
   */
  texture(
    label: string,
    size: number,
    layers: number,
    format: 'depth32float' | 'rg16float' = 'depth32float',
    isCurrent?: () => boolean,
    carryRetained = true,
  ): Texture {
    this.requireCurrent(isCurrent);
    const current = this.arrays.get(label);
    if (
      current !== undefined &&
      current.size === size &&
      current.layers === layers &&
      current.format === format
    ) {
      return current.texture;
    }
    const bytes = size * size * layers * 4;
    let memory: StaticShadowMemory | undefined;
    if (isStaticShadowProduct(label)) {
      this.staticMemory ??= new StaticShadowMemory(this.device);
      memory = this.staticMemory;
      if (!memory.acquire(label, bytes))
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'admitted device bytes for optional static shadow depth',
          hint: 'record the current combined shadow view when the device budget is occupied',
        });
    }
    let texture: Texture;
    try {
      const created = this.device.createTexture({
        label,
        size: { width: size, height: size, depthOrArrayLayers: layers },
        format,
        dimension: '2d',
        usage: SHADOW_DEPTH_LAYER_USAGE,
        mipLevelCount: undefined,
        sampleCount: undefined,
        viewFormats: undefined,
        textureBindingViewDimension: undefined,
      });
      if (!created.ok) throw created.error;
      texture = created.value;
    } catch (cause) {
      memory?.rejectCreation(bytes);
      throw cause;
    }
    memory?.adopt(texture, bytes);
    return this.adoptTexture(
      label,
      size,
      layers,
      format,
      texture,
      current,
      isCurrent,
      carryRetained,
    );
  }

  private adoptTexture(
    label: string,
    size: number,
    layers: number,
    format: 'depth32float' | 'rg16float',
    texture: Texture,
    previous: ShadowDepthArray | undefined,
    current: (() => boolean) | undefined,
    carryRetained: boolean,
  ): Texture {
    try {
      this.requireCurrent(current);
      if (this.arrays.get(label) !== previous) throw this.stalePreparation();
      const retained =
        carryRetained &&
        previous !== undefined &&
        previous.size === size &&
        previous.format === format
          ? this.carryRetained(previous, texture, layers)
          : new Set<number>();
      this.requireCurrent(current);
      if (this.arrays.get(label) !== previous) throw this.stalePreparation();
      // Previously submitted reads keep old storage until its ordinary retirement boundary.
      if (this.stagingShapes && !this.stagedShapes.has(label))
        this.stagedShapes.set(label, previous);
      else if (previous !== undefined) this.retireTexture(previous.texture);
      this.arrays.set(label, {
        texture,
        size,
        layers,
        format,
        views: new Map(),
        retained,
        pending: new Set(),
      });
      return texture;
    } catch (cause) {
      const receipt = this.retireTexture(texture);
      try {
        this.destroyRetiring([receipt]);
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Unaccepted shadow allocation cleanup failed');
      }
      throw cause;
    }
  }

  /** Copy the retained layers that fit into `texture`; a failed copy carries none. */
  private carryRetained(from: ShadowDepthArray, texture: Texture, layers: number): Set<number> {
    const carried = [...from.retained].filter((layer) => layer < layers);
    if (carried.length === 0) return new Set();
    const encoder = this.device.createCommandEncoder({ label: 'shadow-depth-layers.carry' });
    if (!encoder.ok) return new Set();
    for (const layer of carried)
      encoder.value.copyTextureToTexture(
        { texture: from.texture, origin: [0, 0, layer] },
        { texture, origin: [0, 0, layer] },
        { width: from.size, height: from.size, depthOrArrayLayers: 1 },
      );
    const finished = encoder.value.finish();
    if (!finished.ok) return new Set();
    return this.device.queue.submit([finished.value]).ok ? new Set(carried) : new Set();
  }

  /** Identity of the current physical allocation; querying never allocates a view. */
  allocation(label: string): Texture | undefined {
    return this.arrays.get(label)?.texture;
  }

  /** The descriptor belongs to the exact allocation authorized for this frame. */
  extent(label: string, texture: Texture) {
    const array = this.arrays.get(label);
    if (array?.texture !== texture) throw this.stalePreparation();
    return { width: array.size, height: array.size, depthOrArrayLayers: array.layers };
  }

  /** Resizing the complete map redraws its fitted views after issue. A rejected
   * frame restores the previously submitted map including its layer contents. */
  currentDirectionalTexture(size: number, count: number): Texture {
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      count < 1 ||
      count > 4 ||
      !Number.isInteger(count)
    )
      throw new RangeError(
        'A directional shadow writer requires fitted cascades and a positive map size',
      );
    const layers = Math.max(MIN_SHADOW_ARRAY_LAYERS, count);
    const label = 'directional-shadow-depth';
    const held = this.residentTexture(label, size, layers);
    if (held !== undefined) return held;
    this.beginReplacement();
    return this.texture(label, size, layers, 'depth32float', undefined, false);
  }

  /** Physical resident bytes, including arrays imported by a compiled graph. */
  byteSize(label: string): number {
    const array = this.arrays.get(label);
    return array === undefined ? 0 : array.size * array.size * array.layers * 4;
  }

  /** Whether `layer` of `label` holds depth from a submitted raster. */
  retained(label: string, layer: number): boolean {
    return this.arrays.get(label)?.retained.has(layer) === true;
  }

  /** Invalidate only this layer's submitted content before replacing it. */
  _invalidate(label: string, layer: number): void {
    this.arrays.get(label)?.retained.delete(layer);
  }

  /** Record that the staged frame rasters `layer` of `label`. */
  rastered(label: string, layer: number): void {
    this.arrays.get(label)?.pending.add(layer);
  }

  /**
   * Record that the staged frame leaves `layer` of `label` behind its view,
   * so the next raster decision rebuilds it whether or not the submit lands.
   */
  discard(label: string, layer: number): void {
    const array = this.arrays.get(label);
    array?.retained.delete(layer);
    array?.pending.delete(layer);
  }

  /** Drop the owner's reference after a successful submission stops consuming this product. */
  retire(label: string): void {
    const array = this.arrays.get(label);
    if (array === undefined) return;
    this.arrays.delete(label);
    this.retireTexture(array.texture);
  }

  /** A promoted recording resolved all its imports on the accepted frame. Release
   * physical products that lost their last view, including a removed light family. */
  acceptSubmittedTextures(recording: {
    getColorTargetTexture(label: string): Texture | undefined;
  }): void {
    if (this.arrays.size === 0) return;
    for (const [label, array] of this.arrays)
      if (recording.getColorTargetTexture(label) !== array.texture) this.retire(label);
    this.destroyRetiring();
  }

  /** @internal Promote staged rasters after a successful submit. */
  _commit(): void {
    this.staticMemory?.cancel();
    this.stagingShapes = false;
    for (const prior of this.stagedShapes.values())
      if (prior !== undefined) this.retireTexture(prior.texture);
    this.stagedShapes.clear();
    for (const array of this.arrays.values()) {
      for (const layer of array.pending) array.retained.add(layer);
      array.pending.clear();
    }
    this.destroyRetiring();
  }

  /** @internal Drop staged rasters whose submit failed. */
  _abort(): void {
    this.staticMemory?.cancel();
    const staged = this.stagingShapes;
    this.stagingShapes = false;
    for (const [label, prior] of this.stagedShapes) {
      const rejected = this.arrays.get(label);
      if (rejected !== undefined) this.retireTexture(rejected.texture);
      if (prior === undefined) this.arrays.delete(label);
      else this.arrays.set(label, prior);
    }
    this.stagedShapes.clear();
    for (const array of this.arrays.values()) array.pending.clear();
    if (staged && this.retiring.size !== 0) this.destroyRetiring();
  }

  dispose(): void {
    this.staticMemory?.cancel();
    this.disposed = true;
    for (const prior of this.stagedShapes.values())
      if (prior !== undefined) this.retireTexture(prior.texture);
    this.stagedShapes.clear();
    for (const array of this.arrays.values()) this.retireTexture(array.texture);
    this.arrays.clear();
    this.destroyRetiring();
  }

  private retireTexture(texture: Texture): ShadowTextureRetirement {
    let receipt = this.retiring.get(texture);
    if (receipt === undefined) {
      receipt = { texture, phase: 'pending' };
      this.retiring.set(texture, receipt);
    }
    return receipt;
  }

  private destroyRetiring(
    receipts: Iterable<ShadowTextureRetirement> = this.retiring.values(),
  ): void {
    if (this.retiring.size === 0 && this.retirementFailure === undefined) return;
    const failures: unknown[] = [];
    let destroyedBytes = 0;
    for (const receipt of receipts) {
      if (receipt.phase !== 'pending') continue;
      // Register the attempt before native callbacks. A failed/throwing effect is never retried.
      receipt.phase = 'destroying';
      try {
        const result = this.device.destroyTexture(receipt.texture);
        if (!result.ok) throw result.error;
        receipt.phase = 'destroyed';
        destroyedBytes += this.staticMemory?.destroyed(receipt.texture) ?? 0;
        this.retiring.delete(receipt.texture);
      } catch (cause) {
        receipt.phase = 'failed';
        failures.push(cause);
      }
    }
    this.staticMemory?.releaseAfterCompletion(destroyedBytes);
    if (failures.length > 0)
      this.retirementFailure = new AggregateError(
        [...(this.retirementFailure?.errors ?? []), ...failures],
        'Shadow depth retirement failed',
      );
    if (this.retirementFailure !== undefined) throw this.retirementFailure;
    for (const receipt of this.retiring.values())
      if (receipt.phase === 'destroying')
        throw new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'the in-flight shadow retirement to finish',
          hint: 'settle the original native operation before confirming disposal',
        });
  }
}
