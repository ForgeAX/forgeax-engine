// Asset and font error contracts.

import type { VertexAttributeMap, VertexAttributePackDetail } from './media-contracts.js';
import type { MeshMaterialOverrideConflict } from './mesh-contracts.js';

// === Asset error model SSOT (feat-20260511-asset-system-v1 / D-P1 / w3) =========
//
// Decision anchors:
// - requirements §G3 + AC-03 + AC-10 + AC-21 + §1 callout row 9 (4-member closed
//   `AssetErrorCode` independent from `RhiErrorCode`; `AssetError` class with
//   `.code / .expected / .hint / .message` four-field surface structurally
//   parallel to `RhiError` / `InspectorError` / `MetricError`)
// - plan-strategy §2 D-P1 (`@forgeax/engine-types` single-file SSOT for
//   AssetErrorCode; independent closed union aligned with
//   MetricErrorCode / InspectorErrorCode precedent)
// - plan-strategy §7.3 (per-code `.hint` string literals locked verbatim
//   below; any drift updates both this module and the test fixtures)
// - charter proposition 3 (machine-readable union > prose) + proposition 4
//   (explicit failure — `switch (err.code)` exhaustive without `default:`) +
//   proposition 5 (consistent abstraction — structurally parallel to
//   `@forgeax/engine-rhi` `RhiError` surface)
// - architecture-principles #1 SSOT (the 4 literals + class shape live here
//   once; M4 AssetRegistry / M3 Geometry factories / AGENTS.md §Error model
//   row all reference this module)

/**
 * Closed `AssetErrorCode` union — 23 members (D-P1 + feat-20260518 D-1 minor
 * evolution + feat-20260520-skylight-ibl-cubemap 5 members +
 * feat-20260523 mesh-upload-fix 1 member +
 * feat-20260523-shader-template-instance-split M1-T02 1 member +
 * feat-20260526-material-asset-multipass-renderstate M1 1 member +
 * feat-20260603-asset-import-loader-injection M1 2 members +
 * feat-20260604-hdr-equirect-cube-importer-loader M2 1 member +
 * feat-20260608-mesh-multi-section-primitive-multi-material-slot M1 3 members +
 * feat-20260621-asset-registry-robustness-invalidate-inflight-cach M2 1 member +
 * feat-20260707-texture-block-compression M5 1 member
 * (mipgen-unsupported-compressed-format);
 * requirements §G3 + AC-03 + AC-21 +
 * feat-20260518 AC-02 + bug-20260523 AC-01. The runtime-guard SSOT for the
 * current member count is the ASSET_ERROR_HINTS key-count test, not this prose.)
 * Exhaustive `switch (err.code)` needs no default fallback — TypeScript guards
 * union completeness at compile time (charter F2/P2 machine-readable union >
 * prose + P3 explicit failure).
 *
 * Domain-separated from `RhiErrorCode 'asset-not-registered'` (which is a
 * render-time registry lookup miss, 18-member closed union in
 * `@forgeax/engine-rhi/src/errors.ts`). The two unions cover disjoint
 * lifecycle phases — AI users face only these 22 alternatives on the
 * `engine.assets.loadByGuid(guid)` / `engine.assets.get(handle)` /
 * `engine.assets.register(payload).unwrap()` surface.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'asset-not-found'` | `AssetRegistry.get(handle)` returned no entry (handle never registered or registry was reset); charter P3 explicit failure. |
 * | `'asset-parse-failed'` | decoded bytes are not a valid image (PNG / JPG header corruption on the load path; dimensions <= 0 / segments < 1 on the procedural geometry constructor path — double semantics locked by requirements §9 "constructor path" extension). |
 * | `'asset-format-unsupported'` | URL content-type / magic bytes are neither PNG nor JPG (v1 scope; KTX2 / Basis / GLTF embedded textures deferred to M3+). |
 * | `'asset-fetch-failed'` | `fetch(url)` returned non-2xx, threw, or the URL was otherwise unreachable (404 / network / CORS surface). |
 * | `'asset-invalid-value'` | `register<MaterialAsset>(payload)` value validation fails the 3-tier validator (type-mismatch / extra-key / missing-required) — fail-fast at register entry. |
 * | `'cubemap-handle-missing'` | internal equirect-to-cubemap projection has no live cubemap for a `Skylight.equirect` handle; `.hint` points to loading an EquirectAsset + caps.rgba16floatRenderable. |
 * | `'invalid-source-format'` | image importer path when `.hdr` decode needs rgba16float / rgba32float. |
 * | `'load-failed'` | `loadByGuid` when guid entry exists in catalog but file is inaccessible. |
 * | `'device-unsupported'` | GPU capability gate: `device.caps.rgba16floatRenderable` missing. |
 * | `'ibl-precompute-not-dispatched'` | `IblPipelineCache` when counter increments but `queue.submit` hasn't been called. |
 * | `'mesh-vertex-stride-mismatch'` | `register({ kind: 'mesh', ... })` vertices buffer is not evenly divisible by 12 floats per vertex (position vec3 + normal vec3 + uv vec2 + tangent vec4) or `maxIndex+1 !== vertexCount` — fail-fast at register entry (charter P3 structured failure; `.detail` carries `vertexCount` / `floatsPerVertex`). |
| `'material-circular-inheritance'` | material resolve detected a cycle in the parent chain; `.hint` carries the full cycle path (e.g. "A -> B -> A") via `err.detail.cycle`. |
 * | `'loader-not-registered'` | `loadByGuid` dispatched on `asset.kind` but the injected `LoaderRegistry` has no loader for that kind; `.detail.kind` is the missing kind and `.detail.registeredKinds` lists the kinds currently wired (feat-20260603-asset-import-loader-injection M1; charter P3 — AI users read `.detail.registeredKinds` to know what to inject). |
 * | `'asset-not-imported'` | `loadByGuid` found the GUID in the catalog but its DDC is absent and no `ImportTransport` is wired (shipped form); `.hint` points back to build-time pre-import rather than a runtime workaround (feat-20260603-asset-import-loader-injection M4; logic wired in M4 w31). |
 * | `'texture-source-not-imported'` | `loadTextureAsset` received an uncooked source locator instead of a Pack v2 artifact; the runtime carries no source decoder. |
 */
export type AssetErrorCode =
  | 'asset-not-found'
  | 'asset-parse-failed'
  | 'asset-format-unsupported'
  | 'asset-fetch-failed'
  | 'catalog-source-unconfigured'
  | 'asset-invalid-value'
  | 'cubemap-handle-missing'
  | 'invalid-source-format'
  | 'load-failed'
  | 'device-unsupported'
  | 'ibl-precompute-not-dispatched'
  | 'mesh-vertex-stride-mismatch'
  // === 1 new code (feat-20260523-shader-template-instance-split M1-T02) ===
  | 'material-shader-ref-broken'
  // === 1 new code (feat-20260526-material-asset-multipass-renderstate M1 / w6) ===
  | 'material-circular-inheritance'
  // === 2 new codes (feat-20260603-asset-import-loader-injection M1 / w1) ===
  | 'loader-not-registered'
  | 'asset-not-imported'
  // === 1 new code (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4) ===
  | 'texture-source-not-imported'
  // === 1 new code (perf-20260706-raw-container-failfast) ===
  // A mesh/material/scene/skeleton/skin/animation-clip catalog row whose
  // packageUrl is still a raw source container (.glb/.gltf/.fbx), not an
  // importer-produced artifact (.bin/.pack.json). Like texture-source-not-imported
  // this is transport-eligible: the studio form lazily imports via the injected
  // ImportTransport; the shipped form fails fast. Distinct from the generic
  // asset-not-imported so it never masks the parent-missing breadcrumb.
  | 'source-not-imported'
  // === 3 new codes (feat-20260608-mesh-multi-section-primitive-multi-material-slot M1 / w2) ===
  | 'mesh-renderer-material-override-invalid'
  | 'mesh-renderer-material-override-overflow'
  | 'mesh-asset-submeshes-empty'
  | 'mesh-asset-material-slot-index-out-of-range'
  | 'mesh-submesh-index-range-out-of-bounds'
  // === 1 new code (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
  // Tileset region rectangle out of atlas extent OR tile entry regionIndex out of
  // regions array bounds (single closed code per plan-strategy §D-6 first-error
  // ordering). 19 -> 20 baseline-restored.
  | 'tileset-region-index-out-of-range'
  // === 1 new code (feat-20260629-multi-uv-set-support M2 / m2-w5) ===
  // mesh-bin header v2 contract violation: version unknown, uvSetCount out of
  // [0,8], or stride/floatsPerVertex self-consistency check failed at encode
  // exit or decode entry (Fail Fast). Carries detail { version, uvSetCount,
  // stride }. .hint = 're-cook the asset via importer'.
  | 'mesh-bin-contract-violation'
  // === 1 new code (feat-20260608-tilemap-object-layer-rendering M1 schema extension) ===
  // Tile entry optional field (widthCells / heightCells / pivotX / pivotY /
  // collider) or top-level atlases / region.atlasIndex schema invariant
  // breached at register time. `.detail.field` carries the closed 7-variant
  // enum + `.scope?` is 'tile-entry' | 'tileset-asset' (plan-strategy §D-6;
  // charter P3 closed enum + AI-grep affordance). 20 -> 21 M1 net add.
  | 'tileset-tile-entry-malformed'
  // === 1 new code (feat-20260621-asset-registry-robustness-invalidate-inflight-cach M2 / w4) ===
  | 'asset-invalidated'
  // === 1 new code (feat-20260707-texture-block-compression M5 / w35, D-9) ===
  // deriveRenderDataTexture fail-fast: a block-compressed `format` requested
  // RUNTIME mip generation (`mipmap:true` with no offline `mipLevelCount>1`
  // chain). Compressed formats are not render targets, so the mipmap blit
  // pipeline cannot generate their mips (F-7); the chain must be baked offline.
  // `.hint` carries the self-recovery (bake offline mips, or set the sidecar
  // `compressionMode:'none'`). A compressed texture whose mips are ALREADY in
  // `data` (mipLevelCount>1 from a KTX2 level chain) does NOT trip this gate.
  | 'mipgen-unsupported-compressed-format';

/**
 * Structured asset error -- four-field surface (`.code` / `.expected` /
 * `.hint` / `.message`) structurally parallel to `@forgeax/engine-rhi`
 * `RhiError` + `@forgeax/engine-remote` `InspectorError` + `MetricError`
 * (charter proposition 5 consistent abstraction; AGENTS.md "Errors are
 * structured. Return Result, never throw for expected failures.").
 *
 * AI users consume the structured triple via property access:
 * `switch (err.code) { case 'asset-fetch-failed': ... err.hint ... }`
 * -- never by parsing `.message` (charter proposition 4 explicit failure
 * red line).
 *
 * The `.message` field is auto-composed for human stack traces and carries
 * the same content as `.code` + `.expected` + `.hint`; AI users prefer
 * field access on the structured triple.
 *
 * @example AI-user exhaustive switch on the 22 members (no default fallback)
 * ```ts
 * import { AssetError, type AssetErrorCode } from '@forgeax/engine-types';
 *
 * function recover(code: AssetErrorCode): string {
 *   switch (code) {
 *     case 'asset-not-found':          return 'ensure handle was registered before get()';
 *     case 'asset-parse-failed':       return 'check file integrity or geometry dimensions';
 *     case 'asset-format-unsupported': return 'convert to PNG or JPG';
 *     case 'asset-fetch-failed':       return 'check url path or dev server';
 *     case 'asset-invalid-value':      return 'read err.hint / err.detail for the case-specific fix';
 *   }
 * }
 * ```
 */
export class AssetError extends Error {
  readonly code: AssetErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: Readonly<AssetErrorDetail>;

  constructor(args: {
    code: AssetErrorCode;
    expected: string;
    hint: string;
    detail?: Readonly<AssetErrorDetail>;
  }) {
    super(`[AssetError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'AssetError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    if (args.detail !== undefined) {
      this.detail = args.detail;
    }
  }
}

/**
 * Per-code `.hint` string literals (plan-strategy §7.3 lock-in). Exported
 * so M3 Geometry factories / M4 AssetRegistry / tests consume the same
 * SSOT — any drift here updates both producer call sites and the
 * AGENTS.md §Error model table.
 *
 * The shape is a `Record<AssetErrorCode, string>` so future additions to
 * the closed union are a compile-time error here as well (reinforces
 * charter proposition 4 explicit failure).
 */
export const ASSET_ERROR_HINTS: Readonly<Record<AssetErrorCode, string>> = {
  'asset-fetch-failed':
    'check url path; verify dev server is running; in tests use data: URL fixture (data:image/png;base64,...)',
  'catalog-source-unconfigured':
    'call AssetRegistry.setCatalogSource(source) before enumerateCatalog(), then retry the operation',
  'asset-parse-failed':
    'check file bytes are not corrupted; for procedural geometry: verify all dimensions > 0 and segments >= 1',
  'asset-format-unsupported':
    'v1 supports png/jpg only; convert .bmp/.webp etc. via image tooling; gltf/glb supported via @forgeax/engine-gltf importer (forgeax asset import <gltf-or-glb> --root <project>)',
  'asset-not-found':
    'handle id not in registry; verify register() was called before get(); inspect() returns all live handles',
  'asset-invalid-value':
    'a register-time value failed validation; read err.hint for the case-specific fix (e.g. clamp a MaterialAsset param to [0,1], or give a strip-topology MeshAsset an index buffer) and err.detail for the offending field/value',
  'cubemap-handle-missing':
    'the equirect-to-cubemap projection (internal to the render-system record arm) has no live cubemap for this Skylight; ensure Skylight.equirect references a loaded EquirectAsset handle and caps.rgba16floatRenderable is true',
  'invalid-source-format':
    'decode .hdr via @forgeax/engine-image first; supported formats are rgba16float and rgba32float',
  'load-failed':
    'source asset could not be loaded; check GUID validity and file accessibility in the pack-index catalog',
  'device-unsupported':
    'GPU device lacks required capability; check device.caps for rgba16float renderable feature',
  'ibl-precompute-not-dispatched':
    'check IblPipelineCache.runIblPrecompute is called inside the internal GpuResourceStore equirect-to-cubemap projection; counters must not increment before queue.submit (plan D-7 / N-3 AC-20 invariant)',
  'mesh-vertex-stride-mismatch':
    'use meshFromInterleaved (packages/runtime/src/geometry/box.ts) or expand vertices buffer to canonical 12F layout (position vec3 + normal vec3 + uv vec2 + tangent vec4)',
  // === 1 new hint (feat-20260523-shader-template-instance-split M1-T02) ===
  'material-shader-ref-broken':
    'the materialShader identifier (path or GUID) resolves to no registered shader; check ShaderRegistry for path identifiers or AssetRegistry for GUID sub-assets',
  // === 1 new hint (feat-20260526-material-asset-multipass-renderstate M1 / w6) ===
  'material-circular-inheritance':
    'circular parent chain detected; inspect parent handles — use err.detail.cycle to see the full path (e.g. "A -> B -> A")',
  // === 2 new hints (feat-20260603-asset-import-loader-injection M1 / w1) ===
  'loader-not-registered':
    'no loader registered for this asset kind; register it via engine.assets.loaders.register(loader) (the loader carries its own kind); err.detail.registeredKinds lists the kinds currently wired',
  'asset-not-imported':
    'GUID is in the catalog but its DDC artefact is missing and no ImportTransport is wired (shipped form never falls back to a runtime import); add the asset to the build-time pre-import step instead of importing at runtime',
  // === 1 new hint (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4) ===
  'texture-source-not-imported':
    'texture source not imported yet; wire createDevImportTransport() in the studio form for dev lazy-import, or pre-import via the build-time pipeline',
  // === 1 new hint (perf-20260706-raw-container-failfast) ===
  'source-not-imported':
    'this mesh/material/scene sub-asset row still points at the raw source container (.glb/.gltf/.fbx); wire createDevImportTransport() for dev lazy-import (POST /__import), or pre-import via the build-time pipeline. The runtime does not parse raw containers at load time.',
  // === 3 new hints (feat-20260608-mesh-multi-section-primitive-multi-material-slot M1 / w2) ===
  'mesh-renderer-material-override-invalid':
    'a MeshRenderer.materials slot is stale or does not resolve to a MaterialAsset; the renderer inherited the MeshAsset default for that slot',
  'mesh-renderer-material-override-overflow':
    'MeshRenderer.materials contains entries beyond MeshAsset.materialSlots; extra overrides are ignored',
  'mesh-asset-submeshes-empty':
    'MeshAsset.submeshes must have at least one entry; every mesh must declare at least one submesh; check MeshAsset registration payload for empty submeshes array',
  'mesh-asset-material-slot-index-out-of-range':
    'MeshAsset submesh materialSlot must index MeshAsset.materialSlots; re-cook the mesh and inspect the offending submesh/slot topology',
  'mesh-submesh-index-range-out-of-bounds':
    'submesh indexOffset + indexCount exceeds the parent mesh index buffer length; check submesh index range bounds against MeshAsset.indices and MeshAsset.vertices; err.detail carries submeshIndex, indexOffset, indexCount, indexBufferLength, and meshAssetGuid',
  // === 1 new hint (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
  'tileset-region-index-out-of-range':
    'a TilesetAsset.regions[] rectangle escapes the atlas extent OR a TilesetAsset.tiles[].regionIndex points past TilesetAsset.regions.length; check regions[i] (x + width <= atlasWidth, y + height <= atlasHeight) and tiles[i].regionIndex in [0, regions.length); err.detail carries tilesetGuid, tileId, regionIndex, regionCount',
  // === 1 new hint (feat-20260608-tilemap-object-layer-rendering M1 schema extension) ===
  'tileset-tile-entry-malformed':
    'a TilesetTileEntry optional field is out of range (widthCells / heightCells in (0, 64], pivotX / pivotY in [0, 1], collider rect/polygon in normalized [0,1]^2 with rect.length === 4 and polygon.points.length >= 3) OR a top-level field is out of range (atlases.length >= 1, region.atlasIndex in [0, atlases.length)); engine fail-fast at register-time. read err.detail.field (closed enum) + err.detail.scope (tile-entry | tileset-asset) + err.detail.tileEntryIndex to locate the offending entry; switch (err.detail.field) covers the 7 variants exhaustively without default',
  // === 1 new hint (feat-20260621-asset-registry-robustness-invalidate-inflight-cach M2 / w4) ===
  'asset-invalidated':
    'The asset was invalidated during load; call loadByGuid(guid) again to retry with a fresh fetch',
  // === 1 new hint (feat-20260629-multi-uv-set-support M2 / m2-w5) ===
  'mesh-bin-contract-violation':
    're-cook the asset via importer; the .bin sidecar v4 contract is violated — inspect err.detail.reason and its expected/actual projection, stride, cardinality, and byte-length facts',
  // === 1 new hint (feat-20260707-texture-block-compression M5 / w35, D-9) ===
  'mipgen-unsupported-compressed-format':
    'compressed-texture mips must be baked offline (the GPU cannot generate mips for a non-render-target block format); re-cook with an offline mip chain, or set the sidecar .meta.json compressionMode:"none" (or mipmap:false) to keep runtime mip generation on an uncompressed texture',
};

// === Font error model SSOT (feat-20260531-world-space-msdf-text-rendering M2 / w6) ===
//
// Decision anchors:
//   - plan-strategy D-11 (two closed unions: FontErrorCode = build/load phase,
//     TextErrorCode = runtime layout phase; structured .code/.expected/.hint/.detail;
//     TOFU is rendering behaviour not an error — AC-14)
//   - requirements AC-15 (non-TTF -> FontErrorCode 'unsupported-font-format')
//   - requirements AC-16 (both unions in types/src/index.ts; exhaustive
//     switch(err.code) without default compiles)
//   - requirements AC-20 (font concurrency > 8 -> TextErrorCode
//     'font-concurrency-exceeded')
//   - charter P3 (explicit failure: structured error > silent behaviour,
//     D-8 rejects silent LRU eviction for concurrency violation)
//
// Domain separation: FontErrorCode covers build-time bake failures and
// load-time atlas/sampler resolution; TextErrorCode covers runtime glyph
// layout and text rendering failures.

/**
 * Closed `FontErrorCode` union — build-time bake + load-time resolution
 * errors (plan-strategy D-11).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'unsupported-font-format'` | bake receives non-TTF input (OTF / WOFF2); `.expected: 'ttf'` (AC-15) |
 * | `'font-atlas-missing'` | loadByGuid font handle has missing/empty atlas texture GUID |
 * | `'font-atlas-corrupted'` | sidecar JSON parse failed or glyph metrics shape invalid |
 * | `'bake-failed'` | @zappar/msdf-generator call threw (wasm unavailable / internal error) |
 */
export type FontErrorCode =
  | 'unsupported-font-format'
  | 'font-atlas-missing'
  | 'font-atlas-corrupted'
  | 'bake-failed';

/**
 * Closed `TextErrorCode` union — runtime glyph layout and text rendering
 * errors (plan-strategy D-11).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'font-concurrency-exceeded'` | > 8 distinct FontAsset handles active in one frame; `.expected: 8` (AC-20) |
 * | `'font-atlas-missing'` | glyph layout system resolved fontHandle but atlas texture is not yet uploaded |
 * | `'glyph-layout-failed'` | layout computation encountered unexpected state (empty common block, etc.) |
 */
export type TextErrorCode =
  | 'font-concurrency-exceeded'
  | 'font-atlas-missing'
  | 'glyph-layout-failed';

/**
 * Structured font error — four-field surface (`.code` / `.expected` /
 * `.hint` / `.message`) in the style of {@link AssetError}.
 *
 * AI users consume via property access:
 * `switch (err.code) { case 'unsupported-font-format': ... err.expected ... }`
 * — never by parsing `.message`.
 */
export class FontError extends Error {
  readonly code: FontErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(args: {
    code: FontErrorCode;
    expected: string;
    hint: string;
    detail?: Readonly<Record<string, unknown>>;
  }) {
    super(`[FontError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'FontError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    if (args.detail !== undefined) {
      this.detail = args.detail;
    }
  }
}

/**
 * Structured text error — four-field surface (`.code` / `.expected` /
 * `.hint` / `.message`) in the style of {@link AssetError}.
 *
 * AI users consume via property access:
 * `switch (err.code) { case 'font-concurrency-exceeded': ... err.hint ... }`
 * — never by parsing `.message`.
 */
export class TextError extends Error {
  readonly code: TextErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(args: {
    code: TextErrorCode;
    expected: string;
    hint: string;
    detail?: Readonly<Record<string, unknown>>;
  }) {
    super(`[TextError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'TextError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    if (args.detail !== undefined) {
      this.detail = args.detail;
    }
  }
}

// === AssetErrorDetail discriminated union (feat-20260523-shader-template-instance-split M1-T02) ===
//
// Introduced to type-narrow the AssetError.detail field for the new
// 'material-shader-ref-broken' variant. Existing AssetErrorCode members
// keep their Record<string, unknown> detail shapes; the union is
// backward-compatible because the detail field on AssetError is optional.

/**
 * Detail for `material-shader-ref-broken` — materialShader identifier
 * (path or GUID) could not be resolved to a registered shader.
 */
export interface AssetMaterialShaderRefBrokenDetail {
  readonly code: 'material-shader-ref-broken';
  readonly materialAssetGuid: string;
  readonly missingShaderId: string;
  readonly materialShaderPath?: string;
}

/**
 * Detail for `tileset-region-index-out-of-range` (feat-20260608 M0 baseline rebuild).
 *
 * Carries the offending tileset GUID + tile-entry index + the rejected
 * `regionIndex` + the live `regionCount` so AI consumers can pinpoint
 * the malformed payload field via property access (charter P3 / P4).
 *
 * Surfaced by `validateTilesetPayload` along two paths:
 *   - region rectangle escapes the parent atlas extent
 *     (regionIndex == the offending rectangle index).
 *   - `tiles[i].regionIndex` >= `regions.length` (or negative)
 *     (tileId encodes which entry; regionIndex carries the rejected value).
 */
export interface AssetTilesetRegionIndexOutOfRangeDetail {
  readonly code: 'tileset-region-index-out-of-range';
  readonly tilesetGuid: string;
  readonly tileId: number;
  readonly regionIndex: number;
  readonly regionCount: number;
}

/**
 * Detail for `tileset-tile-entry-malformed` (feat-20260608 M1 schema
 * extension; plan-strategy §D-6).
 *
 * Closed 7-variant `.field` enum locks the AI-grep affordance: switch
 * (detail.field) over the union compiles without default (charter P3).
 *
 *   - `widthCells` -- `tiles[i].widthCells` out of `(0, 64]`.
 *   - `heightCells` -- `tiles[i].heightCells` out of `(0, 64]`.
 *   - `pivotX` -- `tiles[i].pivotX` out of `[0, 1]`.
 *   - `pivotY` -- `tiles[i].pivotY` out of `[0, 1]`.
 *   - `collider` -- `tiles[i].collider` schema invariant (rect.length !==
 *     4 / rect dimension out of `[0, 1]^2` / polygon.points.length < 3 /
 *     any point out of `[0, 1]^2` / type discriminator outside the closed
 *     3-variant enum).
 *   - `atlases` -- top-level `atlases.length < 1` (empty atlas list).
 *   - `atlasIndex` -- `regions[i].atlasIndex` outside `[0, atlases.length)`.
 *
 * `.scope?` is `'tile-entry'` when the violation is in `tiles[i].*` (in
 * which case `.tileEntryIndex` carries the offending `tiles[]` index) and
 * `'tileset-asset'` when the violation is at the top level (atlases /
 * region atlasIndex).
 */
export interface AssetTilesetTileEntryMalformedDetail {
  readonly code: 'tileset-tile-entry-malformed';
  readonly field:
    | 'widthCells'
    | 'heightCells'
    | 'pivotX'
    | 'pivotY'
    | 'collider'
    | 'atlases'
    | 'atlasIndex';
  readonly scope?: 'tileset-asset' | 'tile-entry';
  readonly tileEntryIndex?: number;
  readonly tilesetGuid: string;
  readonly expected?: string;
  readonly hint?: string;
}

/**
 * Detail for `mesh-bin-contract-violation`.
 *
 * The mesh-bin header is a projection of the canonical geometry layout. Keep
 * the complete wire facts in the structured detail so recovery never depends
 * on parsing the human-facing `expected` / `actual` strings. `sourceKey` and
 * `reason` identify the owning payload and the failed invariant; the nested
 * snapshots preserve the lossless expected/actual cardinality facts.
 */
export type AssetMeshBinContractViolationReason =
  | 'header-truncated'
  | 'version-unsupported'
  | 'header-invalid'
  | 'projection-mismatch'
  | 'payload-length-mismatch'
  | 'metadata-invalid'
  | 'attribute-invalid'
  | 'payload-non-finite';

export interface AssetMeshBinContractFacts {
  readonly field?:
    | 'byteLength'
    | 'version'
    | 'projectionVersion'
    | 'mask'
    | 'stride'
    | 'digest'
    | 'vertexBytes'
    | 'indexBytes'
    | 'jsonBytes'
    | 'metadata'
    | 'attribute';
  readonly attribute?: keyof VertexAttributeMap;
  readonly elementIndex?: number;
  readonly expectedLength?: number;
  readonly actualLength?: number;
  readonly actualValue?: 'nan' | 'positive-infinity' | 'negative-infinity';
  readonly version?: number;
  readonly projectionVersion?: number;
  readonly mask?: number;
  readonly digest?: string;
  readonly stride?: number;
  readonly vertexCount?: number;
  readonly vertexBytes?: number;
  readonly indexCount?: number;
  readonly indexWidth?: number;
  readonly indexBytes?: number;
  readonly jsonBytes?: number;
  readonly byteLength?: number;
}

export interface AssetMeshBinContractViolationDetail {
  readonly code: 'mesh-bin-contract-violation';
  readonly sourceKey: string;
  readonly reason: AssetMeshBinContractViolationReason;
  readonly expected: Readonly<AssetMeshBinContractFacts>;
  readonly actual: Readonly<AssetMeshBinContractFacts>;
}

/**
 * Discriminated detail union for AssetError, narrowed per AssetErrorCode.
 *
 * Variants:
 * - `material-shader-ref-broken` -- materialShader identifier (path or GUID)
 *   could not be resolved to a registered shader; carries materialAssetGuid +
 *   missingShaderId.
 * - `asset-invalid-value` -- a register-time value failed validation;
 *   carries `{ field: string; got: unknown }`.
 * - `mesh-renderer-material-override-overflow` -- override entries exceed
 *   slot count; carries `{ expectedCount, actualCount, meshAssetGuid }`.
 * - `mesh-asset-submeshes-empty` -- MeshAsset.submeshes is empty array;
 *   carries `{ meshAssetGuid }`.
 * - `mesh-submesh-index-range-out-of-bounds` -- submesh index range exceeds
 *   parent mesh index buffer; carries `{ submeshIndex, indexOffset,
 *   indexCount, indexBufferLength, meshAssetGuid }`.
 */
export type AssetErrorDetail =
  | import('./asset.js').AssetCodecFailureDetail
  | AssetMaterialShaderRefBrokenDetail
  | AssetTilesetRegionIndexOutOfRangeDetail
  | AssetTilesetTileEntryMalformedDetail
  | AssetMeshBinContractViolationDetail
  | VertexAttributePackDetail
  | { readonly field: string; readonly got: unknown }
  | { readonly field: string; readonly value: unknown; readonly reason: string }
  | { readonly expectedCount: number; readonly actualCount: number; readonly meshAssetGuid: string }
  | { readonly meshAssetGuid: string; readonly slotIndex: number; readonly handle: number }
  | {
      readonly meshAssetGuid: string;
      readonly slotIndex: number;
      readonly slotName: string;
      readonly defaultMaterialGuid: string;
      readonly actualKind: string;
    }
  | MeshMaterialOverrideConflict
  | {
      readonly meshAssetGuid: string;
      readonly submeshIndex: number;
      readonly materialSlot: number;
      readonly materialSlotCount: number;
    }
  | { readonly meshAssetGuid: string }
  | {
      readonly submeshIndex: number;
      readonly indexOffset: number;
      readonly indexCount: number;
      readonly indexBufferLength: number;
      readonly meshAssetGuid: string;
    }
  // Pre-existing detail shapes used by AssetRegistry / loaders / pipeline-builder
  // (added in M5 / w27 alongside the count-mismatch tightening so the union
  // accommodates every current call site without losing structural narrowing).
  | { readonly sourcePath: string }
  | { readonly kind: string; readonly registeredKinds?: readonly string[] }
  | { readonly key: string; readonly legalPattern: string }
  | { readonly passCount: number }
  | {
      readonly passIndex: number;
      readonly shaderKey: string;
      readonly cause: string;
    }
  | { readonly paramName: string; readonly expectedType: string; readonly got: unknown }
  | { readonly paramName: string; readonly got: unknown }
  | { readonly missingParams: readonly string[] }
  | { readonly cycle: string }
  | {
      readonly localId: number;
      readonly component: string;
      readonly field: string;
      readonly index: number;
      readonly refsLength: number;
    }
  | {
      readonly entityKey: string;
      readonly component: string;
      readonly field: string;
      readonly index: number;
      readonly refsLength: number;
    }
  | { readonly vertexCount: number; readonly floatsPerVertex: number }
  // feat-20260622 verify r1: sub-asset load-failure breadcrumb in structured
  // form. The recursive loader composes the same provenance into the `.hint`
  // string; this variant additionally exposes it for property access so AI
  // users locate the broken edge without parsing the hint (charter P3,
  // requirements section error-self-recovery). `sourceField` plus the keyed
  // `sceneEntityKey` mirror the originating AssetRef edge; both are undefined
  // for transitive (texture) edges with no per-entity origin (D-2).
  | {
      readonly referencedByGuid: string;
      readonly referencedByKind: string;
      readonly subAssetGuid: string;
      readonly sceneEntityKey?: string;
      readonly sourceField?: {
        readonly componentName?: string;
        readonly fieldName: string;
        readonly arrayIndex?: number;
      };
    };
