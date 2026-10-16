import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
} from '../gpu-texture-usage';

/**
 * Every access a static layer array takes: raster, load, and copy into the
 * final layer. Receivers sample the final layer, never this array.
 */
export const STATIC_SHADOW_LAYER_USAGE =
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC;

interface StaticShadowLayerArray {
  readonly texture: Texture;
  readonly size: number;
  readonly layers: number;
  /** Layers whose raster reached a successful submit. */
  readonly retained: Set<number>;
  /** Layers rastered by the frame being staged. */
  readonly pending: Set<number>;
}

/**
 * Renderer-owned depth arrays behind the static shadow layers. Compiled graphs
 * import them instead of allocating them, so a recompile keeps every retained
 * layer and the view pool's cache decision still describes the depth behind
 * it. A layer counts as retained only after a submit that rastered it
 * succeeds; a fresh or replaced array holds none.
 */
export class StaticShadowLayers {
  private readonly arrays = new Map<string, StaticShadowLayerArray>();
  private retiring: Texture[] = [];

  constructor(private readonly device: RhiDevice) {}

  /**
   * The array for `label`, allocated on first use and replaced when its shape
   * changes. Called from graph import resolution, so allocation failure throws.
   */
  texture(label: string, size: number, layers: number): Texture {
    const current = this.arrays.get(label);
    if (current !== undefined && current.size === size && current.layers === layers) {
      return current.texture;
    }
    const created = this.device.createTexture({
      label,
      size: { width: size, height: size, depthOrArrayLayers: layers },
      format: 'depth32float',
      dimension: '2d',
      usage: STATIC_SHADOW_LAYER_USAGE,
      mipLevelCount: undefined,
      sampleCount: undefined,
      viewFormats: undefined,
      textureBindingViewDimension: undefined,
    });
    if (!created.ok) throw created.error;
    // Frames already submitted may still read the old array; it is destroyed
    // after the next successful submit.
    if (current !== undefined) this.retiring.push(current.texture);
    this.arrays.set(label, {
      texture: created.value,
      size,
      layers,
      retained: new Set(),
      pending: new Set(),
    });
    return created.value;
  }

  /** Whether `layer` of `label` holds depth from a submitted raster. */
  retained(label: string, layer: number): boolean {
    return this.arrays.get(label)?.retained.has(layer) === true;
  }

  /** Record that the staged frame rasters `layer` of `label`. */
  rastered(label: string, layer: number): void {
    this.arrays.get(label)?.pending.add(layer);
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
    for (const array of this.arrays.values()) this.retiring.push(array.texture);
    this.arrays.clear();
    this.destroyRetiring();
  }

  private destroyRetiring(): void {
    const retiring = this.retiring;
    this.retiring = [];
    for (const texture of retiring) this.device.destroyTexture(texture);
  }
}
