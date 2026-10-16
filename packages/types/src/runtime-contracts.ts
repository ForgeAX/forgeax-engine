// Runtime-facing shared contracts: GPU aliases, shader/remote/metric errors,
// catalog/loader bridges, and the EngineMetrics protocol.  Kept as one leaf so
// the public index remains a small, explicit barrel without duplicate values.

import type { ArtifactDescriptor } from './asset.js';
import type { Asset } from './core-contracts.js';

// Closed union of runtime-layer error code literals. Defined here as the
// single source of truth for code-string discovery (charter F1: AI users
// grep '@forgeax/engine-types' for all error code families). The error
// classes that carry these codes live in @forgeax/engine-runtime.
//
// Decision anchors:
//   - requirements AC-29 (RuntimeErrorCode +6: skin-joint-count-exceeded /
//     skin-joint-despawned / skin-joint-path-unresolved /
//     skin-instances-coexist-forbidden / vertex-storage-buffer-unavailable /
//     skin-palette-overflow)
//   - plan-strategy D-12 (kebab-case + closed union)
//   - charter P3 (explicit failure: exhaustive switch without default)

/** Closed union of runtime-layer error codes. */
export type RuntimeErrorCode =
  | 'shadow-invalid-config'
  | 'skin-joint-count-exceeded'
  | 'skin-joint-despawned'
  | 'skin-joint-path-unresolved'
  | 'skin-instances-coexist-forbidden'
  | 'vertex-storage-buffer-unavailable'
  | 'skin-palette-overflow'
  | 'material-resolved-empty-passes'
  | 'equirect-projection-failed'
  | 'mesh-ssbo-capacity-exceeded'
  | 'mesh-ssbo-ceiling-reached';

// === GPUFlagsConstant namespace numeric aliases (5 *Flags + 8 Size/Index/Offset/SampleMask) ===
//
// One-to-one with the W3C CR §3.6 `unsigned long` definitions; runtime values are
// surfaced by the global objects (GPUBufferUsage / GPUColorWrite / GPUMapMode /
// GPUShaderStage / GPUTextureUsage).

/** GPU buffer usage bit flags (OR combination of GPUBufferUsage.MAP_READ / COPY_SRC / ...). */
export type BufferUsageFlags = GPUBufferUsageFlags;

/** GPU color write mask bit flags (GPUColorWrite.RED / GREEN / BLUE / ALPHA / ALL). */
export type ColorWriteFlags = GPUColorWriteFlags;

/** GPU buffer map mode bit flags (GPUMapMode.READ / WRITE). */
export type MapModeFlags = GPUMapModeFlags;

/** GPU shader stage bit flags (GPUShaderStage.VERTEX / FRAGMENT / COMPUTE). */
export type ShaderStageFlags = GPUShaderStageFlags;

/** GPU texture usage bit flags (GPUTextureUsage.COPY_SRC / COPY_DST / TEXTURE_BINDING / ...). */
export type TextureUsageFlags = GPUTextureUsageFlags;

/** GPU 32-bit unsigned size. */
export type Size32 = GPUSize32;

/** GPU 64-bit unsigned size. */
export type Size64 = GPUSize64;

/** GPU 32-bit unsigned index. */
export type Index32 = GPUIndex32;

/** GPU 32-bit signed offset. */
export type SignedOffset32 = GPUSignedOffset32;

/** GPU integer coordinate (used for texture / viewport extents). */
export type IntegerCoordinate = GPUIntegerCoordinate;

/** GPU sample mask bit pattern. */
export type SampleMask = GPUSampleMask;

/** GPU buffer dynamic offset. */
export type BufferDynamicOffset = GPUBufferDynamicOffset;

/** GPU stencil value (reference / read mask / write mask). */
export type StencilValue = GPUStencilValue;

// === String literal enum re-exports (already exported by @webgpu/types; we only alias) ===

/** GPU texture format enum (e.g. 'rgba8unorm' / 'depth24plus' / ...). */
export type TextureFormat = GPUTextureFormat;

/** GPU texture dimension ('1d' / '2d' / '3d'). */
export type TextureDimension = GPUTextureDimension;

/** GPU texture view dimension ('1d' / '2d' / '2d-array' / 'cube' / 'cube-array' / '3d'). */
export type TextureViewDimension = GPUTextureViewDimension;

/** GPU compare function ('never' / 'less' / 'equal' / 'less-equal' / 'greater' / 'not-equal' / 'greater-equal' / 'always'). */
export type CompareFunction = GPUCompareFunction;

/** GPU filter mode ('nearest' / 'linear'). */
export type FilterMode = GPUFilterMode;

/** GPU address mode ('clamp-to-edge' / 'repeat' / 'mirror-repeat'). */
export type AddressMode = GPUAddressMode;

/** GPU vertex format enum ('float32' / 'float32x2' / ... 32 variants in total). */
export type VertexFormat = GPUVertexFormat;

/** GPU vertex step mode ('vertex' / 'instance'). */
export type VertexStepMode = GPUVertexStepMode;

/** GPU index format ('uint16' / 'uint32'). */
export type IndexFormat = GPUIndexFormat;

/** GPU primitive topology ('point-list' / 'line-list' / 'line-strip' / 'triangle-list' / 'triangle-strip'). */
export {
  isStripTopology,
  isTriangleTopology,
  type PrimitiveTopology,
} from './primitive-topology.js';

/** GPU triangle cull mode ('none' / 'front' / 'back'). */
export type CullMode = GPUCullMode;

/** GPU triangle front-face winding ('ccw' / 'cw'). */
export type FrontFace = GPUFrontFace;

/** GPU stencil operation ('keep' / 'zero' / 'replace' / 'invert' / 'increment-clamp' / 'decrement-clamp' / 'increment-wrap' / 'decrement-wrap'). */
export type StencilOperation = GPUStencilOperation;

/** GPU blend factor ('zero' / 'one' / 'src' / 'one-minus-src' / ...). */
export type BlendFactor = GPUBlendFactor;

/** GPU blend operation ('add' / 'subtract' / 'reverse-subtract' / 'min' / 'max'). */
export type BlendOperation = GPUBlendOperation;

/** GPU load op ('load' / 'clear'). */
export type LoadOp = GPULoadOp;

/** GPU store op ('store' / 'discard'). */
export type StoreOp = GPUStoreOp;

// === Shader pipeline trio SSOT (feat-20260508-shader-pipeline-mvp) =================
//
// Decision anchors:
// - plan-strategy §S-7 + §S-9 (fully-explicit reflection + ShaderError 5-field top level)
// - requirements §AC-04 (manifest 4 fields) + MVP-2.6 (manifest schema TS SSOT)
// - research Finding 2 (reflection JSON field-mapping oracle, 9 boundary cases)
// - charter proposition 4 (explicit failure) + proposition 5 (consistent abstraction:
//   dev-time and runtime errors share one shape)

/**
 * Single shader manifest entry — trio + 4-field manifest SSOT (AC-04).
 *
 * | Field | Shape | Notes |
 * |:--|:--|:--|
 * | `hash` | `string` | content-addressable fingerprint (the on-disk key written by the plugin's `generateBundle`) |
 * | `wgsl` | `string` | WGSL source: relative path or inline literal (the plugin chooses; schema does not constrain) |
 * | `glsl` | `string \| undefined` | GLSL placeholder (empty string or undefined within M1 scope; reserved for the non-WebGL fallback path) |
 * | `bindings` | `string` | `BindGroupLayoutDescriptor[]` serialized as a JSON string (output derived from reflection) |
 *
 * Written by `@forgeax/engine-shader-compiler`, persisted by `@forgeax/engine-vite-plugin-shader`,
 * loaded and consumed by `@forgeax/engine-shader` — the schema's single source of truth lives
 * in this package across all three sides (charter proposition 5: consistent abstraction).
 */
export interface ManifestEntry {
  readonly hash: string;
  readonly wgsl: string;
  readonly glsl: string | undefined;
  readonly bindings: string;
}

/**
 * Shader compile-time error-code closed union — 7 members
 * (feat-20260512-naga-oil-composition-hmr M3 T-09 extension; D-R7 / S-7 /
 * OQ-2 legacy 4 + D-08 new 3 for naga_oil composition).
 *
 * Symmetric in shape with `@forgeax/engine-rhi`'s `RhiErrorCode` closed union
 * (AGENTS.md error model); exhaustive `switch` needs no default fallback —
 * TypeScript guards union completeness at compile time (charter proposition 4
 * explicit failure / proposition 3 machine-readable union > prose).
 *
 * Evolution: minor-add (requirements §AC-08). The 4 legacy positions remain
 * byte-for-byte at the top (AGENTS.md `Evolution contract`: members can be
 * added only — no rename / delete / reorder). The 3 new members appear at the
 * bottom:
 * - `shader-import-not-found`  — naga_oil `ImportNotFound` variant surfaces
 *   when `#import <moduleId>::<symbol>` cannot bind to any module registered
 *   through `options.imports` (plan-strategy D-08 + D-12 offset passthrough).
 * - `shader-circular-import` — TS-layer DFS (T-11 `detectCycle`) catches
 *   `a -> b -> a` style import cycles before calling into the wasm composer
 *   (plan-strategy D-03 path A + D-04 cycle first/last repetition form).
 * - `shader-define-conflict` — TS-layer pre-scan (T-12 `scanDefineConflicts`)
 *   rejects the same `#define NAME` appearing in >=2 modules (plan-strategy
 *   D-07; prevents naga_oil HashMap silent override from research R-07).
 *
 * | code | Trigger |
 * |:--|:--|
 * | `'shader-compile-failed'` | naga `parse_str` / `Validator` failed; also the fallback for any non-ImportNotFound naga_oil ComposerError variant (plan-strategy D-05 non-boolean #define value goes here, never a new 8th member). |
 * | `'compiler-init-failed'` | wasm load / `init()` failed (cold start / missing wasm artifact). |
 * | `'manifest-malformed'` | manifest.json schema validation failed (4 fields missing or JSON unparseable). |
 * | `'shader-not-found'` | `ShaderRegistry.get(hash)` hash miss. |
 * | `'shader-import-not-found'` | `#import <moduleId>` target absent from `options.imports` (or lacks `#define_import_path` header). `err.detail.importPath` + `err.detail.fromModuleId` narrow after the switch. |
 * | `'shader-circular-import'` | import dependency graph contains a cycle; `err.detail.cycle` carries the full chain with first/last repeated (D-04). |
 * | `'shader-define-conflict'` | same `#define NAME` declared in multiple modules; `err.detail.sites[]` lists each offending moduleId. |
 */
export type ShaderErrorCode =
  | 'shader-compile-failed'
  | 'compiler-init-failed'
  | 'manifest-malformed'
  | 'shader-not-found'
  | 'shader-import-not-found'
  | 'shader-circular-import'
  | 'shader-define-conflict'
  // === 5 new material-* codes (feat-20260523-shader-template-instance-split M1-T02) ===
  | 'material-schema-mismatch'
  | 'material-shader-not-found'
  | 'material-param-type-mismatch'
  | 'material-param-unknown'
  | 'material-param-missing-required'
  // === build-time superset gate (feat-20260613-material-paramschema-driven-binding M2 / w9) ===
  | 'material-shader-binding-mismatch';

// === Shader error detail discriminated union (feat-20260512 M3 T-09 / D-08) =====
//
// Decision anchors:
// - plan-strategy §2 D-08 (3 new typed variants keyed on `code`, structurally
//   parallel to `RhiErrorDetail` in `packages/rhi/src/errors.ts` lines
//   165-189; 4 legacy members stay as prose detail for backwards compat).
// - plan-strategy §2 D-04 (cycle first/last repetition form: ['a','b','a']).
// - plan-strategy §2 D-12 (ImportNotFound offset passthrough when naga_oil
//   carries a source position on the inner variant).
// - requirements §AC-08 (AGENTS.md §Error model ShaderErrorDetail row 3
//   variants) + §AC-15 (property access over string parsing).
// - charter proposition 3 (machine-readable union > prose) + proposition 4
//   (explicit failure — narrow via `switch (err.detail.code)` after the
//   `switch (err.code)` tier).
// - architecture-principles #1 SSOT (3 typed variants live here once;
//   producer site `packages/shader-compiler/src/error-mapper.ts` constructs
//   them verbatim; AGENTS.md §Error model table references this module).

/**
 * Detail for the `shader-import-not-found` path (D-08 + D-12).
 *
 * `importPath` mirrors the bare `#import` target string (`'forgeax_pbr::brdf'`).
 * `fromModuleId` identifies the entry module that issued the unresolved
 * import; when the caller omitted `options.id`, this carries the
 * `<anonymous-entry-<hash8>>` placeholder (plan-strategy D-11). Optional
 * `offset` passes through the naga_oil inner-variant byte offset when present
 * (D-12); AI users surface this in error logs for IDE jump-to-source.
 */
export interface ShaderImportNotFoundDetail {
  readonly code: 'shader-import-not-found';
  readonly importPath: string;
  readonly fromModuleId: string;
  readonly offset?: number;
}

/**
 * Detail for the `shader-circular-import` path (D-08 + D-04).
 *
 * `cycle` lists the full import chain with the first and last element
 * repeated so consumers can visualise the loop at a glance
 * (`['a','b','c','a']`). The array is `readonly` so copy-out sites cannot
 * mutate the structure post-emit (charter proposition 4 explicit failure).
 */
export interface ShaderCircularImportDetail {
  readonly code: 'shader-circular-import';
  readonly cycle: readonly string[];
}

/**
 * Detail for the `shader-define-conflict` path (D-08 + D-07).
 *
 * `defineName` names the offending `#define NAME` literal; `sites` lists each
 * moduleId that declared it so the AI user can navigate to every duplicate
 * without re-scanning the source set (charter proposition 3 machine-readable
 * > prose).
 */
export interface ShaderDefineConflictDetail {
  readonly code: 'shader-define-conflict';
  readonly defineName: string;
  readonly sites: readonly { readonly moduleId: string }[];
}

/**
 * Detail for the `shader-compile-failed` path
 * (feat-small-20260513-dx-docs-types-cleanup D-9 / requirements §3.1.7 (A)).
 *
 * `compilerMessages` forwards the full 6 fields of `GPUCompilationMessage`
 * from `@webgpu/types ^0.1.69` (`message` / `type` / `lineNum` / `linePos` /
 * `offset` / `length`); the array is `readonly` so copy-out sites cannot
 * mutate the structure post-emit (charter proposition 4 explicit failure).
 * Optional `reason` carries a prose supplement when the wasm side surfaces a
 * higher-level summary alongside the raw compiler frame.
 *
 * @see RhiShaderCompileDetail in @forgeax/engine-rhi for the RhiError parallel
 * (R-7 namespace separation: `ShaderError.detail` vs `RhiError.detail` cover
 * disjoint lifecycle phases — compile-time vs async runtime dispatch — and
 * AI users distinguish them by import path).
 */
export interface ShaderCompileFailedDetail {
  readonly code: 'shader-compile-failed';
  readonly compilerMessages: readonly GPUCompilationMessage[];
  readonly reason?: string;
}

/**
 * Detail for the `compiler-init-failed` path
 * (feat-small-20260513-dx-docs-types-cleanup D-9 / requirements §3.1.7 (A)).
 *
 * Constructed by `@forgeax/engine-naga` when the wasm cold start fails
 * (`ensureReady()` rejects, the artefact is missing, or `init()` itself
 * throws). The `code` literal narrows `.detail` after the top-level
 * `switch (err.code)`; optional `reason` carries the wasm-side error message
 * when available (charter proposition 3 machine-readable union > prose).
 */
export interface ShaderInitFailedDetail {
  readonly code: 'compiler-init-failed';
  readonly reason?: string;
}

/**
 * Detail for the `manifest-malformed` path
 * (feat-small-20260513-dx-docs-types-cleanup D-9 / requirements §3.1.7 (A)).
 *
 * Constructed by `@forgeax/engine-naga` / `@forgeax/engine-shader-compiler`
 * when the shader manifest fails the 4-field schema (`{hash, wgsl, glsl,
 * bindings}`) or the JSON itself is unparseable. Optional `reason` carries
 * the schema validator or `JSON.parse` error message when available
 * (charter proposition 4 explicit failure: typed `.reason` access never
 * requires parsing `.message`).
 */
export interface ShaderManifestMalformedDetail {
  readonly code: 'manifest-malformed';
  readonly reason?: string;
}

// === 5 new material-* ShaderErrorDetail variants (feat-20260523-shader-template-instance-split M1-T02) ===
//
// Decision anchors:
// - plan-strategy D-NewErrorCodes-Anchor (5 ShaderErrorCode + 5 detail variants in types SSOT)
// - plan-strategy F-6 round 2 (material-schema-mismatch.mismatchKind is 4-element union:
//   schema-extra | shader-extra | type-mismatch | bg-overflow)
// - requirements AC-12 (each new error code has structured detail)

/**
 * Detail for `material-schema-mismatch` — paramSchema vs BGL mismatch at build-time.
 *
 * `mismatchKind` narrows on the 4-way mismatch category (F-6 round 2):
 * - 'schema-extra': paramSchema declares a name not in BGL
 * - 'shader-extra': BGL has a binding not in paramSchema
 * - 'type-mismatch': param type differs from BGL entry type
 * - 'bg-overflow': binding group count exceeds maxBindGroups (4) — AC-07
 *
 * Optional `expectedParam` / `actualBinding` carry the specific mismatch detail
 * for schema-extra / shader-extra / type-mismatch variants. `actualCount` /
 * `maxAllowed` populated for bg-overflow.
 */
export interface MaterialSchemaMismatchDetail {
  readonly code: 'material-schema-mismatch';
  readonly mismatchKind: 'schema-extra' | 'shader-extra' | 'type-mismatch' | 'bg-overflow';
  readonly materialShaderPath: string;
  readonly expectedParam?: string;
  readonly actualBinding?: number;
  readonly actualCount?: number;
  readonly maxAllowed?: number;
  /** Byte-budget facts for a scene-index row overflow or layout mismatch. */
  readonly expectedBytes?: number;
  readonly availableBytes?: number;
  readonly owner?: string;
}

/**
 * Detail for `material-shader-not-found` — ShaderRegistry lookup miss.
 */
export interface MaterialShaderNotFoundDetail {
  readonly code: 'material-shader-not-found';
  readonly identifier: string;
  /** Registered identifiers at lookup time, for enumeration without parsing `expected`. */
  readonly registeredShaderIds: readonly string[];
}

/**
 * Detail for `material-param-type-mismatch` — a material value does not match
 * paramSchema expected type at runtime register.
 */
export interface MaterialParamTypeMismatchDetail {
  readonly code: 'material-param-type-mismatch';
  readonly paramName: string;
  readonly expectedType: string;
  readonly actualValue: unknown;
}

/**
 * Detail for `material-param-unknown` — material values contain a key not in
 * paramSchema.
 */
export interface MaterialParamUnknownDetail {
  readonly code: 'material-param-unknown';
  readonly paramName: string;
}

/**
 * Detail for `material-param-missing-required` — material values miss a key
 * that paramSchema declares without a default.
 */
export interface MaterialParamMissingRequiredDetail {
  readonly code: 'material-param-missing-required';
  readonly paramName: string;
}

/**
 * Detail for `material-shader-binding-mismatch` — vite-plugin-shader build-time
 * single-direction superset gate (feat-20260613-material-paramschema-driven-
 * binding M2 / D-9 / D-10).
 *
 * The actual reflected BGL must contain every binding emitted by
 * derive(schema); otherwise the build fails with this code. Extra bindings on
 * the actual side are tolerated (engine-injection placeholders such as shadow
 * / IBL / transmission bind groups land at register-time).
 *
 * `expected` is the BGL entry derive(schema) emitted (the binding number +
 * resource layout the shader source must declare). `actual` is the entry the
 * reflector found at the same binding number, or `undefined` when the binding
 * is absent altogether. `expectedParam` names the paramSchema entry that
 * produced `expected` so AI users can grep the sidecar quickly. `mismatchKind`
 * narrows the failure category for AI-side branching.
 */
export interface MaterialShaderBindingMismatchDetail {
  readonly code: 'material-shader-binding-mismatch';
  readonly mismatchKind: 'binding-missing' | 'binding-type-mismatch';
  readonly materialShaderPath: string;
  readonly expected: BindGroupLayoutEntry;
  readonly actual?: BindGroupLayoutEntry;
  readonly expectedParam: string;
}

/**
 * Discriminated union of the 6 typed `.detail` variants keyed on `code`
 * (D-08 legacy 3 variants + feat-small-20260513-dx-docs-types-cleanup D-9
 * minor-add 3 variants; parallel to `RhiErrorDetail` lines 165-189 of
 * `packages/rhi/src/errors.ts`).
 *
 * AI users narrow to the per-code shape after the top-level
 * `switch (err.code)` via the nested `if (err.detail?.code === '<literal>')`
 * guard — `err.detail.compilerMessages` / `err.detail.importPath` /
 * `err.detail.reason` etc. are then typed property accesses with full IDE
 * autocomplete (charter proposition 3 machine-readable union > prose +
 * proposition 4 explicit failure).
 *
 * The `'shader-not-found'` member has no typed detail variant — the
 * `shaderNotFound` factory leaves `.detail` undefined because the surface
 * carries no per-instance payload (the `hash` is already embedded in
 * `.message` / `.expected`; OOS-11 deferring a typed variant).
 *
 * Listed in the same order as the corresponding `ShaderErrorCode` members so
 * a reviewer can grep the two unions vertically for drift
 * (T-09 acceptance check ties `ShaderErrorDetail` grep hit to this layout).
 */
export type ShaderErrorDetail =
  | ShaderImportNotFoundDetail
  | ShaderCircularImportDetail
  | ShaderDefineConflictDetail
  | ShaderCompileFailedDetail
  | ShaderInitFailedDetail
  | ShaderManifestMalformedDetail
  // === 5 new material-* detail variants (feat-20260523-shader-template-instance-split M1-T02) ===
  | MaterialSchemaMismatchDetail
  | MaterialShaderNotFoundDetail
  | MaterialParamTypeMismatchDetail
  | MaterialParamUnknownDetail
  | MaterialParamMissingRequiredDetail
  // === build-time superset gate (feat-20260613-material-paramschema-driven-binding M2 / w9) ===
  | MaterialShaderBindingMismatchDetail;

/**
 * Bind group layout descriptor — shape-aligned with
 * `Pick<GPUBindGroupLayoutDescriptor, 'entries' | 'label'>` (S-9 / AC-04).
 *
 * **Shape rules**:
 * - `entries` is narrowed here to a concrete `readonly BindGroupLayoutEntry[]` (the
 *   spec uses `Iterable<...>`; reflection-derived output is always an array shape).
 * - All optional fields are uniformly `?: T | undefined` (guarded by
 *   exactOptionalPropertyTypes).
 * - Field names match `@webgpu/types` exactly, character for character (spec-alignment rule).
 *
 * **Fully-explicit reflection JSON constraint** (plan-strategy §S-9 / D-R9):
 * the `bindings` JSON emitted by `@forgeax/engine-shader-compiler` must populate every default
 * field defined in W3C spec §5 (e.g. `hasDynamicOffset: false` / `minBindingSize: 0`);
 * `visibility` is output as the `GPUShaderStage` integer bitmask (VERTEX=0x1 /
 * FRAGMENT=0x2 / COMPUTE=0x4 OR-ed together) — string-array form is **forbidden**.
 * This type only describes the schema shape; full explicitness is enforced on the
 * producer side.
 */
export interface BindGroupLayoutDescriptor {
  readonly label?: string | undefined;
  readonly entries: readonly BindGroupLayoutEntry[];
}

/**
 * Single bind group layout entry — shape-aligned with
 * `@webgpu/types.GPUBindGroupLayoutEntry`.
 *
 * `binding` / `visibility` are required; the five resource layouts (buffer / sampler /
 * texture / storageTexture / externalTexture) form the "exactly one set" constraint
 * per W3C spec §5. An `externalTexture` slot accepts either an imported video frame
 * or an ordinary 2D texture view (the copy path shares the same layout).
 */
export interface BindGroupLayoutEntry {
  readonly binding: GPUIndex32;
  readonly visibility: GPUShaderStageFlags;
  readonly buffer?: GPUBufferBindingLayout | undefined;
  readonly sampler?: GPUSamplerBindingLayout | undefined;
  readonly texture?: GPUTextureBindingLayout | undefined;
  readonly storageTexture?: GPUStorageTextureBindingLayout | undefined;
  readonly externalTexture?: GPUExternalTextureBindingLayout | undefined;
}

// === RemoteHandle (feat-20260629-inspector-two-layer-model M4 / w17) ========
//
// Decision anchors:
// - plan-strategy secondary D-6: RemoteHandle defined in @forgeax/engine-types
//   (neutral package, no temporal coupling to @forgeax/engine-remote)
// - requirements AC-11: app.remote typed as RemoteHandle | undefined,
//   exposed on the createApp return value for host inspection
//
// Shape:
//   port  — number, the listen port (determined by the server on startup)
//   close — Promise<void>, tear down the server (Surface Plugin pattern
//           from startServer's returned ConsoleHandle)

/**
 * Handle for a running remote eval server (feat-20260629-inspector-two-layer-model M4).
 *
 * AI users access `app.remote.port` for WS connection / status, and call
 * `await app.remote.close()` to tear down. The field is `undefined` when the
 * server is not started (production build or headless without opt-in).
 *
 * @see {@link startServer} in @forgeax/engine-remote for the producer side
 */
export interface RemoteHandle {
  /** Server listen port (number). Non-zero when the server is running. */
  readonly port: number;
  /** Tear down the server. Returns a Promise that resolves once the WS
   *  server has closed all connections. */
  close(): Promise<void>;
}

// === Remote error model SSOT (feat-20260629-inspector-two-layer-model) ====
//
// Decision anchors:
// - requirements §10.1 + §10.2 + AC-05 (`RemoteErrorCode` 5-member
//   closed union + structured `RemoteError` shape independent from RhiError /
//   ShaderError)
// - plan-strategy §2 D-5 (rename InspectorErrorCode -> RemoteErrorCode,
//   delete inspector-write-denied, delete script-timeout, rename
//   console-* -> server-*)
// - charter proposition 3 (machine-readable union > prose) +
//   proposition 4 (explicit failure — `switch (err.code)` is exhaustive
//   without default fallback) + proposition 5 (consistent abstraction —
//   structurally aligned with @forgeax/engine-rhi's RhiError surface)
// - architecture-principles #1 SSOT (the 5 string literals + structured
//   structural shape live here once; @forgeax/engine-remote's runtime `RemoteError`
//   class implements this interface; consumers import the type
//   alias without dragging the runtime class through static deps —
//   parallel to the existing ShaderErrorCode pattern)

/**
 * Closed `RemoteErrorCode` union — 5 members (feat-20260629-inspector-two-layer-model
 * D-5; requirements AC-05). Exhaustive `switch` needs no default
 * fallback — TypeScript guards union completeness at compile time
 * (charter proposition 4 explicit failure + proposition 3 machine-readable
 * union > prose).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'script-syntax-error'` | Script body is not parseable JavaScript (SyntaxError from eval). |
 * | `'script-runtime-error'` | Script threw a non-syntax exception during execution (e.g. ReferenceError / TypeError). |
 * | `'server-startup-failed'` | The remote eval server failed to come up: WebSocketServer raised 'error' (EADDRINUSE / other listen failure), dynamic-import resolution failed, or the target package lacks the `startServer` factory. |
 * | `'server-not-running'` | CLI client's `new WebSocket('ws://localhost:<port>/inspector')` failed to connect (server not started; `app.remote` not wired in the demo). |
 * | `'eval-result-not-serializable'` | A successful eval result cannot cross the JSON-RPC wire, such as a BigInt or cyclic object. |
 *
 * **Independence from `RhiError | ShaderError` union** — `RemoteErrorCode`
 * is **not** merged into the GPU / asset error union (charter proposition 5 +
 * architecture-principles #1 SSOT). Engine-side errors stream is OOS-1
 * (errors.subscribe v2 spinoff); remote callers only face these 5
 * alternatives.
 */
export type RemoteErrorCode =
  | 'script-syntax-error'
  | 'script-runtime-error'
  | 'server-startup-failed'
  | 'server-not-running'
  | 'eval-result-not-serializable';

/**
 * Structural shape of a forgeax remote error (feat-20260629-inspector-two-layer-model
 * D-5). Structured surface mirroring `@forgeax/engine-rhi` `RhiError`
 * (charter proposition 5 consistent abstraction; AGENTS.md "Errors are
 * structured"):
 *
 * - `.code`      closed union member (L1 key signal; switch-able).
 * - `.expected`  expected-state description (L2 detail).
 * - `.hint`      actionable recovery guidance (L2 detail).
 * - `.message`   auto-composed string for human stack traces (AI users
 *                prefer property access on `.code` / `.expected` / `.hint`).
 * - `.name`      Error name marker (`'RemoteError'`) for cross-realm
 *                dispatch under JSON-RPC transport.
 *
 * This interface intentionally extends `Error` so a runtime `RemoteError`
 * **class** (defined in `@forgeax/engine-remote/errors`) satisfies the contract
 * without re-declaring the inherited `name` / `message` slots.
 *
 * AI users consume the structured triple via property access — never by
 * parsing `.message` (charter proposition 4 explicit failure red line).
 */
export interface RemoteError extends Error {
  readonly code: RemoteErrorCode;
  readonly expected: string;
  readonly hint: string;
  /**
   * Optional discriminated detail payload (feat-20260517 D-7). Per-code
   * variant carries structured provenance that would otherwise pollute the
   * single-line `.hint` copy. AI users narrow via `switch (err.code)`; the
   * `.detail` slot is `undefined` for codes whose discriminator has no
   * payload (charter P4 explicit failure: signal absence by type).
   */
  readonly detail?: RemoteErrorDetail;
}

/**
 * Discriminated detail union for {@link RemoteError} (feat-20260517 D-7).
 * Each variant pairs a {@link RemoteErrorCode} member with the
 * structured payload AI users need to act on the error without grepping
 * prose. Variants without payload are intentionally absent — the
 * `RemoteError.detail` slot is `undefined` for those codes.
 *
 * The `server-startup-failed` variant carries bounded startup provenance.
 */
export type RemoteErrorDetail = ServerStartupFailedDetail | EvalResultNotSerializableDetail;

/**
 * `server-startup-failed` discriminator variant with bounded provenance.
 */
export interface ServerStartupFailedDetail {
  readonly code: 'server-startup-failed';
  readonly removedAt: string;
  readonly docAnchor: string;
}

/**
 * SSOT for the legacy-inspect routing hint template. Keep the recovery copy
 * executable and byte-stable for CLI and remote consumers.
 */
export function legacyInspectHint(legacyInspectTarget: string): string {
  return `use 'forgeax dev eval --root <project> --code "return ${legacyInspectTarget}"' to inspect the live realm`;
}

/**
 * `eval-result-not-serializable` discriminator variant. The shape is a
 * bounded classification only; it carries no part of the returned object
 * so failed transport cannot leak arbitrary engine state.
 */
export interface EvalResultNotSerializableDetail {
  readonly code: 'eval-result-not-serializable';
  readonly shape: 'bigint' | 'cyclic-object' | 'unsupported';
}

// === Metric registry error model SSOT (feat-20260512-threejs-pixel-parity-bench) ===
//
// Decision anchors:
// - requirements §3.5 + AC-04 + AC-05 + AC-11 (`MetricErrorCode` 4-member closed
//   union elevated to TS alias; B-1 regression-prevention callout — exhaustive
//   `switch (err.code)` without `default:` must compile under tsc strict)
// - plan-strategy §2 D-P3 (MetricErrorCode TS alias goes first in the topology;
//   M1 T-001 ships only the 4 legacy members verbatim from AGENTS.md Error
//   model table)
// - research Finding 9 (`MetricErrorCode` currently has zero TS alias = direct
//   B-1 regression risk; §6 g9 checklist item 1: introduce
//   `export type MetricErrorCode = ...` in `packages/types/src/index.ts`,
//   structurally parallel to ShaderErrorCode / RemoteErrorCode)
// - charter proposition 3 (machine-readable union > prose) + proposition 4
//   (explicit failure — closed-union exhaustive switch needs no default fallback;
//   tsc strict mode guards completeness) + proposition 5 (consistent abstraction —
//   structurally aligned with @forgeax/engine-rhi RhiError and RemoteError)
// - architecture-principles #1 SSOT (the 4 string literals live here once;
//   `scripts/check-metrics-declared.mjs` / `scripts/metrics/run-all.mjs` /
//   `scripts/metrics/run-fps.mjs` are .mjs producer sites that emit the same
//   literals at throw points; parallel to ShaderErrorCode pattern)

/**
 * Closed `MetricErrorCode` union — 4 members (M1 T-001 elevation of the
 * pre-existing 4 `.mjs` producer literals to a TS alias; research Finding 9
 * §6 g9 checklist item 1). Exhaustive `switch` needs no default fallback —
 * TypeScript guards union completeness at compile time (charter proposition 4
 * explicit failure + proposition 3 machine-readable union > prose).
 *
 * | code | trigger |
 * |:--|:--|
 * | `'metric-not-declared'` | a workspace member lacks `package.json#forgeax.metrics` or the declaration is not a plain object; emitted by `scripts/check-metrics-declared.mjs` + `scripts/metrics/run-all.mjs`. |
 * | `'metric-kind-unknown'` | `forgeax.metrics` contains a key not in the closed `MetricKind` union (`bundle-size` / `fps` / `bench` / `gate` / `spike-report`); typo guard via ajv `additionalProperties: false`. |
 * | `'metric-status-not-ok'` | dispatcher (bundle-size / bench / gate / fps / spike-report) returned `status !== 'ok'`; the offending `report/<package>/<kind>.json` carries the value-vs-threshold detail. |
 * | `'metric-schema-malformed'` | `schemas/forgeax-metrics.schema.json` failed to parse / compile as JSON Schema 2020-12; precondition failure surfaced by both `check-metrics-declared.mjs` and `run-all.mjs`. |
 *
 * **B-1 regression prevention** (requirements AC-05 + AC-11): an alias without
 * a TS consumer site cannot be exhaustively switched; M1 T-002 adds type-level
 * tests against this alias, and M2 evaluator + M2 runner CLI add the two
 * non-test exhaustive `switch (err.code)` consumer sites (D-P9 plan-strategy
 * decision).
 *
 * Per-feat extension to 6 members (M1 T-002, D-P3): `'pixel-parity-threshold-exceeded'`
 * + `'pixel-parity-capture-failed'` extend the alias at the bottom; AGENTS.md
 * Error model table flips from `(4)` to `(6)` in lockstep. The two new members
 * encode the double-gate of the pixel-parity bench (research Finding 10 +
 * plan-strategy D-P2): Layer A per-pixel YIQ tolerance ` perPixelThreshold` is
 * pixelmatch-internal and never raises on its own; Layer B aggregate cap
 * `threshold` raises `'pixel-parity-threshold-exceeded'`; any capture-side
 * failure (chromium launch / vite preview / readPixels / size mismatch /
 * pixelmatch internal throw) collapses into `'pixel-parity-capture-failed'`
 * with a `.detail.stage` discriminator (charter proposition 5 consistent
 * abstraction — pixelmatch internal exception does NOT get a third member;
 * see D-P3 decision rationale).
 */
export type MetricErrorCode =
  | 'metric-not-declared'
  | 'metric-kind-unknown'
  | 'metric-status-not-ok'
  | 'metric-schema-malformed'
  | 'pixel-parity-threshold-exceeded'
  | 'pixel-parity-capture-failed';

/**
 * Per-code detail shape for the four legacy `MetricErrorCode` members
 * (`'metric-not-declared'` / `'metric-kind-unknown'` / `'metric-status-not-ok'`
 * / `'metric-schema-malformed'`).
 *
 * The four legacy `.mjs` producer sites (`scripts/check-metrics-declared.mjs`,
 * `scripts/metrics/run-all.mjs`, `scripts/metrics/run-fps.mjs`) emit textual
 * `[reason] / [hint]` lines and never carry a structured payload — they live
 * in CI-only scripts and exit 1 directly. The `.detail` slot is therefore left
 * `undefined` so AI consumers do not waste a narrowing step looking for a
 * non-existent payload (charter proposition 4 explicit failure: signal absence
 * by type).
 */
export interface MetricLegacyDetail {
  readonly stage?: undefined;
}

/**
 * Detail shape exclusive to the `'pixel-parity-threshold-exceeded'` path
 * (M1 T-002 / D-P11). Carries the full numeric verdict so AI users can
 * surface the value-vs-threshold delta in stderr / sticky-comment renderings
 * without parsing `.message`.
 *
 * | Field | Meaning |
 * |:--|:--|
 * | `diffPixelCount` | Aggregate count from `pixelmatch(left, right, ...)` (Layer B reading). |
 * | `diffPercent` | `diffPixelCount / (width * height)` rendered as a 0..1 float for sticky-comment formatting. |
 * | `maxChannelDelta` | Maximum per-channel uint8 delta across all differing pixels (0..255). Helps disambiguate "many tiny diffs" from "few big diffs". |
 * | `threshold` | The declared Layer B integer cap (`package.json#forgeax.metrics.bench.pixelDiff.threshold`). |
 * | `perPixelThreshold` | The Layer A `pixelmatch` per-pixel YIQ float threshold actually used; equals the declared value or the `0.1` fallback (D-P2 default semantics). |
 *
 * The exhaustive discriminator is `code === 'pixel-parity-threshold-exceeded'`
 * — AI users access `.detail.diffPixelCount` directly after the type guard
 * with full IDE autocomplete (charter proposition 3 machine-readable union >
 * prose; AI-user review F-1 IDE autocomplete affordance).
 */
export interface ParityThresholdDetail {
  readonly diffPixelCount: number;
  readonly diffPercent: number;
  readonly maxChannelDelta: number;
  readonly threshold: number;
  readonly perPixelThreshold: number;
}

/**
 * Detail shape exclusive to the `'pixel-parity-capture-failed'` path (M1 T-002
 * / D-P11). Carries a discriminator `.stage` that pinpoints which step of the
 * capture pipeline collapsed (charter proposition 5 consistent abstraction:
 * pixelmatch-internal throw becomes `.stage='diff'` rather than a third
 * `MetricErrorCode` member — plan-strategy D-P3 decision).
 *
 * | `.stage` | trigger |
 * |:--|:--|
 * | `'chromium-launch'` | `chromium.launch({...})` threw (research Finding 6: `--enable-unsafe-webgpu` flag still rejected on the host). |
 * | `'vite-preview'` | spawned vite preview never reached `wait-on tcp 30s` (research Finding 4 cleanup pattern). |
 * | `'pixel-readback'` | `gl.readPixels(...)` or `commandEncoder.copyTextureToBuffer(...)` failed, or `window.__captureLeft/Right` was missing. |
 * | `'size-mismatch'` | left and right `Uint8Array.length` differ; `leftSize` / `rightSize` carry the actual byte counts. |
 * | `'diff'` | `pixelmatch(left, right, ...)` itself threw (charter proposition 4 explicit failure: no silent catch; EC-06). |
 *
 * Optional `leftSize` / `rightSize` are populated for the `'size-mismatch'`
 * stage; they are absent for the other stages because the failure happened
 * before any byte count was known.
 */
export interface ParityCaptureDetail {
  readonly stage: 'chromium-launch' | 'vite-preview' | 'pixel-readback' | 'size-mismatch' | 'diff';
  readonly leftSize?: number;
  readonly rightSize?: number;
  /**
   * Optional human-readable cause string for the failure (typically the
   * caught `Error.message` text or an inferred reason). Aligned with ECMA
   * 2022 `Error.cause` naming convention so IDE hover invokes the same mental
   * model. Filled by `scripts/bench/pixel-parity.mjs` at every stage that
   * surfaces a non-empty message; absent when the failure is purely
   * structural (e.g. `'size-mismatch'` where `leftSize` / `rightSize` carry
   * the diagnostic payload instead).
   */
  readonly cause?: string;
}

/**
 * Non-optional detail projection carried by `MetricError`.
 *
 * `MetricError` owns the complete code-to-detail relation. `NonNullable` removes
 * only the four legacy absence markers; parity payloads and the legacy detail
 * shape remain in the public family without a second manually maintained list.
 */
export type MetricErrorDetail = NonNullable<MetricError['detail']>;

/**
 * Structural shape of a forgeax metric error (feat-20260512 T-002).
 *
 * Three-field surface (`.code` / `.expected` / `.hint`) plus per-code-narrowed
 * `.detail`, structurally aligned with `@forgeax/engine-rhi` `RhiError` and
 * `InspectorError` (charter proposition 5 consistent abstraction; AGENTS.md
 * "Errors are structured. Return Result, never throw for expected failures").
 *
 * `MetricError` is a TypeScript discriminated union of 6 per-code interfaces;
 * each variant narrows `.detail` to the corresponding `MetricErrorDetail`
 * branch. AI users perform a single `switch (err.code)` and pick up
 * `.detail.diffPixelCount` (threshold-exceeded path) or `.detail.stage`
 * (capture-failed path) with full IDE autocomplete (AI-user review F-1
 * affordance; D-P11).
 *
 * - `.code`      closed union member (L1 key signal; switch-able).
 * - `.expected`  expected-state description (L2 detail; mirrors the `[reason]`
 *                line emitted by `failStructured(...)` in the three `.mjs`
 *                producer sites).
 * - `.hint`      actionable recovery guidance (L2 detail; mirrors the `[hint]`
 *                line in `failStructured(...)`).
 * - `.detail`    path-specific structured payload narrowed per `.code`.
 *
 * AI users consume the structured triple via property access — never by
 * parsing `.message` (charter proposition 4 explicit failure red line).
 */
export type MetricError =
  | (MetricErrorBase & {
      readonly code: 'metric-not-declared';
      readonly detail?: MetricLegacyDetail | undefined;
    })
  | (MetricErrorBase & {
      readonly code: 'metric-kind-unknown';
      readonly detail?: MetricLegacyDetail | undefined;
    })
  | (MetricErrorBase & {
      readonly code: 'metric-status-not-ok';
      readonly detail?: MetricLegacyDetail | undefined;
    })
  | (MetricErrorBase & {
      readonly code: 'metric-schema-malformed';
      readonly detail?: MetricLegacyDetail | undefined;
    })
  | (MetricErrorBase & {
      readonly code: 'pixel-parity-threshold-exceeded';
      readonly detail: ParityThresholdDetail;
    })
  | (MetricErrorBase & {
      readonly code: 'pixel-parity-capture-failed';
      readonly detail: ParityCaptureDetail;
    });

/**
 * Common base of every `MetricError` variant (D-P11 internal helper —
 * never instantiated on its own, only intersected into the per-code
 * branches of `MetricError`).
 */
interface MetricErrorBase {
  readonly code: MetricErrorCode;
  readonly expected: string;
  readonly hint: string;
}

// === Pack-index catalog entry POD (feat-20260517-vite-plugin-image-build-time-cook D-2) ===
//
// PackIndexEntry is the in-memory shape of one row in `pack-index.json` (build
// path) and `/__pack/index` JSON response (dev path). It is the SSOT contract
// between the build-time catalog builder (`@forgeax/engine-vite-plugin-pack`)
// and the runtime asset loader (`@forgeax/engine-runtime` `parseAssetPayload`).
//
// Decision anchors:
//   - plan-strategy D-2 (5-field metadata sub-structure: width / height /
//     format / colorSpace / mipmap, mirrors TextureAsset POD field names so
//     `metadata.colorSpace` greps to the same surface across catalog / POD /
//     sidecar).
//   - plan-strategy D-5 (sidecar `mipmap: 'auto' | 'none'` is mapped to the
//     `boolean` form by the catalog builder; runtime is unaware of the
//     string token).
//   - charter P1 (progressive disclosure -- core 4 fields stay flat,
//     image-only metadata sinks into a sub-structure that texture-arm
//     consumers narrow into).
//   - charter P4 (consistent abstraction -- `metadata` field-by-field
//     mirrors `TextureAsset` POD field names; `width` / `height` / `format`
//     / `colorSpace` / `mipmap` align byte-for-byte).
//
// Backward compatibility (D-2 'minor' evolution):
//   - `metadata` is `?: ImageMetadata | undefined` -- legacy 4-field entries
//     emitted by older builds (or future non-texture kinds: 'mesh' / 'scene' /
//     'material') stay valid; runtime consumers narrow on `entry.metadata !==
//     undefined` before accessing fields.
//   - The interface stays open over `kind` (string) so future 'audio' /
//     'video' arms can join without re-typing PackIndexEntry; the texture
//     arm narrows via `entry.kind === 'texture'` + `entry.metadata`
//     existence in `parseAssetPayload`.

/**
 * Metadata sub-structure carried by `PackIndexEntry` rows of `kind: 'texture'`.
 *
 * Five fields mirror `TextureAsset` POD field names (`width` / `height` /
 * `format` / `colorSpace` / `mipmap`) so AI users can grep one identifier and
 * see the same surface in catalog rows, sidecar `*.meta.json`
 * `importSettings`, and the runtime `TextureAsset` POD (charter P4 consistent
 * abstraction).
 *
 * `width` / `height` are optional because dev-mode catalog rows folded from a
 * `*.meta.json` sidecar may lack pixel dimensions until `parseImage`
 * decodes the JPG bytes; build-mode (import) rows always have them filled
 * because the import step has already run `parseImage` to produce the RGBA
 * bytes.
 *
 * `format` is `GPUTextureFormat` to align with the `TextureAsset.format`
 * field (math-free, spec-aligned with `@webgpu/types ^0.1.70`).
 *
 * `colorSpace` and `mipmap` are required because the sidecar
 * `importSettings` always carries them (D-5: `'auto'` / `'none'` string
 * tokens are mapped to `true` / `false` at the catalog builder; runtime never
 * sees the string form).
 *
 * `compression` is the build-time compression level this image artefact
 * was stored with. Loop 1 supports `'none'` (passthrough) and `'zstd'`.
 * Loop 2 may add members like `'basis-uastc'`. Absent for legacy rows.
 */

/**
 * Asset compression strategy — closed literal union (SSOT, D-3 / D-9).
 *
 * Five flat, mutually-exclusive members describing how an artefact is stored:
 *   - `'none'`  — pass-through (uncompressed bytes)
 *   - `'zstd'`  — generic zstd container compression (Loop 1)
 *   - `'basis-etc1s'` / `'basis-uastc'` / `'basis-uastc-hdr'` — a Basis-encoded
 *     KTX2 texture (Loop 2). The `basis-*` members fully describe the delivered
 *     encoding: the KTX2 container carries its own supercompression (self-
 *     described by the KTX2 header) and does NOT stack an outer `'zstd'` layer
 *     (mutual exclusion by construction, D-3). The `basis-` kebab prefix is
 *     visually distinct from GPU texture-format literals (naming rule, §8).
 *
 * Add-only-minor: Loop 2 appends the three `basis-*` members without repainting
 * `'none'` / `'zstd'` semantics (AC-11a). A missing / `undefined` field means a
 * legacy uncompressed artefact (E1 backward-compat).
 */
export type AssetCompression = 'none' | 'zstd' | 'basis-etc1s' | 'basis-uastc' | 'basis-uastc-hdr';

export interface ImageMetadata {
  readonly kind: 'texture';
  readonly width?: number;
  readonly height?: number;
  readonly format: GPUTextureFormat;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mipmap: boolean;
  /** Build-time compression strategy used for this image artefact. `undefined` for legacy assets. */
  readonly compression?: AssetCompression;
  /**
   * Sidecar control-plane request for the offline texture encoder (D-12).
   * `'auto'` derives the delivery encoding from `colorSpace` + HDR source;
   * `'etc1s'` / `'uastc'` force a Basis encoding; `'none'` keeps the
   * uncompressed `.bin` path. Aligns with the mipmap sidecar tri-state idiom.
   * The `'auto'` default semantics activate in M5; M3 keeps the default `'none'`.
   */
  readonly compressionMode?: 'auto' | 'etc1s' | 'uastc' | 'none';
  /** Optional asset-owned cooked-payload target dimension. */
  readonly downscaleMaxDimension?: number;
}

export type {
  AssetAuthoringCapability,
  AssetAuthoringUnavailableReason,
  AssetBindingCapability,
  AssetBindingTarget,
  AssetPlacementCapability,
  AssetRelation,
  AssetRelationPolicy,
  AssetRelationType,
  AssetSubjectRef,
  AssetSubjectType,
  CatalogDiagnostic,
  CatalogDiagnosticCause,
  CatalogDiagnosticSeverity,
  CatalogLifecycle,
  CatalogOperationDescriptor,
  CatalogOperationName,
  CatalogOperations,
  CatalogProjection,
  CatalogProjectionInput,
  CatalogSubject,
  CookExecution,
  ExistingOutput,
  ImportedOutputDeclaration,
  KindChange,
  MatchConflict,
  ProducerContractDiagnostic,
  ProducerContractErrorCode,
  ProducerContractResult,
  ProposedOutput,
  ProviderProvenance,
  ResourceRevision,
  ScenePublicationFence,
  SourceOverrideDescriptor,
  SourceOverrideDiagnostic,
  SourceOverrideErrorCode,
  SourceOverrideMap,
  SourceOverridePayload,
  SourceOverrideValidationResult,
  TopologyConflictReason,
  TopologyDiff,
  TopologyPreserved,
  UiAuthoringCapability,
  UiAuthoringProjection,
} from './asset-producer';
export {
  authoringCapabilityForAssetKind,
  canonicalizeSourceOverrides,
  catalogOperationsFor,
  isCatalogProjectionValid,
  MESH_MATERIAL_SLOT_SOURCE_OVERRIDE_PAYLOAD_SCHEMA,
  validateSourceOverrideMap,
} from './asset-producer';
/**
 * One row in the pack-index catalog (`pack-index.json` for build path,
 * `/__pack/index` JSON response for dev path).
 *
 * Core fields (4) stay flat for AI users to grep one identifier:
 *   - `guid`: UUIDv5/v7 lowercase string (asset identity SSOT)
 *   - `packageUrl`: cooked Pack v2 package navigation URL.
 *   - `kind`: closed-string discriminator (`'texture'` / `'mesh'` / `'scene'`
 *     / `'material'` / future arms); narrowed by runtime `parseAssetPayload`
 *     via exhaustive switch.
 *   - `sourcePath`: relative path to the on-disk source artefact for
 *     debugging + grep (dev: source JPG path; build: same source JPG path
 *     even though `packageUrl` points to the cooked package).
 *
 * Optional 5th field:
 *   - `metadata`: `ImageMetadata | undefined` -- present when `kind ===
 *     'texture'`; absent for non-texture kinds (legacy `.pack.json` entries
 *     emit 4-field rows). Runtime consumers narrow with `entry.metadata !==
 *     undefined` before consumption (D-2 backward-compat strategy).
 */
export type {
  AssetPublicationEnvelope,
  AssetPublicationEvidenceUsage,
  AssetPublicationExternalEvidence,
  AssetPublicationFailure,
  AssetPublicationFailureStage,
  AssetPublicationLocator,
  AssetPublicationOutput,
  AssetPublicationReceipt,
  AssetPublicationRecovery,
  CatalogDelta,
  CatalogDeltaValidationError,
  CatalogEntry,
  CatalogEntry as PackIndexEntry,
  CatalogEntryV2,
  CatalogRevisionPoint,
  CatalogRevisionWindow,
} from './catalog';
export { catalogDeltaDigest, catalogEntryDigest, validateCatalogDelta } from './catalog';

// === InspectEntry / InspectSnapshot (feat-20260618-asset-and-pack-name-fields M1 / w3) ===
//
// Decision anchors:
//   - plan-strategy D-9 (InspectEntry.name: string via resolveName, non-optional
//     with empty string as legal value; relocated from runtime private to types
//     for single-entry discoverability per charter F1)
//   - requirements AC-12 (inspector assets root carries resolved name per entry)
//
// These types were originally private interfaces in asset-registry.ts.
// They are promoted to @forgeax/engine-types so console + future inspector
// consumers import them from a single entry point (charter F1).

/** One row in the inspector's `assets[]` snapshot (JSON-RPC over WS). */
export interface InspectEntry {
  readonly guid: string;
  /** Asset kind discriminant string (e.g. `'mesh'`, `'texture'`, `'scene'`). */
  readonly kind: string;
  /** Display name resolved by resolveName (empty string is legal). */
  readonly name: string;
}

/** Snapshot returned by `AssetRegistry.inspect()` -- the inspector root. */
export interface InspectSnapshot {
  readonly assets: ReadonlyArray<InspectEntry>;
}

// === Loader contract SSOT (feat-20260603-asset-import-loader-injection M1 / w3) ===
//
// Decision anchors:
//   - plan-strategy D-1 (runtime LoaderRegistry dispatches on `asset.kind`;
//     host injects loaders via `wireDefaultLoaders`, mirroring Console
//     `wireDefaultInspectors`) + D-2 (contract SSOT lives here in
//     `@forgeax/engine-types`, math-free, so `@forgeax/engine-runtime` only
//     depends on the interface, never reverse-imports a concrete loader)
//   - requirements core principle (third DIP instance after RHI / Console)
//   - charter P3 (structured failure) + P4 (consistent abstraction)
//
// A `Loader` is the runtime-side half of the import/load split: it turns an
// already-imported internal artefact (a `.pack.json` payload, or fetched
// bytes for texture / font) into an in-memory `Asset` POD. It stays pure of
// the registry's bookkeeping — `registerWithGuid` is the AssetRegistry's job,
// never the loader's (plan-strategy D-2).
//
// Two dispatch shapes share this one contract (the asymmetry is intentional,
// matching the two pre-existing AssetRegistry load paths the M1 refactor
// converges; research Finding 1 + Finding 2):
//   (a) inline pack-payload kinds (mesh / scene / material /
//       skeleton / skin / animation-clip) parse synchronously and return
//       `Asset | undefined` (`undefined` = parse rejected, the caller maps it
//       to a structured `AssetError`).
//   (b) upstream-branch kinds (texture / font / equirect) fetch + decode
//       asynchronously and return a `Promise<LoaderAsyncResult>` carrying either
//       the produced `Asset` POD or a structured error.

/**
 * Result envelope returned by the async branch of {@link Loader.load}
 * (texture / font). Mirrors the `Result<T, E>` shape used across the engine
 * (`.ok` discriminant) but is declared math-free here so
 * `@forgeax/engine-types` need not import `@forgeax/engine-rhi`. The error is
 * left as `unknown` so the runtime can surface its own
 * `AssetError | ImageError | RhiError` union without leaking those classes
 * into the types package (charter P4 — the runtime narrows; types stays
 * dependency-free).
 */
export type LoaderAsyncResult<P = Asset> =
  | { readonly ok: true; readonly value: P }
  | { readonly ok: false; readonly error: unknown };

/**
 * Output of {@link Loader.load}. The synchronous arm returns `Asset` (parse
 * succeeded) or `undefined` (parse rejected); the asynchronous arm returns a
 * `Promise<LoaderAsyncResult>`.
 */
export type LoaderOutput<P = Asset> =
  | P
  | undefined
  | { readonly ok: false; readonly error: ParseErrorDetail }
  | Promise<LoaderAsyncResult<P>>;

/**
 * Capabilities the host wires into a {@link Loader} at load time. A loader
 * receives this context so it never reaches back into AssetRegistry
 * internals (pipeline isolation, architecture-principles #4).
 *
 * Exactly three capabilities (plan-strategy D-3 rationale):
 *   - `fetchBinary(url)` — fetch raw bytes for the artefact (texture import
 *     `.bin`, `.hdr`, source image, font pack JSON).
 *   - `resolveRef(guid)` — recursively resolve a referenced sub-asset GUID to
 *     its registered handle id (font atlas / sampler). Returns the raw handle
 *     number so the loader can stamp it into the produced POD; the runtime
 *     performs the recursive `loadByGuid` + registration underneath.
 *   - `device` — opaque GPU device slot, present for future GPU-touching
 *     loaders; current loaders register CPU PODs only and never touch it
 *     (research Finding 3 — texture GPU upload is decoupled from load time via
 *     the pull-model `GpuResourceStore`). Typed `unknown` so types stays
 *     RHI-free.
 *
 * F21 (feat-20260621): the error-contextualization callback has been removed.
 */
export interface ParseErrorDetail {
  /** Keyed SceneAsset context. */
  readonly entityKey: string;
  readonly component: string;
  readonly field: string;
  readonly index: number;
  readonly refsLength: number;
}

/**
 * Device texture-compression capabilities the transcode target selector reads
 * (feat-20260707 M5 / D-8, D-11).
 *
 * Three independent booleans mirror the WebGPU `texture-compression-{bc,etc2,
 * astc}` device features (and the `RhiCaps.textureCompression{Bc,Etc2,Astc}`
 * triple they are projected from — createRenderer does the one-line RhiCaps ->
 * TranscodeCaps projection). This shape is structurally identical to the codec
 * package's own `TranscodeCaps` (`@forgeax/engine-codec`): the codec keeps a
 * LOCAL copy on purpose (D-8 — codec is a pure, dependency-light transcode
 * library and must not take a `@forgeax/engine-types` edge just to name its
 * pure-function input). The runtime passes a value of this type straight into
 * `selectTranscodeTarget` by structural compatibility; there is exactly one
 * value threaded through `LoadContext`, so no fact is duplicated at runtime.
 */
export interface TranscodeCaps {
  readonly bc: boolean;
  readonly etc2: boolean;
  readonly astc: boolean;
}

export interface LoadContext {
  /**
   * Fetch raw bytes for an asset artefact, with optional decompression.
   *
   * feat-20260706 M3 / w19: extended signature per D-2 — a `compression`
   * opt triggers the decompression gate inside the closure
   * (`@forgeax/engine-codec` lazy-init). `undefined` / `'none'` = E1
   * pass-through (backward-compat for legacy catalog rows).
   */
  fetchBinary(
    url: string,
    opts?: { readonly compression?: AssetCompression },
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: unknown }
  >;
  resolveRef(
    guid: string,
  ): Promise<
    { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: unknown }
  >;
  /**
   * feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
   * derive(paramSchema).textureFieldNames for the given material-shader id,
   * built from the registered shader's paramSchema. Used by materialLoader
   * to know which material value fields carry refs[] indices vs scalar values
   * (replacing the deleted hardcoded texture-field allowlist Set per AC-03).
   *
   * Returns `undefined` when the shader is not yet registered (the cross-
   * worktree shader-late-register path of plan R-4): the loader then falls
   * back to a graceful "try every int paramValue as a refs index" walk that
   * may misclassify scalar f32 fields whose value happens to land in
   * [0, refs.length); the extract layer (M4 / w23) catches mis-typed
   * handles via paramSchema validation and falls back to MISSING_TEXTURE_HANDLE.
   */
  getMaterialShaderTextureFieldNames?(shaderId: string): ReadonlySet<string> | undefined;
  /**
   * feat-20260707 M5 / w33 (D-11): device compression caps the texture / equirect
   * Basis arms feed to `selectTranscodeTarget` to pick a transcode target. Wired
   * by `createRenderer` from `RhiCaps` (D-8 one-line projection); a bare
   * AssetRegistry (test / headless path) defaults to all-false, which drives the
   * uncompressed `rgba8unorm` / `rgba16float` fallback (section 8 P3, AC-04).
   * Extends the single ctx input face rather than opening a new loader channel
   * (Pipeline Isolation — inputs declared explicitly).
   */
  readonly transcodeCaps: TranscodeCaps;
  readonly device: unknown;
}

/**
 * Runtime-side loader injected into the `LoaderRegistry`. One loader per
 * `asset.kind`; the registry dispatches `loadByGuid` on the kind.
 *
 * `load` is pure of registry bookkeeping (no `registerWithGuid`); it only
 * produces the `Asset` POD (or a structured error / `undefined`). See the
 * module comment above for the sync vs async dispatch asymmetry.
 */
export interface Loader<P = Asset> {
  readonly kind: string;
  readonly references?: 'eager' | 'deferred';
  /** Optional Pack v2 dispatch that retains asset-local artifact bytes. */
  readonly loadPack?: (
    input: {
      readonly guid: string;
      readonly kind: string;
      readonly payload: Record<string, unknown>;
      readonly refs: readonly string[];
      readonly streams?: Readonly<
        Record<string, { readonly descriptor: ArtifactDescriptor; readonly url: string }>
      >;
      readonly artifacts: Readonly<
        Record<
          string,
          {
            readonly descriptor: ArtifactDescriptor;
            readonly bytes: Uint8Array;
          }
        >
      >;
    },
    ctx: LoadContext,
  ) => LoaderOutput<P>;
  load(
    payload: Record<string, unknown>,
    refs: readonly string[] | undefined,
    ctx: LoadContext,
  ): LoaderOutput<P>;
}

export type {
  ImportContext,
  ImportDiagnostic,
  ImportDiagnosticLocation,
  ImportErrorCode,
  ImportErrorDetail,
  ImportedArtifactBody,
  ImportedAsset,
  Importer,
  ImporterCapabilities,
  ImportProduct,
  ImportProductFinalizeArtifact,
  ImportProductFinalizeOptions,
  ImportProductFinalizeResult,
  ImportResult,
  ImportSourceRange,
  ImportSubAsset,
  ImportTransport,
  SourceDependency,
} from './import.js';
export {
  IMPORT_ERROR_HINTS,
  ImportError,
  parseConservativeAnimatedBounds,
  readConservativeAnimatedBounds,
} from './import.js';
export {
  MAX_SHADOW_CAPSULES_PER_SKELETON,
  parseShadowCapsuleSet,
  SHADOW_CAPSULE_STRIDE,
} from './shadow-capsules.js';
// === EngineMetrics contract SSOT (feat-20260705-runtime-tier2-decomposition M1 / w2, D-3) ===
//
// Decision anchors:
//   - plan-strategy D-3 (the 3-method EngineMetrics interface has zero type
//     dependencies; sinking it into @forgeax/engine-types makes types the SSOT
//     leaf. EngineMetricsImpl + createEngineMetrics stay in runtime.)
//   - research F5 (asset-registry.ts `import type { EngineMetrics }` was the
//     third reverse edge from assets cluster to runtime; type-only but the
//     project-reference layer still had to resolve it — relocating the contract
//     to the leaf removes the edge).
//
// The interface was originally defined in runtime/src/engine-metrics.ts. It is
// promoted here so both @forgeax/engine-runtime and @forgeax/engine-assets-runtime
// import the contract from a single entry point (charter F1).

/**
 * Per-Renderer metrics counter API. Backed by a `Map<string, number>`; reads
 * return a frozen plain object so external mutation never leaks back into the
 * registry (D-5 + R-2 mutation-resistance).
 *
 * Three methods cover the full surface:
 *
 *   const r = await createRenderer(canvas);
 *   // ... renderer hits some nineslice runtime soft-warn
 *   r.metrics.snapshot()['nineslice.scale-too-small'];   // -> number | undefined
 *
 *   r.metrics.increment('nineslice.scale-too-small');    // mutate counter
 *   r.metrics.reset();                                   // drop all counters
 *
 * Callers can `for (const k in renderer.metrics.snapshot())` to enumerate
 * fired events without knowing the namespace ahead of time.
 *
 * @remarks Closed namespace (charter P5):
 * - `nineslice.scale-too-small`
 * - `nineslice.tile-needs-repeat-sampler`
 * - `render.instancing.foldedDraws`
 */
export interface EngineMetrics {
  /**
   * Bump the counter for `name` by 1. Counters start at 0 implicitly; the
   * first `increment(name)` lands a 1 in the snapshot. Names are free-form
   * strings (no prior registration), so feat-local namespaces (e.g.
   * `nineslice.*`) coexist without coordination.
   */
  increment(name: string): void;
  /**
   * Read all counters as an immutable `Readonly<Record<string, number>>`.
   * The returned object is frozen — external mutation throws in strict mode
   * and is silently ignored otherwise. Snapshot-then-mutate is decoupled
   * from the registry: a later `increment` does not retroactively alter the
   * already-returned snapshot.
   */
  snapshot(): Readonly<Record<string, number>>;
  /**
   * Drop every counter back to 0 (counter rows physically removed). Provided
   * for test isolation and Inspector reset workflows; production code on
   * the hot path never calls this.
   */
  reset(): void;
}

// inspector-client is Node-only (imports 'ws'); consume via
//   import { ... } from '@forgeax/engine-types/inspector-client'
