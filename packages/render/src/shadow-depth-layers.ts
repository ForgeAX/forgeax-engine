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
  readonly views: Map<number | undefined, TextureView>;
  /** Layers whose raster reached a successful submit. */
  readonly retained: Set<number>;
  /** Layers rastered by the frame being staged. */
  readonly pending: Set<number>;
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
  private retiring: Texture[] = [];

  constructor(private readonly device: RhiDevice) {}

  /** Views resolve after their imported array and share its lifetime. */
  view(label: string, layer?: number): TextureView {
    const array = this.arrays.get(label);
    if (array === undefined) {
      throw new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'static shadow texture resolves before its views',
        hint: 'import the static shadow array before resolving its views',
      });
    }
    const current = array.views.get(layer);
    if (current !== undefined) return current;
    const created = this.device.createTextureView(array.texture, {
      label: layer === undefined ? `${label}.view` : `${label}.layer.${layer}`,
      dimension: layer === undefined ? '2d-array' : '2d',
      aspect: array.format === 'depth32float' ? 'depth-only' : 'all',
      baseArrayLayer: layer ?? 0,
      arrayLayerCount: layer === undefined ? array.layers : 1,
    });
    if (!created.ok) throw created.error;
    array.views.set(layer, created.value);
    return created.value;
  }

  /**
   * The array for `label`, allocated on first use and replaced when its shape
   * changes. Called from graph import resolution, so allocation failure throws.
   */
  texture(
    label: string,
    size: number,
    layers: number,
    format: 'depth32float' | 'rg16float' = 'depth32float',
  ): Texture {
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
    // Frames already submitted may still read the old array; it is destroyed
    // after the next successful submit.
    if (current !== undefined) this.retiring.push(current.texture);
    const array: ShadowDepthArray = {
      texture: created.value,
      size,
      layers,
      format,
      views: new Map(),
      retained: new Set(),
      pending: new Set(),
    };
    this.arrays.set(label, array);
    return array.texture;
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
