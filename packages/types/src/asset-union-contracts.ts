// Asset union and tileset contracts.

import type { AnimationClip, AnimationGraph } from './animation-contracts.js';
import type { AudioClipAsset } from './asset.js';
import type { AssetHandle } from './asset-handle.js';
import type { FontAsset } from './font-contracts.js';
import type { AssetGuid } from './image-pack-contracts.js';
import type { IesProfileAsset } from './lighting.js';
import type { MaterialAsset } from './material/asset.js';
import type { SkeletonAsset, SkinAsset, VideoAsset } from './media-contracts.js';
import type { EquirectAsset, MeshAsset, SamplerAsset } from './mesh-contracts.js';
import type { NavigationMeshAsset } from './navigation.js';
import type { PluginAsset } from './plugin-asset.js';
import type { SceneAsset } from './scene-contracts.js';
import type { TerrainAsset } from './terrain.js';
import type { TextureAsset } from './texture/asset.js';
import type { ParticleEffectAsset } from './vfx.js';

// === RenderPipelineAsset POD shape =============================================
//
// feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend M1 / w5.
// Asset-layer descriptor that binds a registered render-pipeline logic id to an
// installable Handle (the MaterialAsset { materialShaderId, params } pattern, scaled to
// the pipeline layer). `installPipeline(handle)` resolves this POD off the AssetRegistry,
// looks up `pipelineId` in the pipeline registry, and swaps the per-frame graph.
//
// M2 stage (w10): `config.passCount` is the FIRST real config key. The standard pipeline
// runs with config undefined (default frame byte-identical, AC-01); a custom pipeline can
// size its declared pass chain from `config.passCount` so its topology varies observably
// via `renderer.perFramePassNames` (AC-03 / plan-strategy D-C).
//
// feat-20260608-cluster-lighting M2 / w8: `config.clusterGrid` is the HDRP cluster grid
// dimensions config (default {x:16, y:9, z:24}). `pipelineId` is narrowed to a literal
// union of `'forgeax::urp' | 'forgeax::hdrp' | (string & {})` so TS narrowing on
// `pipelineId === 'forgeax::hdrp'` narrows `config.clusterGrid`.
//
// feat-20260612-hdrp-ssao M4 / w19: `config.ssao` is the SSAO configuration
// (enabled+radius+bias+intensity). Same shared-config pattern as clusterGrid;
// HDRP consumes it, URP ignores it at runtime.
/**
 * Asset-layer descriptor for an installable render pipeline.
 *
 * `pipelineId` references a logic registered via `renderer.registerPipeline(id, impl)`
 * (engine builtins use the `forgeax::` prefix, e.g. `'forgeax::urp'`; user pipelines use
 * `<package>::<id>`). `config` is the per-install tuning the pipeline logic reads at
 * `buildGraph` time; `passCount` is the first real key (a custom pipeline declares that
 * many passes). The URP ignores `config` (its topology is fixed).
 *
 * `config.clusterGrid` is the HDRP cluster grid dimensions (x/y/z each an integer in
 * [1, 64]; default {16, 9, 24}). It is ignored by URP.
 *
 * `config.ssao` enables SSAO (Screen-Space Ambient Occlusion) for the HDRP
 * deferred path. Ignored by URP.
 */
export interface RenderPipelineAsset {
  readonly kind: 'render-pipeline';
  readonly pipelineId: 'forgeax::urp' | 'forgeax::hdrp' | (string & {});
  readonly renderPath?: 'forward' | 'deferred';
  readonly config?: {
    readonly passCount?: number;
    readonly clusterGrid?: { readonly x: number; readonly y: number; readonly z: number };
    readonly ssao?: {
      readonly enabled: boolean;
      /** Screen-space AO estimator; defaults to GTAO. */
      readonly algorithm?: 'ssao' | 'gtao' | undefined;
      /** Fraction of screen-space AO applied to direct light, in [0, 1]; default 0. */
      readonly directLightingStrength?: number | undefined;
      readonly radius?: number | undefined;
      readonly bias?: number | undefined;
      readonly intensity?: number | undefined;
      /** GTAO view-space depth rejection; default 1 world unit. */
      readonly thickness?: number | undefined;
      /** GTAO radial distribution exponent; default 1 (linear). */
      readonly distanceExponent?: number | undefined;
      /** GTAO horizon update falloff in [0, 1]; default 1. */
      readonly distanceFallOff?: number | undefined;
      /** AO extent relative to internal scene color, in [0.25, 1]; default 1. */
      readonly resolutionScale?: number | undefined;
      readonly quality?: 'low' | 'medium' | 'high' | undefined;
    };
    /** Final display-encoded RGBA8 dither; defaults to true when omitted. */
    readonly outputDither?: boolean;
    /**
     * Two-phase GPU occlusion culling of the single-sample main view's
     * GPU-driven items against a furthest-depth pyramid (HZB). It supplements
     * hardware occlusion queries, needs `firstInstanceIndirect`, and defaults
     * to true when omitted.
     */
    readonly gpuOcclusion?: boolean;
    /**
     * feat-20260621 M4': ordered registered post-process shader ids the built-in
     * pipelines composite over the FINAL swap-chain image, after the fxaa pass
     * and before the debug overlay. Each id must be registered via
     * `renderer.postProcess.register(id, entry)` first. The effects run in array
     * order; each samples the current swap-chain (copy) and writes it back, so a
     * chain composes left-to-right. This is the AUGMENT path: the built-in
     * Standard chain (shadow cascades, tonemap, multiscale Bloom, fxaa) renders
     * unchanged and the
     * effects layer on top — unlike installing a wholly custom pipeline, which
     * REPLACES the built-in graph (and would drop its shadow passes). `undefined`
     * or `[]` adds zero passes (default frame byte-identical).
     *
     * WebGPU backend only: each effect reads the mid-frame swap-chain (copy +
     * non-srgb storage-view write), which the WebGL2 fallback swap-chain does not
     * support (no COPY_SRC, no non-srgb reinterpret view) — same constraint the
     * built-in FXAA pass already carries. On a non-WebGPU device leave this empty.
     */
    readonly postEffects?: readonly string[];
  };
}

/**
 * Asset discriminated union - 13 variants keyed on `.kind`.
 *
 * Variant history:
 *   - feat-20260513-instanced-mesh M1 introduced a 5th `'instanced-buffer-asset'`
 *     variant carrying packed mat4 transforms + a `version` dirty flag.
 *   - feat-20260514-ecs-children-instances-managed-buffer-array M3 (w15)
 *     retired that variant: per-entity instanced transforms are now stored
 *     directly inside the ECS via the `Instances { transforms: 'array<f32>' }`
 *     component (managed by the BufferPool slot column + sidecar count
 *     column). Asset closed-union shrinks 5 -> 4 (evolution major rename
 *     per AGENTS.md `Change stance`); existing exhaustive `switch
 *     (asset.kind)` consumers drop the now-unreachable arm in the same PR.
 *   - feat-20260514-scene-as-world-blueprint w3 added `'scene'` variant
 *     (4 -> 5, minor add per AGENTS.md `Evolution contract`); declarative
 *     SceneEntity list, no overrides at the asset layer.
 *   - feat-20260531-world-space-msdf-text-rendering w5 added `'font'` variant
 *     (11 -> 12, minor add per AGENTS.md `Evolution contract`);
 *     FontAsset with atlas handle + sampler handle + glyph metrics.
 *   - feat-20260601-customizable-render-pipeline-seam-and-dogfood-rend w5 added
 *     `'render-pipeline'` variant (12 -> 13, minor add per AGENTS.md
 *     `Evolution contract`); RenderPipelineAsset with pipelineId + config.
 *   - feat-20260623-world-space-video-asset M1 added `'video'` variant
 *     (14 -> 15, minor add per AGENTS.md `Evolution contract`);
 *     VideoAsset with `{ url }` descriptor, no width/height/duration.
 *
 * Exhaustive `switch (asset.kind)` type-guards against future additions
 * without default fallback (charter proposition 4 + proposition 3).
 *
 * | kind | variant |
 * |:--|:--|
 * | `'mesh'` | `MeshAsset` |
 * | `'texture'` | `TextureAsset` |
 * | `'equirect'` | `EquirectAsset` (single 2D HDR lat-long env map for IBL) |
 * | `'sampler'` | `SamplerAsset` |
 * | `'material'` | `MaterialAsset` (further narrows on `.passes`) |
 * | `'scene'` | `SceneAsset` (declarative SceneEntity list, no overrides) |
 * | `'font'` | `FontAsset` (MSDF atlas handle + glyph metrics) |
 * | `'render-pipeline'` | `RenderPipelineAsset` (installable pipeline logic id + config) |
 * | `'video'` | `VideoAsset` (runtime-only `{ url }` descriptor, no width/height/duration) |
 * | `'animation-graph'` | `AnimationGraph` (Clip/Blend/Add DAG + per-node static weights) |
 */
export type Asset =
  | PluginAsset
  | MeshAsset
  | TextureAsset
  | EquirectAsset
  | SamplerAsset
  | MaterialAsset
  | SceneAsset
  | SkeletonAsset
  | SkinAsset
  | AnimationClip
  // === 1 new variant (feat-20260713-animation-state-machine-plugin M2 / w13) ===
  // AnimationGraph POD (Clip/Blend/Add DAG); GUID-addressable, serializable
  // (AC-14 foundation). Closed node union (clip/blend/add), no reserved FSM/Mask
  // fields (OOS-1..4).
  | AnimationGraph
  | AudioClipAsset
  | IesProfileAsset
  | FontAsset
  | RenderPipelineAsset
  // === 1 new variant (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
  // Direct atlases[] form (plan-strategy D-7 one-cut); no intermediate single-`atlas` shape.
  | TilesetAsset
  // === 1 new variant (feat-20260623-world-space-video-asset M1) ===
  // runtime-only { url } descriptor; no width/height/duration in payload.
  | VideoAsset
  | ParticleEffectAsset
  | TerrainAsset
  | NavigationMeshAsset;

/** Optional per-tile collision source in normalized cell coordinates. Runtime physics
 * consumption is not installed by the Tileset render owner. */
export type TilesetTileCollider =
  | { readonly type: 'none' }
  | { readonly type: 'rect'; readonly rect: readonly [number, number, number, number] }
  | { readonly type: 'polygon'; readonly points: readonly (readonly [number, number])[] };

/** Pixel rectangle in one atlas; atlasIndex defaults to zero. */
export interface TilesetRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly atlasIndex?: number;
}

/** A tile id is its index + 1; zero is an empty Tilemap cell. Width/height default
 * to one cell and lie in (0, 64]. Pivots default to 0.5 and lie in [0, 1]. The
 * pivot stays in atlas-local coordinates through Tiled flips and diagonal rotation. */
export interface TilesetTileEntry {
  readonly regionIndex: number;
  readonly widthCells?: number;
  readonly heightCells?: number;
  readonly pivotX?: number;
  readonly pivotY?: number;
  readonly collider?: TilesetTileCollider;
}

export interface TilesetAtlasSize {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

/** Shared runtime tile definitions. Admission validates geometry and links atlas
 * references. Updating this asset changes runtime drawing without rebinding any
 * Tilemap entity or touching its author cells. */
export interface TilesetAsset {
  readonly kind: 'tileset';
  /** Source GUIDs become texture handles belonging to this asset owner. */
  readonly atlases: readonly (AssetGuid | string | AssetHandle<'texture'>)[];
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly columns: number;
  readonly rows: number;
  /** Exact dimensions per atlas; otherwise columns*tileWidth by rows*tileHeight. */
  readonly atlasSizes?: readonly TilesetAtlasSize[];
  readonly regions: readonly TilesetRegion[];
  readonly tiles: readonly TilesetTileEntry[];
}
