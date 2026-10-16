// Asset union and tileset contracts.

import type { AnimationClip, AnimationGraph } from './animation-contracts.js';
import type { AudioClipAsset } from './asset.js';
import type { FontAsset } from './font-contracts.js';
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
      /** Screen-space AO estimator; defaults to hemisphere SSAO. */
      readonly algorithm?: 'ssao' | 'gtao' | undefined;
      /** Fraction of screen-space AO applied to direct light, in [0, 1]; default 0. */
      readonly directLightingStrength?: number | undefined;
      readonly radius?: number | undefined;
      readonly bias?: number | undefined;
      readonly intensity?: number | undefined;
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

// === Tileset asset POD shape (feat-20260608 M0 baseline rebuild) =================
//
// Decision anchors:
//   - requirements §AC-01/03/04/05 (TilesetAsset 9 fields; atlases plural composite;
//     M0 TilesetTileEntry single-field shape with M1 adding 5 optional + collider).
//   - plan-strategy §D-5 (M0 baseline rebuild after main reverted feat-20260604).
//   - plan-strategy §D-7 (`atlases: readonly Handle<TextureAsset,managed>[]` one-cut
//     rename; no `atlas` single-form alias or dual-path).
//   - plan-strategy §D-6 (AssetErrorCode count restoration -- M0 reintroduces
//     `tileset-region-index-out-of-range`; M1 adds `tileset-tile-entry-malformed`).
//   - charter F1 (AI users discover the schema via IDE autocomplete on the closed
//     `Asset` union + `Handle<TilesetAsset>` returns from `AssetRegistry.register`).
//   - charter P4 (atlases plural composite mirrors `MaterialAsset.passes[]` shape).

/**
 * Closed `TilesetTileCollider` union -- per-tile collider schema (M1
 * extension; feat-20260608-tilemap-object-layer-rendering M1 / m1-t2).
 *
 * Three discriminant variants (closed enum, charter P3):
 *
 *   - `{ type: 'none' }` -- no collider for this tile.
 *   - `{ type: 'rect', rect: readonly [x, y, w, h] }` -- axis-aligned
 *     rectangle in normalized cell coordinates `[0, 1]^2`. `w > 0`, `h > 0`,
 *     `x + w <= 1`, `y + h <= 1` are enforced by `validateTilesetPayload`
 *     (R-6 first-error path).
 *   - `{ type: 'polygon', points: readonly [x, y][] }` -- convex/concave
 *     polygon in normalized cell coordinates. `points.length >= 3` and
 *     each point lies in `[0, 1]^2`.
 *
 * The engine validates this schema at register-time but does NOT consume
 * it (plan-strategy §D-4 -- schema landed, consumer deferred to a future
 * `feat-tilemap-physics-bridge` closed loop). AI users with a physics
 * sidecar consume the schema directly via `tileset.tiles[i].collider`
 * after `assets.register<TilesetAsset>(...)` resolves the handle.
 *
 * Exhaustive switch:
 * ```ts
 * switch (collider.type) {
 *   case 'none': return null;
 *   case 'rect': return collider.rect;
 *   case 'polygon': return collider.points;
 *   // No default branch -- TS guards completeness (charter P3).
 * }
 * ```
 */
export type TilesetTileCollider =
  | { readonly type: 'none' }
  | { readonly type: 'rect'; readonly rect: readonly [number, number, number, number] }
  | { readonly type: 'polygon'; readonly points: readonly (readonly [number, number])[] };

/**
 * Rectangular sub-region within a tileset atlas (M1 schema extension on
 * top of M0 baseline rebuild).
 *
 * Four required fields define the atlas-space rectangle in pixels:
 * `x` / `y` top-left corner; `width` / `height` extent. `width + x` and
 * `height + y` MUST stay within the parent atlas extent or
 * `validateTilesetPayload` returns
 * `AssetError { code: 'tileset-region-index-out-of-range' }`
 * (charter P3 explicit failure at register-time).
 *
 * Optional `atlasIndex?: number` (M1; default 0) routes the region into
 * `TilesetAsset.atlases[atlasIndex]` for multi-atlas tilesets. Out-of-range
 * `atlasIndex` (`>= atlases.length` or negative) surfaces
 * `AssetError { code: 'tileset-tile-entry-malformed', detail: { field: 'atlasIndex', scope: 'tileset-asset' } }`
 * at register-time (plan-strategy §D-7 three-hop routing; R-6 first-error
 * order places atlasIndex check between region rect bounds and per-tile
 * entry field checks).
 */
export interface TilesetRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly atlasIndex?: number;
}

/**
 * Per-tile entry in `TilesetAsset.tiles[]` (M1 schema extension on top of
 * M0 baseline rebuild).
 *
 * Required `regionIndex` points into the parent `TilesetAsset.regions[]`
 * array. M1 adds five optional fields for the variable-size + custom-pivot
 * object-layer story (plan-strategy §M1):
 *
 *   - `widthCells?: number` -- multi-cell width in `Tilemap.cols/rows`
 *     coordinate units (default 1; range `(0, 64]`). Anchored at the
 *     cell that hosts the non-zero tileId entry; cells inside the
 *     `widthCells x heightCells` footprint must stay 0 in `TileLayer.tiles[]`
 *     (anchor convention, not enforced at register time).
 *   - `heightCells?: number` -- multi-cell height (default 1; range `(0, 64]`).
 *   - `pivotX?: number` -- normalized horizontal pivot in `[0, 1]` (default 0.5).
 *     The pivot is the world-space anchor: `pivot_world_X = (cellX + pivotX) * tileSizeX`.
 *     Quad center is offset by `(0.5 - pivotX) * widthCells * tileSizeX`
 *     (plan-strategy §D-2 first-line geometry; M2 implementation).
 *   - `pivotY?: number` -- normalized vertical pivot in `[0, 1]` (default 0.5).
 *     For asi_world `.tsj` extension: `pivotY = 1.0` means quad bottom
 *     anchors the cell, `pivotY = 0.0` means quad top (per-asset convention,
 *     not Tiled native). The engine uses `effectivePivotY` for Y-sort.
 *   - `collider?: TilesetTileCollider` -- 3-variant closed union schema
 *     (charter P3). Engine validates the schema at register-time but does
 *     NOT consume it (plan-strategy §D-4).
 *
 * All five fields are optional so unit-cell call sites `{ regionIndex: N }`
 * remain backward compatible (charter F1).
 *
 * Out-of-range `regionIndex` (>= regions.length, or negative) surfaces
 * `AssetError { code: 'tileset-region-index-out-of-range' }`. Out-of-range
 * `widthCells / heightCells / pivotX / pivotY / collider` surface
 * `AssetError { code: 'tileset-tile-entry-malformed', detail: { field, scope: 'tile-entry', tileEntryIndex } }`
 * (plan-strategy §D-6 closed 7-variant `.detail.field` enum).
 */
export interface TilesetTileEntry {
  readonly regionIndex: number;
  readonly widthCells?: number;
  readonly heightCells?: number;
  readonly pivotX?: number;
  readonly pivotY?: number;
  readonly collider?: TilesetTileCollider;
}

/**
 * Tileset asset (M0 baseline rebuild on origin/main).
 *
 * Nine fields:
 *   - `kind`         -- discriminator literal `'tileset'`.
 *   - `atlases`      -- one or more durable GUIDs for atlas textures.
 *                       `atlases.length >= 1` enforced at register time.
 *                       M0 reads `atlases[0]` exclusively (single-atlas form);
 *                       M1 adds `regions[].atlasIndex` for multi-atlas routing.
 *   - `tileWidth`/`tileHeight` -- per-cell pixel size (atlas grid stride).
 *   - `columns`/`rows`        -- atlas grid layout (informational metadata; used
 *                               as fallback when `atlasSizes` is absent to infer
 *                               atlas pixel extent as `columns * tileWidth`).
 *   - `atlasSizes`  -- optional per-atlas pixel dimensions. When present,
 *                      `atlasSizes[i]` gives the exact pixel size of
 *                      `atlases[i]` and overrides `columns`/`rows` for UV
 *                      normalisation in the chunk-extract system. Required when
 *                      the tileset contains multiple atlases with different
 *                      pixel sizes (e.g. a terrain + object composite tileset).
 *                      Each entry carries `{ pixelWidth, pixelHeight }`.
 *   - `regions`     -- array of atlas sub-rectangles (TilesetRegion).
 *   - `tiles`       -- per-tile entries (TilesetTileEntry), 1-indexed via tile id
 *                      sentinel where 0 means "empty" in `TileLayer.tiles`.
 *
 * Plural composite `atlases` (not single `atlas`) is the one-cut breaking
 * rename versus the old feat-20260604 form (plan-strategy §D-7 + AGENTS.md
 * §Change stance "optimal > compatible"); no deprecation alias survives.
 *
 * @example Register a tileset and spawn a Tilemap + TileLayer pair:
 * ```ts
 * const atlasGuid = 'world/object_atlas';
 * const tileset = registry.register<TilesetAsset>({
 *   kind: 'tileset',
 *   atlases: [atlasGuid],
 *   tileWidth: 16,
 *   tileHeight: 16,
 *   columns: 8,
 *   rows: 8,
 *   regions: [{ x: 0, y: 0, width: 16, height: 16 }],
 *   tiles: [{ regionIndex: 0 }],
 * }).unwrap();
 * ```
 */
export interface TilesetAtlasSize {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface TilesetAsset {
  readonly kind: 'tileset';
  readonly atlases: readonly string[];
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly columns: number;
  readonly rows: number;
  /** Per-atlas pixel dimensions. `atlasSizes[i]` overrides `columns`/`rows`
   *  for UV normalisation of regions whose `atlasIndex === i`. Required when
   *  atlases have different pixel sizes. */
  readonly atlasSizes?: readonly TilesetAtlasSize[];
  readonly regions: readonly TilesetRegion[];
  readonly tiles: readonly TilesetTileEntry[];
}
