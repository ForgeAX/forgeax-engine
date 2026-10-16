// @forgeax/engine-runtime - ShadowAtlas (cube_array depth atlas for point-light shadows).
//
// feat-20260612-point-light-shadows-urp-hdrp M3 / T-M3-1 (plan-strategy §D-1).
//
// Lazy-allocated `texture_depth_cube_array` (depth32float) + per-face 2D
// TextureView cache. One layer per admitted shadow-casting PointLight; the
// renderer owns the bounded atlas admission policy. Total texel footprint at
// the 512x512 default = 4 layers x 6 faces x 512 x 512 x 4 B = 24 MiB.
//
// Why a separate module (vs inlining into createRenderer / pipelineState):
// - zero-shadow scene path stays allocation-free (AC-09): we never call
//   `device.createTexture` on the cube_array unless `ensure(...)` is invoked
//   from the extract / record path on a frame that has at least one
//   PointLightShadow snapshot.
// - face-view cache is keyed (layer, face) and built lazily during the
//   per-light shadow caster pass; the cache is invalidated together with the
//   atlas when `dispose()` runs (renderer teardown or layers re-allocation).
// - the helper descriptors live in `@forgeax/engine-rhi`
//   (`cubeArrayDepthDescriptor` / `cubeArrayDepthFaceView` /
//   `comparisonSamplerDescriptor`) per T-M0-3; this file is the runtime-side
//   owner of the GPU resources they describe.
//
// Lifecycle:
//   1. `new ShadowAtlas(device, { faceSize, layers })` — construct the
//      manager; no GPU work yet.
//   2. `atlas.ensure()` — first call allocates the cube_array texture +
//      cube_array sampling view + comparison sampler (idempotent thereafter).
//   3. `atlas.faceView(layer, face)` — lazy 2D depth view used as a render-
//      pass attachment for the corresponding cube face. Cached per (layer,
//      face).
//   4. `atlas.dispose()` — releases the GPU resources and clears caches.
//      `ensure()` after `dispose()` re-allocates from scratch.

import {
  comparisonSamplerDescriptor,
  cubeArrayDepthDescriptor,
  cubeArrayDepthFaceView,
  type RhiDevice,
  type Sampler,
  type Texture,
  type TextureView,
} from '@forgeax/engine-rhi';

import {
  PointShadowAtlasBoundsViolationError,
  PointShadowAtlasUninitializedError,
} from './errors/render';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
} from './gpu-texture-usage';

/**
 * Construction options for {@link ShadowAtlas}.
 */
export interface ShadowAtlasOptions {
  /** Per-face square size in pixels. Default 512 (PointLightShadow.mapSize default). */
  readonly faceSize?: number;
  /** Number of cube layers. Default is the renderer atlas admission capacity. */
  readonly layers?: number;
}

/** Default per-face square size in pixels. Mirrors PointLightShadow.mapSize default. */
export const SHADOW_ATLAS_DEFAULT_FACE_SIZE = 512;
/** Default cube layer count. Renderer-owned point-shadow admission capacity. */
export const SHADOW_ATLAS_DEFAULT_LAYERS = 4;

/**
 * Cube-array depth atlas for point-light shadows.
 *
 * Shape: `texture_depth_cube_array` (depth32float) with `layers` and per-
 * face size `faceSize x faceSize`. The cube_array sampling view feeds
 * `@group(0) @binding(5)` in URP shaders; the per-face 2D view feeds the
 * shadow-caster render pass attachment for one (layer, face) at a time
 * (WebGPU forbids cube views as render-pass attachments).
 *
 * Construction performs no GPU work. The first `ensure()` call allocates the
 * texture + view + sampler. `dispose()` releases everything; later `ensure()`
 * calls re-allocate.
 *
 * @example Lazy allocation in the extract / record path:
 * ```
 * if (lights.pointShadow.length > 0) {
 *   atlas.ensure();
 *   for (const ps of lights.pointShadow) {
 *     for (let face = 0; face < 6; face++) {
 *       const view = atlas.faceView(ps.shadowAtlasLayer, face);
 *       // ... begin shadow caster pass with `view` as the depth attachment
 *     }
 *   }
 * }
 * ```
 */
export class ShadowAtlas {
  /** Backing cube_array depth texture. `null` until `ensure()` has run. */
  private texture: Texture | null = null;
  /**
   * Whole-atlas cube_array sampling view used by URP shaders that bind the
   * atlas at `@group(0) @binding(5)`. `null` until `ensure()` has run.
   */
  private cubeArrayView: TextureView | null = null;
  /** Comparison sampler for `texture_depth_cube_array`. */
  private compareSampler: Sampler | null = null;
  /** Per-face 2D depth view cache, keyed by `layer * 6 + face`. */
  private readonly faceViews = new Map<number, TextureView>();
  /** Per-face label cache (debug aid). Reused on re-creation. */
  private readonly device: RhiDevice;
  /** Per-face square size in pixels. */
  readonly faceSize: number;
  /** Cube layer count. */
  readonly layers: number;

  constructor(device: RhiDevice, options: ShadowAtlasOptions = {}) {
    this.device = device;
    this.faceSize = options.faceSize ?? SHADOW_ATLAS_DEFAULT_FACE_SIZE;
    this.layers = options.layers ?? SHADOW_ATLAS_DEFAULT_LAYERS;
  }

  /**
   * Returns `true` once the atlas texture is allocated. Used by the extract /
   * record path to gate "no PointLightShadow → no allocation" (AC-09) — the
   * caller calls {@link ensure} on a frame that has at least one snapshot;
   * before that, `isAllocated()` stays `false` and tests can assert no GPU
   * resources were created.
   */
  isAllocated(): boolean {
    return this.texture !== null;
  }

  /**
   * Lazy-allocate the atlas texture + cube_array sampling view + comparison
   * sampler. Idempotent: subsequent calls are zero-cost no-ops once the
   * resources exist.
   *
   * Throws (via the RHI error registry) on allocation failure. This is the
   * only path that touches the GPU — keeping it inside one method makes the
   * "zero-shadow scene = zero allocation" gate easy to enforce: the renderer
   * never calls this method on a frame with no PointLightShadow entities.
   */
  ensure(): void {
    if (this.texture !== null) return;
    // Faces receive their retained static caster layer by copy.
    const usage =
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST;
    const texDesc = cubeArrayDepthDescriptor(this.faceSize, this.layers, usage);
    const texRes = this.device.createTexture(texDesc);
    if (!texRes.ok) throw texRes.error;
    this.texture = texRes.value;

    const viewRes = this.device.createTextureView(this.texture, {
      label: 'shadow-atlas-cube-array-view',
      dimension: 'cube-array',
      aspect: 'depth-only',
      baseArrayLayer: 0,
      arrayLayerCount: 6 * this.layers,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });
    if (!viewRes.ok) {
      this.device.destroyTexture(this.texture);
      this.texture = null;
      throw viewRes.error;
    }
    this.cubeArrayView = viewRes.value;

    const sampRes = this.device.createSampler({
      ...comparisonSamplerDescriptor(),
      compare: 'greater',
    });
    if (!sampRes.ok) {
      this.device.destroyTexture(this.texture);
      this.texture = null;
      this.cubeArrayView = null;
      throw sampRes.error;
    }
    this.compareSampler = sampRes.value;
  }

  /**
   * Whole-atlas cube_array sampling view (`texture_depth_cube_array`). Returns
   * `null` if the atlas is not yet allocated; the caller should gate on a
   * non-null pointShadow array before calling {@link ensure} + this getter.
   */
  getAtlasView(): TextureView | null {
    return this.cubeArrayView;
  }

  /**
   * Comparison sampler (`compare: 'greater'`) for cube_array depth sampling.
   * Returns `null` if the atlas is not yet allocated.
   */
  getComparisonSampler(): Sampler | null {
    return this.compareSampler;
  }

  /**
   * Backing texture handle. Returns `null` if the atlas is not yet allocated.
   */
  getTexture(): Texture | null {
    return this.texture;
  }

  /**
   * Lazy 2D depth view selecting `(layer, face)` (the caller passes
   * `shadowAtlasLayer` from the snapshot and a face index 0..5). Used as the
   * depth attachment of the shadow-caster render pass for one cube face.
   *
   * Caches per `(layer, face)` so the per-frame shadow loop pays zero
   * `createTextureView` cost after the first allocation. Cache is cleared on
   * {@link dispose}.
   *
   * @throws PointShadowAtlasUninitializedError if the atlas is not yet
   *   allocated (caller must call {@link ensure} first).
   * @throws PointShadowAtlasBoundsViolationError if `layer` or `face` is out
   *   of range.
   * @throws RhiError if the underlying `createTextureView` fails.
   */
  faceView(layer: number, face: number): TextureView {
    if (this.texture === null) {
      throw new PointShadowAtlasUninitializedError();
    }
    if (layer < 0 || layer >= this.layers) {
      throw new PointShadowAtlasBoundsViolationError('layer', layer, this.layers);
    }
    if (face < 0 || face >= 6) {
      throw new PointShadowAtlasBoundsViolationError('face', face, 6);
    }
    const key = layer * 6 + face;
    const cached = this.faceViews.get(key);
    if (cached !== undefined) return cached;
    const desc = cubeArrayDepthFaceView(layer, face);
    const r = this.device.createTextureView(this.texture, desc);
    if (!r.ok) throw r.error;
    this.faceViews.set(key, r.value);
    return r.value;
  }

  /**
   * Release the GPU resources and clear the per-face view cache. Idempotent;
   * subsequent calls are zero-cost. After dispose, `isAllocated()` returns
   * `false` and the next `ensure()` re-allocates from scratch.
   */
  dispose(): void {
    this.faceViews.clear();
    if (this.texture !== null) {
      this.device.destroyTexture(this.texture);
      this.texture = null;
    }
    this.cubeArrayView = null;
    this.compareSampler = null;
  }
}
