// Material schema and render-state contracts.
/// <reference types="@webgpu/types" />

// feat-20260613 fix-issue-4: MATERIAL_PARAM_TYPES_V1 (9-Set) deleted —
// MATERIAL_PARAM_TYPES (14-tuple, declared below) is the single SSOT.
// §Change stance forbids v1/v2 dual-paths; the 9 v1 literals are a strict
// subset of the 14-tuple, so all consumers (buildMaterialAssetValidator,
// scanner.ts) migrate to the 14-tuple in one cut.

// === MaterialParamType v2 (feat-20260613-material-paramschema-driven-binding M1 / w2) ===
//
// Decision anchors:
//   - plan-strategy D-7  paramSchema type set v2 (9 v1 + 5 new = 14 literals)
//   - research finding F-1  the union of all binding types used by the 5 built-in
//     shaders (standard-pbr / pbr-skin / unlit / sprite / shadow-caster) is exactly
//     these 14 entries; CSM (texture_depth_2d) / point shadow (texture_cube_array) /
//     IBL (texture_cube) / sampler_comparison / storage_buffer (skin palette) all
//     already exist downstream
//   - charter P3 explicit failure: closed unions guard exhaustive switching with
//     no default arm; TS verifies completeness
//
// Shape:
//   - `MATERIAL_PARAM_TYPES`  : 14-element readonly tuple, the SSOT whitelist
//   - `MaterialParamType`     : string-literal union derived from the tuple
//   - `NumericParamType`      : 7 numeric literals (run-merged into one UBO entry)
//   - `TextureBindingParamType`: 8 literals — texture* + sampler*
//     (per D-4 each texture* auto-pairs a filtering sampler in derive output;
//      sampler / sampler_comparison are user-declared schema entries)
//   - `StorageBindingParamType`: storage_buffer (independent binding)
//   - `ParamSchemaEntry`       : discriminated union over the three families
//     (Numeric / TextureBinding / StorageBinding) — exhaustive switching
//     on `entry.type` is closed across the 14 literals.

/** 7 numeric WGSL types — std140-packed into one merged UBO entry (D-3). */
export type NumericParamType = 'f32' | 'i32' | 'u32' | 'vec2' | 'vec3' | 'vec4' | 'color';

/**
 * 9 texture-binding-family WGSL types: 7 texture views + 2 sampler kinds.
 * `texture_external` samples through `textureSampleBaseClampToEdge` and binds
 * a zero-copy video frame or any 2D color view (copy path).
 */
export type TextureBindingParamType =
  | 'texture2d'
  | 'texture2d_array'
  | 'texture3d'
  | 'texture_cube'
  | 'texture_depth_2d'
  | 'texture_cube_array'
  | 'texture_external'
  | 'sampler'
  | 'sampler_comparison';

/** 1 storage-binding type (e.g. skin palette buffer). */
export type StorageBindingParamType = 'storage_buffer';

/**
 * Closed union of WGSL material-parameter type literals (17 members).
 * Every paramSchema entry's `type` field MUST be a member of this union.
 */
export type MaterialParamType =
  | NumericParamType
  | TextureBindingParamType
  | StorageBindingParamType;

/**
 * v2 material parameter type whitelist — 17 ordered literal tuple (D-7).
 * Order is significant only as a stable enumeration source for tests
 * and discoverability; consumers should treat membership as a Set.
 */
export const MATERIAL_PARAM_TYPES = [
  'f32',
  'i32',
  'u32',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'texture2d',
  'texture2d_array',
  'texture3d',
  'texture_cube',
  'texture_depth_2d',
  'texture_cube_array',
  'texture_external',
  'sampler',
  'sampler_comparison',
  'storage_buffer',
] as const satisfies readonly MaterialParamType[];

// Numeric-family schema entry (run-merged into a single UBO entry by derive).
// `default` is optional; when present, values may omit the key.
//   - scalar numeric (f32 / i32 / u32) defaults to a single number
//   - vector + color types default to a length-N number tuple
export interface NumericParamSchemaEntry {
  readonly name: string;
  readonly type: NumericParamType;
  /** Asset-side color transfer function; runtime UBO values are always linear. */
  readonly colorSpace?: 'srgb' | 'linear';
  readonly default?: number | readonly number[];
}

// Texture-binding-family schema entry (texture* / sampler*).
// `default` is kept optional for backward compatibility with existing
// schema fixtures that carry stray defaults; derive ignores it for the
// non-numeric families (D-4 auto-pair rule resolves samplers; textures
// resolve via Handle<TextureAsset>).
export interface TextureBindingParamSchemaEntry {
  readonly name: string;
  readonly type: TextureBindingParamType;
  readonly default?: unknown;
  /** Cooked textureLoad-only bindings admit float textures without filtering support. */
  readonly sampleType?: 'float' | 'unfilterable-float';
}

// Storage-binding-family schema entry (storage_buffer).
// Always an independent binding (not merged into the UBO run); `default`
// is optional and ignored by derive (backward compatibility shim).
export interface StorageBindingParamSchemaEntry {
  readonly name: string;
  readonly type: StorageBindingParamType;
  readonly default?: unknown;
}

// Re-export derive(schema) and its output shapes alongside the schema
// type union so all downstream consumers (runtime / vite-plugin-shader /
// shader-compiler) reach the SSOT through a single import surface (D-2).
export type {
  DerivedMaterialInterface,
  DerivedNumericMember,
  DeriveOutput,
  ImmutableParamSchemaProjection,
  MaterialBindingSpan,
  MaterialCoordinateRecordLayout,
  MaterialParameterProjection,
  MaterialParameterResourceProjection,
  MaterialParameterTextureProjection,
  MaterialResourceBindingLayout,
  MaterialResourceKind,
  ParamSchemaDeriveObservationKind,
  ParamSchemaDeriveObserver,
  ParamSchemaProjectionOwnerStats,
  UboFieldLayout,
  UboLayout,
} from './derive-paramschema.js';
export {
  derive,
  deriveObserved,
  findUndeclaredSampledTextures,
  getAdmittedParamSchemaInterface,
  inferMaterialParameterKind,
  ParamSchemaProjectionOwner,
} from './derive-paramschema.js';

/**
 * Single material parameter schema entry — discriminated union over the
 * three families (Numeric / TextureBinding / StorageBinding).
 *
 * `name` is the parameter identifier matching a WGSL binding name.
 * `type` is the discriminator — exhaustive `switch (entry.type)` covers the
 * 14 literals without a `default` arm; TS guards completeness (charter P3).
 */
export type ParamSchemaEntry =
  | NumericParamSchemaEntry
  | TextureBindingParamSchemaEntry
  | StorageBindingParamSchemaEntry;

// === RenderQueue namespace constants (feat-20260526-material-asset-multipass-renderstate M1 / w3) ===
//
// Decision anchors:
//   - requirements AC-04 (5 standard queue values: Background=1000 / Geometry=2000 /
//     AlphaTest=2450 / Transparent=3000 / Overlay=4000)
//   - plan-strategy D-3 (queue values replace three-bucket dispatch)
//   - research F-5 (Utopia queue model; Transparent=3000 gives gap between
//     AlphaTest=2450 and Transparent=3000 for user custom queues)
//   - charter P1 (progressive disclosure: RenderQueue.Geometry autocomplete
//     exposes the value; AI users never need to memorize bare numbers)

/**
 * Standard render queue constants (AC-04). AI users access via IDE autocomplete
 * (`RenderQueue.`) — no bare numbers to memorize (charter P1 progressive disclosure).
 *
 * Queue order (ascending):
 *   Background(1000) -> Geometry(2000) -> AlphaTest(2450) -> Transparent(3000) -> Overlay(4000)
 *
 * The gap between AlphaTest(2450) and Transparent(3000) allows user-inserted
 * custom queues without colliding with either boundary (research F-5).
 */
export const RenderQueue = {
  /** Skybox / backdrop draw, processed first. */
  Background: 1000,
  /** Opaque geometry draw — default queue for solid surfaces. */
  Geometry: 2000,
  /** Alpha-tested geometry (clip/discard in fragment shader) — drawn after opaque,
   *  before transparent to avoid overdraw. */
  AlphaTest: 2450,
  /** Transparent / alpha-blended geometry — drawn back-to-front after opaque pass. */
  Transparent: 3000,
  /** Overlay / UI / debug lines — drawn last. */
  Overlay: 4000,
} as const;

/** Type alias for the 5-member RenderQueue value union (1000 | 2000 | 2450 | 3000 | 4000). */
export type RenderQueue = (typeof RenderQueue)[keyof typeof RenderQueue];

// === MaterialRenderState POD interface (feat-20260526-material-asset-multipass-renderstate M1 / w1) ===
//
// Decision anchors:
//   - requirements AC-03 (all fields optional; engine applies known defaults)
//   - plan-strategy D-2 (MaterialRenderState fields optional + engine static defaults)
//   - research F-3 (current hardcoded values become the defaults)
//   - research F-6 (Three.js taxonomy proves this subset is sufficient for LO 4.x)
//   - charter P1 (all fields optional reduces boilerplate; JSDoc on each field exposes
//     the default so AI users discover via IDE hover without reading prose)

/**
 * Stencil face state sub-interface — mirrors `@webgpu/types.GPUStencilFaceState`
 * field-by-field (spec-aligned per RHI form rules). All fields optional so
 * consumers declare only the stencil behavior they need.
 */
export interface StencilFaceState {
  /** Default: `'never'`. */
  readonly compare?: GPUCompareFunction;
  /** Default: `'keep'`. */
  readonly failOp?: GPUStencilOperation;
  /** Default: `'keep'`. */
  readonly depthFailOp?: GPUStencilOperation;
  /** Default: `'keep'`. */
  readonly passOp?: GPUStencilOperation;
}

/**
 * Material render-state POD interface — all fields optional (AC-03).
 *
 * When a field is `undefined`, the pipeline-builder falls back to the
 * engine default value noted in each field's JSDoc. AI users only override
 * the fields that differ from the defaults (charter P1 progressive disclosure).
 *
 * The defaults are:
 *   - `cullMode='back'` (back-face culling per WebGPU convention)
 *   - `depthCompare='less'` (nearer surfaces win; Render projects this to Reverse-Z `greater`)
 *   - `depthWriteEnabled=true` (write depth for opaque surfaces)
 *   - `blend` undefined (no blending — opaque pass)
 *   - `stencil` undefined (no stencil operations)
 *   - `stencilReadMask` undefined (WebGPU default 0xFFFFFFFF)
 *   - `stencilWriteMask` undefined (WebGPU default 0xFFFFFFFF)
 *   - `frontFace` undefined (default 'ccw')
 */
export interface MaterialRenderState {
  /** Projection of the selected MaterialPass outputs; not a second authoring authority. */
  readonly outputs?: readonly import('./material/asset.js').MaterialColorOutput[];
  /** Face culling mode. Default: `'back'` (cull back faces). */
  readonly cullMode?: 'none' | 'front' | 'back';
  /** Depth comparison function. Default: `'less'`. */
  readonly depthCompare?: GPUCompareFunction;
  /** Whether depth writes are enabled. Default: `true`. */
  readonly depthWriteEnabled?: boolean;
  /** RGBA bit mask (R=1, G=2, B=4, A=8). Default: 15; 0 preserves depth-only occlusion. */
  readonly colorWriteMask?: GPUColorWriteFlags;
  /** Constant polygon depth offset, in implementation-defined units. Signed 32-bit integer; default: 0. */
  readonly depthBias?: number;
  /** Polygon depth offset scaled by the maximum depth slope. Default: 0. */
  readonly depthBiasSlopeScale?: number;
  /** Clamp on the polygon depth offset; 0 means unclamped. Default: 0. */
  readonly depthBiasClamp?: number;
  /** Blend state descriptor (spec-aligned with `GPUBlendState`). Default: undefined (no blending). */
  readonly blend?: GPUBlendState;
  /** Enable alpha-to-coverage when the active camera uses MSAA. Default: `false`. */
  readonly alphaToCoverageEnabled?: boolean;
  /** Stencil face state. Default: undefined (no stencil operations). */
  readonly stencil?: StencilFaceState;
  /**
   * Stencil read mask (mirrors GPUDepthStencilState.stencilReadMask top-level).
   * Default: undefined (WebGPU default 0xFFFFFFFF).
   */
  readonly stencilReadMask?: number;
  /**
   * Stencil write mask (mirrors GPUDepthStencilState.stencilWriteMask top-level).
   * Default: undefined (WebGPU default 0xFFFFFFFF).
   */
  readonly stencilWriteMask?: number;
  /**
   * Front-face winding (mirrors GPUPrimitiveState.frontFace).
   * Default: `'ccw'`.
   */
  readonly frontFace?: 'ccw' | 'cw';
}

// === PassKind as open string + KNOWN_PASS_KINDS (feat-20260615-pipeline-spec-ssot D-10) ===
//
// Decision anchors:
//   - plan-strategy D-10 (PassKind opened from closed union to string; KNOWN_PASS_KINDS
//     is a discoverable documentation constant)
//   - requirements AC-09 (PassKind: open string; unknown passKind -> PipelineSpecError
//     code='unknown-pass-kind')
//   - charter P3 (fail-fast on unknown passKind via PipelineSpecError, not silent route)

/**
 * Render-pass kind -- open string, no longer a closed union.
 *
 * `KNOWN_PASS_KINDS` (below) documents the engine-shipped pass kinds; user-defined
 * pass kinds are supported through {@link ShaderRegistry} registration. An unknown
 * pass kind triggers {@link PipelineSpecError} with code `'unknown-pass-kind'`
 * at pipeline-spec build time (charter P3 explicit failure).
 *
 * @see {@link KNOWN_PASS_KINDS} for the discoverable pass-kind catalogue
 * @see plan-strategy D-10 (PassKind opened from closed union)
 */
export type PassKind = string;

/**
 * Engine-shipped pass kinds -- discoverable constant catalogue (D-10).
 *
 * Consumers iterate or lookup against this set to validate pass kinds before
 * submitting to `getOrBuildPipeline`. An unknown pass kind still triggers a
 * structured `PipelineSpecError` with code `'unknown-pass-kind'` carrying
 * `.detail.expected = KNOWN_PASS_KINDS` and `.detail.actual`.
 */
export const KNOWN_PASS_KINDS: readonly string[] = [
  'forward',
  'deferred',
  'temporal',
  'lighting',
  'shadow-caster',
  'point-shadow-caster',
  'post-process',
  'skybox',
] as const;

// === PassSelector type (feat-20260526-material-asset-multipass-renderstate M1 / w4) ===
//
// Decision anchors:
//   - requirements AC-05 (tags + PassSelector matching: all selector keys must
//     exist in pass tags with value in the selector's value list)
//   - plan-strategy D-4 (Tags free Record + PassSelector Record<string, string[]>;
//     enum-based categories rejected — adding a pipeline stage should not require
//     editing the types package)
//   - charter P1 (type signature itself is the match-rule documentation;
//     `Record<string, string[]>` is self-describing)

/**
 * Pass selector — maps tag keys to allowed value lists (AC-05).
 *
 * A pass matches the selector when **every** key in the selector exists in the
 * pass's `tags` and the pass's tag value is in the selector's value list for that key.
 * An empty selector matches every pass (no key constraints).
 *
 * The type signature itself is the API docs (charter P1): each entry maps a
 * tag key (string) to its allowed values (string array).
 *
 * @example Match passes tagged with `RenderType: 'Opaque'` or `RenderType: 'Transparent'`
 * ```ts
 * const selector: PassSelector = { RenderType: ['Opaque', 'Transparent'] };
 * ```
 */
export type PassSelector = Record<string, readonly string[]>;
