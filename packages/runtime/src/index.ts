// @forgeax/engine-runtime — public API surface (M3).
//
// Surface (K-4):
//   - createRenderer(canvas, options?) — async Result factory; uses WebGPU
//     exclusively and returns EngineEnvironmentError or RenderError on failure.
//   - Renderer / RendererOptions / RendererLostInfo /
//     RendererLostListener — types for callers.
//   - EngineEnvironmentError — returned when no backend is usable.
//
// What is **NOT** here, by design (acceptance grep checks negative existence):
//   - any internal backend module — locked by `package.json#exports`
//     entry `"./internal/*": null`.

/**
 * `acquireCanvasContext` facade re-export (M3 D-P3 / w15).
 *
 * Single-entry SSOT for vite apps: instead of importing rhi-webgpu directly,
 * AI users wire canvas through engine-runtime's public surface (charter
 * proposition 5 consistent abstraction — apps see one entry; pipeline
 * isolation — apps depend on engine-runtime, not on the rhi backend choice).
 *
 * @example
 *   import { acquireCanvasContext } from '@forgeax/engine-runtime';
 *   const ctxResult = acquireCanvasContext(canvas);
 */
export { acquireCanvasContext } from '@forgeax/engine-rhi-webgpu';
export { defaultAssetDecoderContributions } from './asset-contributions';
export { createRenderer } from './createRenderer';

// feat-20260704-runtime-tier1-decomposition M2 / w10 (D-3 / D-9): the top-level
// RuntimeError / RuntimeErrorCode cross-cluster aggregates are ELIMINATED. Each
// error cluster's closed *ErrorCode + *Error union is re-exported so external
// consumers `import type` the cluster union and write exhaustive `switch
// (err.code)` (AC-07 a/b). Every re-export sources directly from
// ./errors/<cluster> (NOT the transitional errors.ts barrel, deleted in w15;
// NOT the @forgeax/engine-types zombie RuntimeErrorCode -- D-9).

// feat-20260705-runtime-tier2-decomposition M1 / w14: the asset cluster error
// re-exports (AssetRuntimeError / *Detail types + MaterialResolvedEmptyPasses /
// SceneCollect* classes) moved to @forgeax/engine-assets-runtime. Consumers
// import them from that package directly (AC-105: runtime barrel exports zero
// asset-cluster symbols).
// -- environment cluster --
export { EngineEnvironmentError } from './errors/environment';
// -- recover cluster --
// -- render cluster --
// -- skin cluster --

// The declarations below are explicit Runtime entries or identity-preserving
// forwards. Domain components, render systems, pipeline vocabulary, and builtin
// asset handles remain owned by their focused packages; this barrel history is
// not a promise of a broader schema or registry surface.

/**
 * RHI error-model surface (feat-20260511-tetris-retro-followups verify minor-edit).
 *
 * Re-export the closed `RhiError` / `RhiErrorCode` union + detail interfaces so
 * AI users wiring a `'limit-exceeded'` / `'asset-not-registered'` /
 * `'webgpu-runtime-error'` listener only import from `@forgeax/engine-runtime`
 * (charter proposition 1 progressive disclosure + proposition 5 consistent
 * abstraction; plan-strategy §7.1 decision 1 single-entry SSOT — IDE
 * autocomplete on `@forgeax/engine-runtime` already covers the full
 * observable surface, including the failure path). The error-model SSOT
 * still lives in `packages/rhi/src/errors.ts` — this is a thin re-export, no
 * new types or renames.
 *
 * `LimitExceededDetail` carries `{ maxStorageBufferBindingSize,
 * requestedBytes }` (feat-20260513-instanced-mesh M5 D-3 evolution
 * major reshape from the legacy `{ renderableCount, limit }` shape).
 * Read both fields directly through typed property access after the
 * `code === 'limit-exceeded'` discriminant narrows `err.detail`.
 *
 * `Renderer.subscribe` delivers `RendererEvent`. Its `kind: 'error'` arm
 * carries the public Render-owned `RenderError` union. RHI and Asset error
 * codes belong to their direct APIs (for example, `acquireCanvasContext`
 * returns a `Result` with an `RhiError`); they are not alternate
 * `Renderer.subscribe` arms. Read the typed Render detail for the selected
 * code and keep lower-layer causes inside that detail.
 *
 * @example
 *   import type { RenderError } from '@forgeax/engine-render';
 *   renderer.subscribe((event) => {
 *     if (event.kind !== 'error') return;
 *     const error: RenderError = event.error;
 *     if (error.code === 'renderer-contract-failed') {
 *       report(error.detail.operation, error.detail.cause);
 *       return;
 *     }
 *     report(error.code, error.hint);
 *   });
 */
export {
  type LimitExceededDetail,
  type RhiAssetNotRegisteredDetail,
  RhiError,
  type RhiErrorCode,
  type RhiErrorDetail,
  type RhiShaderCompileDetail,
  type RhiWebgpuRuntimeCause,
  type RhiWebgpuRuntimeDetail,
} from '@forgeax/engine-rhi';
/**
 * Asset system SSOT re-exports (feat-20260511-asset-system-v1 / w30 / D-P7 +
 * plan-strategy §7.4 discoverability dual-entry).
 *
 * The error-model SSOT lives in `@forgeax/engine-types` (closed `AssetErrorCode`
 * 4-member union + `AssetError` class + `ASSET_ERROR_HINTS` per-code hint table);
 * this barrel is a thin re-export so AI users can write a single-line import —
 *
 *   import type { Asset } from '@forgeax/engine-assets-runtime';
 *   import type { Handle } from '@forgeax/engine-types';
 *   import { AssetError } from '@forgeax/engine-runtime';
 *
 * — and let IDE autocomplete on `@forgeax/engine-runtime` cover the full asset
 * surface (charter proposition 1 progressive disclosure). `@forgeax/engine-types`
 * remains a valid import entry for AI users that want the bare SSOT layer.
 */
export {
  AssetError,
  type AssetErrorCode,
  type Handle,
  MATERIAL_PARAM_TYPES,
  type MaterialAsset,
  type MaterialPass,
  type ParamSchemaEntry,
  type RenderQueue,
  type SamplerAsset,
  type TextureAsset,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
// feat-20260705-runtime-tier2-decomposition M1 / w14: Asset / MeshAsset types
// moved to @forgeax/engine-assets-runtime (AC-105).
// feat-20260705-runtime-tier2-decomposition M1 / w14: AssetRegistry + the
// HANDLE_* builtin mesh handles moved to @forgeax/engine-assets-runtime (AC-105).
// feat-20260705-runtime-tier2-decomposition M1 / w14: the process-static
// BuiltinAssetRegistry tier (BUILTIN_* payloads) moved to
// @forgeax/engine-assets-runtime (AC-105). Geometry owns the shared runtime
// vertex layout.
// Runtime-specific authoring components remain here. Domain authorities are
// imported directly from @forgeax/engine-scene, @forgeax/engine-animation,
// @forgeax/engine-skinning, and @forgeax/engine-render.
/**
 * GlyphText authoring component for world-space MSDF text
 * (feat-20260531-world-space-msdf-text-rendering M4 / w14). Carries
 * `fontHandle` / `text` / `fontSize` / `color: array<f32, 4>`; the
 * `glyphTextLayoutSystem` (this package) bakes a MeshAsset and attaches
 * MeshFilter + MeshRenderer (plan-strategy D-2; GlyphText is pure authoring
 * data, baking is a system responsibility). Co-located with its consuming
 * system in `@forgeax/engine-runtime` so AI users import the component and
 * the system from one package.
 */
/**
 * feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M1 / w4 —
 * SpriteInstances primitive: 2D peer of `Instances`. Carries per-instance
 * mat4 (stride 16) + per-instance UV region (stride 4). Exported directly
 * from the @forgeax/engine-runtime barrel so AI users discover both
 * primitives side-by-side via IDE autocomplete on `@forgeax/engine-runtime`.
 * Per plan-strategy D-8, the barrel re-export lives here (runtime top-level),
 * not in `@forgeax/engine-ecs` — the ecs package stays unaware of the sprite
 * shading model concept.
 */
// feat-20260604-hdr-equirect-cube-importer-loader M4 / w15: the dev-only
// ImportTransport factory. A host wires it into createRenderer / createApp so
// a DDC miss at runtime triggers an on-demand POST /__import import against the
// vite-plugin-pack dev server. Aligned with the create*/wire* factory family.
export { createDevImportTransport } from './dev-import-transport';
// feat-20260705-runtime-tier2-decomposition M3 / w31: glyph-layout +
// glyph-mesh-bake (FONT_CONCURRENCY_LIMIT /
// GlyphLayoutResult / layoutGlyphText / resetFontConcurrency /
// trackFontConcurrency / VERTEX_OFFSET / bakeGlyphMesh / buildGlyphMeshAsset /
// conservativeCubeAabb / GlyphMeshBakeResult) moved to
// @forgeax/engine-graphics-extras (AC-303). Zero shim -- import from that
// package. glyphTextLayoutSystem stays here (system entry, S12).
/**
 * glyphTextLayoutSystem (feat-20260531-world-space-msdf-text-rendering) -- lays
 * out + bakes every `GlyphText` entity, attaching MeshFilter + MeshRenderer on
 * first observation and re-baking in place on a text / size / color change.
 * `createApp` attaches the World and owns the returned render lease before
 * the first frame; `Renderer.draw` consumes only that lease-bound request.
 */
/**
 * GpuBuffer / GpuTexture runtime wrappers + GpuResource union
 * (feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M2).
 *
 * AI-user-facing handles for explicit GPU lifecycle:
 *   - `new GpuBuffer(device, handle).destroy()`
 *   - `new GpuTexture(device, handle).destroy()`
 *   - `type GpuResource = GpuBuffer | GpuTexture` for "dispose any
 *     GPU resource" call sites (charter §F1 single-entry).
 *
 * Forwarding shape (D-7 SSOT): the wrapper forwards to
 * `device.destroyBuffer / destroyTexture`; the destroyed: boolean
 * bookkeeping lives once on the RHI shim. Second `.destroy()` returns
 * `Result.err({ code: 'destroy-after-destroy' })`.
 */
/**
 */
// feat-20260705-runtime-tier2-decomposition M1 / w14: the loader-injection
// surface (LoaderRegistry / wireDefaultLoaders / createDefaultLoaderRegistry)
// moved to @forgeax/engine-assets-runtime (AC-105).
// feat-20260705-runtime-tier2-decomposition M2 / w25: the picking cluster
// (pick / pickVertex / pickVertexOnEntity / pickTile + PickHit / VertexHit /
// PickError / PickErrorCode / PickTileError / PickTileHit) moved to
// @forgeax/engine-picking (AC-204). Zero shim -- import from that package.
// Render-domain declarations and scene traversal primitives are not Runtime
// exports. Import them from their owning focused package instead of inferring
// an export from an old Runtime comment.
// feat-20260705-runtime-tier2-decomposition M1 / w14: resolveAssetHandle moved
// to @forgeax/engine-assets-runtime (AC-105).
export type { SpriteParamValues } from './sprite-param-values';
// feat-20260630-viewport-2x2-run-x-display-redesign M2 / w12 / plan-strategy D-2:
// engine-neutral by-entity-id active camera selection (no editor concept).
/**
 * Transparent-bucket sort configuration (feat-20260520-2d-sprite-layer-mvp
 * M-2 w14). The POD interface + 3 named mode constants + `get/set`
 * helpers form the entire AI-user-visible surface for transparent sort
 * mode selection — see `transparent-sort-config.ts` JSDoc head for the
 * 5-view selection table (horizontal / top-down / Don't-Starve /
 * isometric / JRPG).
 *
 * `setTransparentSortConfig` returns
 * `Result<void, ResourceInvalidValueError>`; AI users self-repair by
 * reading `.code / .expected / .hint / .detail` property access on the
 * err branch (charter P3 structured failure SSOT).
 *
 * @example
 *   import {
 *     TRANSPARENT_SORT_CONFIG_KEY,
 *     TRANSPARENT_SORT_MODE_LAYER_Y,
 *     setTransparentSortConfig,
 *   } from '@forgeax/engine-render/authoring';
 *   const r = setTransparentSortConfig(world,
 *     { mode: TRANSPARENT_SORT_MODE_LAYER_Y, yzAlpha: 1.0 });
 */
/**
 * Sprite-animation tick system (feat-20260521-sprite-atlas-animation M4 /
 * T-24). Walks every entity carrying `SpriteAnimation`, advances the
 * per-entity dt accumulator clock, and writes the current frame's UV
 * slice into `SpriteRegionOverride`. Returns
 * `Result<void, SpriteAnimationInvalidError>` so AI users self-repair
 * via `.code / .expected / .hint / .detail` property access on the err
 * branch (charter P3 structured failure SSOT).
 *
 * Wire into the `App` schedule between input/time and `RenderSystem.
 * extract`; the M3 sprite-bucket extract branch reads the override
 * column populated by this tick.
 *
 * @example
 *   import { spriteAnimationTickSystem } from '@forgeax/engine-runtime';
 *   const app = createApp({ canvas, schedule: { update: [
 *     spriteAnimationTickSystem,
 *   ] } });
 */
export { spriteAnimationTickSystem } from './systems/sprite-animation-tick';
// feat-20260705-runtime-tier2-decomposition M3 / w31: tile-bits (decodeTileBits
// / encodeTileBits) moved to @forgeax/engine-graphics-extras (AC-303). Zero shim
// -- import from that package. tilemapChunkExtractSystem stays here (system
// entry, S12).
// feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild — chunk-extract system
// feat-20260705-runtime-tier2-decomposition M3 / w31: the video cluster
// (VIDEO_SOURCE_PROVIDER_KEY / VideoSourceProvider / videoLoader / VideoPlayer
// / probeVideoHighPerfUpload / VideoCapabilityDevice) moved to
// @forgeax/engine-graphics-extras (AC-303). Zero shim -- import from that
// package.
// feat-20260705-runtime-tier2-decomposition M1 / w14: createDefaultLoaderRegistry
// + wireDefaultLoaders moved to @forgeax/engine-assets-runtime. Consumers import
// them from that package directly (AC-105).

// ─── Math namespace re-export (M2 / w15) ────────────────────────────────

/**
 * `quat` namespace re-export from `@forgeax/engine-math`.
 *
 * AI users write a single import from engine-runtime to get the full
 * quaternion surface (16+ functions: create / fromEuler / multiply /
 * slerp / eulerY / transformVec3 etc.) without cross-package math
 * topology memory (charter P4 consistent abstraction).
 *
 * engine-math has zero Node-only dependencies per feat-20260524
 * browser-safe-subexports -- this barrel re-export does not trigger
 * the browser-safe gate.
 *
 * @example
 * ```ts
 * import { quat } from '@forgeax/engine-runtime';
 * const yaw = quat.eulerY(Math.PI / 4);
 * ```
 */
export { quat } from '@forgeax/engine-math';

// w8: Inspector contributor (registerRuntimeInspector + RegisterRuntimeInspectorResult)
// deleted — routing layer (Registry / sandbox) is removed; eval is the sole
// command channel.

// ─── Animation system wiring (M1 / T-19 - feat-20260523-skin-skeleton-animation) ──

// w8: registerRuntimeInspector export deleted alongside register-inspector.ts removal.

// feat-20260623-editor-openproject M2 w11+w12: SceneInstance→SceneAsset writeback
// chain (plan-strategy D-1: pure-data collection + pack serialization).
//
// feat-20260701-rootstosceneasset-forest-collect-schema-derived-ha M3:
// collectSceneAsset removed — replaced by rootsToSceneAsset (forest entry,
// schema-derived field dispatch, engine-self-contained GUID resolution).
// serializeSceneAssetToPack now uses schema-derived refs[] index (D-1/D-2).
export {
  rootsToSceneAsset,
  type SceneAssetGuidLookup,
  serializeSceneAssetToPack,
} from './collect-scene-asset';
// feat-20260626 M6 / m6-4: debug-draw auto-attach glue is re-exported from the
// main barrel (was a separate tsup entry). The separate entry produced a SECOND
// module copy of the mutable `registeredDebugDraw` registry: createApp set it on
// the subpath copy, but the URP/HDRP pipelines (bundled into index) read their
// own always-null copy AND tsup dead-code-eliminated the flush body into a stub,
// so DebugDraw.flush() never ran in the browser build (debug overlay leaked +
// never rendered). One barrel entry => one module copy => one registry shared by
// createDebugDrawOnReady (the writer) and attachDebugOverlayPass (the reader).
// feat-20260704-runtime-tier1-decomposition M2 / w10 (D-3): the third error
// re-export block (Standard Cluster error classes) is folded into the render-cluster class
// re-export block above -- they are render-cluster members sourced from
// ./errors/render.
// cache-bust-marker for feat-20260615-fbx-importer-via-sdk PR-CI run on bf1d383f / 05a331cd (post-rebase tsbuildinfo restore-keys staleness)
