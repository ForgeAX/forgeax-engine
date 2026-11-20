import { type RhiDevice, RhiError, type Texture, type TextureView } from '@forgeax/engine-rhi';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from './gpu-texture-usage';

/**
 * Accesses of a retained shadow depth array: raster, sample and static-layer copies.
 */
export const SHADOW_DEPTH_LAYER_USAGE =
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
  GPU_TEXTURE_USAGE_COPY_SRC |
  GPU_TEXTURE_USAGE_COPY_DST |
  GPU_TEXTURE_USAGE_TEXTURE_BINDING;

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
  private retirementFailure: AggregateError | undefined;
  private disposed = false;

  constructor(private readonly device: RhiDevice) {}

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
    return this.adoptTexture(label, size, layers, format, created.value, current, isCurrent);
  }

  private adoptTexture(
    label: string,
    size: number,
    layers: number,
    format: 'depth32float' | 'rg16float',
    texture: Texture,
    previous: ShadowDepthArray | undefined,
    current?: () => boolean,
  ): Texture {
    try {
      this.requireCurrent(current);
      if (this.arrays.get(label) !== previous) throw this.stalePreparation();
      const retained =
        previous !== undefined && previous.size === size && previous.format === format
          ? this.carryRetained(previous, texture, layers)
          : new Set<number>();
      this.requireCurrent(current);
      if (this.arrays.get(label) !== previous) throw this.stalePreparation();
      // Previously submitted reads keep old storage until its ordinary retirement boundary.
      if (previous !== undefined) this.retireTexture(previous.texture);
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

  /** @internal Promote staged rasters after a successful submit. */
  _commit(): void {
    for (const array of this.arrays.values()) {
      for (const layer of array.pending) array.retained.add(layer);
      array.pending.clear();
    }
    this.destroyRetiring();
  }

  /** @internal Drop staged rasters whose submit failed. */
  _abort(): void {
    for (const array of this.arrays.values()) array.pending.clear();
  }

  dispose(): void {
    this.disposed = true;
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
    const failures: unknown[] = [];
    for (const receipt of receipts) {
      if (receipt.phase !== 'pending') continue;
      // Register the attempt before native callbacks. A failed/throwing effect is never retried.
      receipt.phase = 'destroying';
      try {
        const result = this.device.destroyTexture(receipt.texture);
        if (!result.ok) throw result.error;
        receipt.phase = 'destroyed';
        this.retiring.delete(receipt.texture);
      } catch (cause) {
        receipt.phase = 'failed';
        failures.push(cause);
      }
    }
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
