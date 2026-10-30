// @forgeax/engine-rhi - pure-interface RHI surface for forgeax-engine.
//
// Iron laws: spec-aligned (descriptor field names mirror Pick<GPUXxxDescriptor, ...>
// byte-for-byte) / capability-gated / opaque handle / math-free. See README +
// AGENTS.md "## RHI / WebGPU" section.
//
// This file is the complete entry for `import * as RHI from '@forgeax/engine-rhi'`
// (charter proposition 1: progressive disclosure + plan-strategy 7.4
// discoverability "AI users see the full surface in one read").
//
// =====================================================================
// Async function form contract (D-P9 / requirements AC-12)
// =====================================================================
//
// All async functions exposed by `@forgeax/engine-rhi` (and the rhi-webgpu /
// rhi-wgpu shim packages that implement this interface) follow the
// `Promise<Result<T, RhiError>>` shape — Promise NEVER rejects, failures
// ride `Result.err` so AI users have a single error-handling idiom across
// sync + async surfaces (charter proposition 4 explicit failure +
// proposition 5 consistent abstraction).
//
// Three permitted whitelist categories may keep the bare `Promise<T>` shape;
// each exemption must be marked with a `// forgeax-async-whitelist:
// <category>` comment near the signature site so the grep gate
// (scripts/check-async-form.mjs) can pair the violation count with the
// whitelist count:
//
//   (a) wasm-bindgen     — outputs of wasm-pack JS shim that we cannot
//                          restructure at the type layer (wasm-loader edge);
//   (b) dom-native       — DOM native Promise passthrough such as
//                          `GPUDevice.lost` re-exposed verbatim;
//   (c) render-loop      — non-fallible internal drivers like
//                          requestAnimationFrame wrappers.
//
// Anything else returning `Promise<T>` without the whitelist comment is a
// CI gate red.
//
// Related: requirements AC AC-02 + MVP-1.1 / MVP-1.2 / MVP-1.3 / MVP-1.5 /
//          MVP-1.7 + AC-04 (RhiErrorCode 17 members) + AC-05 (RhiCaps 11
//          fields) + AC-10 (RhiBindingResource tagged union) + AC-11
//          (MappedBuffer brand) + AC-12 (Promise<Result<T,E>> + whitelist)
//          + hard-constraints 1 / 2 / 3 / 7 / 9; plan-strategy 1
//          architecture + 2 S-1 / S-3 / S-6 / S-7 + 6 M1 + D-P9 async form;
//          research F-1 (17 core descriptor surface) + F-7 (wgpu-hal 21
//          associated types);
//          feat-20260508-rhi-surface-completion w8 D-S5 (4 new descriptors
//          with `view` field tightened to TextureView);
//          feat-20260511-rhi-spec-realign-aggressive (Promise<Result<T,E>>
//          contract locked at the interface layer).

/// <reference types="@webgpu/types" />

import type {
  AddressMode,
  CompareFunction,
  FilterMode,
  TextureFormat,
} from '@forgeax/engine-types';
import type { RhiTextureFormatCapabilityReceipt } from './capability/texture-format';
import type { Result, RhiError } from './errors.js';
import type {
  AccelerationStructureBindingLayout,
  Blas,
  BlasBuildEntry,
  BlasDescriptor,
  RhiRayQueryCaps,
  Tlas,
  TlasBuildEntry,
  TlasDescriptor,
} from './ray-query';

// ============================================================================
// 14 opaque handles (MVP-1.3)
// ============================================================================
//
// Shape: each handle = brand-only typed Id<T>; no runtime value; attempting to
// access internal GPU fields is a tsc compile-time red signal (research R5;
// charter proposition 4 explicit failure + proposition 5 consistent abstraction).
//
// Naming: no Rhi prefix (D-9); coexists with @webgpu/types.GPU* prefix +
// wgpu::* Rust paths via module-path semantics (e.g.
// `import { Buffer } from '@forgeax/engine-rhi'` vs `GPUBuffer`).

declare const RhiBufferBrand: unique symbol;
declare const RhiMappedBufferBrand: unique symbol;

/**
 * GPU buffer opaque handle (vertex / index / uniform / storage / indirect).
 *
 * Spec anchor: W3C WebGPU §4 Buffers / [@webgpu/types.GPUBuffer]; research
 * §4.1 mapState 3-state enum + §4.2 mapAsync 8-item validation + §4.4 unmap
 * detach semantics.
 *
 * The buffer mapping surface is added in feat-20260510-rhi-resource-creation
 * M5 (K-1: raw GPUMapMode bitmask; K-2: alignment / mode-usage / detach
 * faults all ride 'webgpu-runtime-error' with structured .expected / .hint);
 * re-shaped in feat-20260511-rhi-spec-realign-aggressive M1 (D-P2 #6):
 *   - `mapAsync` resolves to `Result<MappedBuffer, RhiError>` (success branch
 *     carries a branded handle subsequently used for getMappedRange / unmap).
 *   - `getMappedRange` / `unmap` are methods on `MappedBuffer` (not Buffer);
 *     calling them on a plain Buffer is a TS2345 compile-time red.
 *
 * The forgeax form keeps the spec verb names but routes failures via Result
 * (charter proposition 4 explicit failure):
 *   mapAsync(mode, offset?, size?): Promise<Result<MappedBuffer, RhiError>>
 *   readonly mapState: 'unmapped' | 'pending' | 'mapped'  - getter (research
 *                    §4.1; same closed union as GPUBufferMapState).
 */
export interface Buffer {
  readonly [RhiBufferBrand]: void;
  /**
   * Map the buffer for CPU access.
   *
   * Spec anchor: W3C WebGPU §gpubuffer-mapasync /
   * [@webgpu/types.GPUBuffer.mapAsync]. K-1 decision: `mode` is the raw
   * `GPUMapMode` bitmask (NOT a closed union 'read' | 'write') so the forgeax
   * form mirrors `GPUMapMode.READ` / `GPUMapMode.WRITE` literals.
   *
   * D-P2 #6 (feat-20260511-rhi-spec-realign-aggressive): the success branch
   * resolves to `MappedBuffer`, a brand on top of `Buffer`. AI users
   * subsequently call `mapped.getMappedRange(...)` / `mapped.unmap()` on the
   * branded handle; calling those methods on a plain `Buffer` is a TS2345
   * compile-time signal (charter proposition 4 explicit failure encoded at
   * the type layer).
   *
   * Failure paths (research §4.2 + plan-strategy §2 K-2):
   *   - mapState !== 'unmapped' (F-8 row 1) -> 'webgpu-runtime-error'.
   *   - offset % 8 != 0 (step 4) -> 'webgpu-runtime-error'.
   *   - rangeSize % 4 != 0 (step 5) -> 'webgpu-runtime-error'.
   *   - offset + rangeSize > size (step 6) -> 'webgpu-runtime-error'.
   *   - mode contains foreign bits (step 7) -> 'webgpu-runtime-error'.
   *   - mode is not exactly READ or WRITE (step 8) -> 'webgpu-runtime-error'.
   *   - mode-usage mismatch (step 9 / F-8 row 3) -> 'webgpu-runtime-error'.
   *
   * @example
   *   const r = await buffer.mapAsync(GPUMapMode.WRITE);
   *   if (!r.ok) {
   *     // route via switch (r.error.code)
   *     return;
   *   }
   *   const mapped: MappedBuffer = r.value;
   *   const range = mapped.getMappedRange();
   *   if (range.ok) new Uint32Array(range.value).set([1, 2, 3, 4]);
   *   mapped.unmap();
   */
  mapAsync(
    mode: GPUMapModeFlags,
    offset?: number | undefined,
    size?: number | undefined,
  ): Promise<Result<MappedBuffer, RhiError>>;
  /**
   * Current mapping state (read-only getter).
   *
   * Spec anchor: research §4.1 mapState 3-state enum; mirrors
   * GPUBufferMapState. Transitions:
   *   - createBuffer({mappedAtCreation:true}) sets mapState='mapped'.
   *   - mapAsync moves 'unmapped' -> 'pending' -> 'mapped'.
   *   - unmap moves 'mapped' -> 'unmapped'.
   */
  readonly mapState: 'unmapped' | 'pending' | 'mapped';
}

/**
 * Brand on top of `Buffer` indicating the mapping is currently open; only the
 * `MappedBuffer` exposes `getMappedRange` / `unmap` method forms so AI users
 * cannot accidentally call them on an unmapped `Buffer` (D-P2 #6).
 *
 * The brand is structural — runtime the `MappedBuffer` is the same JS object
 * as the underlying `Buffer`; TypeScript narrows access through the
 * `__mapped: void` private brand symbol.
 *
 * Spec anchor: W3C WebGPU §4 Buffers mapping lifecycle (research §4.1 /
 * §4.4); plan-strategy §7.1 + D-P2 break-point #6 (brand + method form
 * merged).
 *
 * @example
 *   const r = await buffer.mapAsync(GPUMapMode.WRITE);
 *   if (!r.ok) return;
 *   const mapped: MappedBuffer = r.value;
 *   mapped.getMappedRange();   // method form, this: MappedBuffer
 *   mapped.unmap();            // method form, this: MappedBuffer
 */
export interface MappedBuffer extends Buffer {
  readonly [RhiMappedBufferBrand]: void;
  /**
   * Return an ArrayBuffer view of the mapped range. Method form on
   * `MappedBuffer` per D-P2 #6 — calling on a plain `Buffer` is TS2339.
   *
   * Spec anchor: W3C WebGPU §gpubuffer-getmappedrange /
   * [@webgpu/types.GPUBuffer.getMappedRange].
   *
   * Failure paths:
   *   - mapState !== 'mapped' (incl after unmap, F-8 row 2 detach guard) ->
   *     'webgpu-runtime-error'.
   */
  getMappedRange(
    offset?: number | undefined,
    size?: number | undefined,
  ): Result<ArrayBuffer, RhiError>;
  /**
   * Unmap the buffer, detaching all ArrayBuffer views obtained from
   * getMappedRange. Method form on `MappedBuffer` per D-P2 #6.
   *
   * Spec anchor: W3C WebGPU §gpubuffer-unmap /
   * [@webgpu/types.GPUBuffer.unmap]. unmap() returns void per spec normative
   * silent no-op (research §4.4); calling unmap on an already-unmapped buffer
   * does NOT error. This is the ONE Result-shape exception in the buffer
   * surface (AI User Affordances explicit listing).
   *
   * After unmap, the JS object continues to exist but the brand narrows
   * away at the TS layer: AI users who hold a `MappedBuffer` after the
   * underlying state flipped should re-`mapAsync` to obtain a fresh branded
   * instance (OQ-5 plan-decisions: unmap returns void; subsequent mapAsync
   * returns a new MappedBuffer brand).
   */
  unmap(): void;
}

declare const RhiTextureBrand: unique symbol;
/** GPU texture opaque handle (2D / 3D / cube / array). */
export interface Texture {
  readonly [RhiTextureBrand]: void;
}

/** Texture subresource for queue writes and encoder copies, using an opaque RHI handle. */
export type TexelCopyTextureInfo = Omit<GPUTexelCopyTextureInfo, 'texture'> & {
  readonly texture: Texture;
};

/** Buffer layout for encoder copies, using an opaque RHI handle. */
export type TexelCopyBufferInfo = Omit<GPUTexelCopyBufferInfo, 'buffer'> & {
  readonly buffer: Buffer;
};

/** RHI-owned destination for queue.copyExternalImageToTexture. */
export type ExternalImageTextureDestination = Omit<
  Pick<
    GPUCopyExternalImageDestInfo,
    'texture' | 'mipLevel' | 'origin' | 'aspect' | 'colorSpace' | 'premultipliedAlpha'
  >,
  'texture'
> & {
  readonly texture: Texture;
};

declare const RhiExternalTextureBrand: unique symbol;
/**
 * Frame-scoped zero-copy video handle from `device.importExternalTexture`.
 * WebGPU expires it after the current task; import again for every frame.
 */
export interface ExternalTexture {
  readonly [RhiExternalTextureBrand]: void;
}

/** Closed set of browser media sources that `importExternalTexture` admits. */
export type ExternalTextureSource = HTMLVideoElement | VideoFrame;

export interface ExternalTextureDescriptor {
  readonly source: ExternalTextureSource;
  readonly label?: string | undefined;
}

declare const RhiTextureViewBrand: unique symbol;
/** GPU texture view opaque handle. */
export interface TextureView {
  readonly [RhiTextureViewBrand]: void;
}

declare const RhiSamplerBrand: unique symbol;
/** GPU sampler opaque handle. */
export interface Sampler {
  readonly [RhiSamplerBrand]: void;
}

declare const RhiBindGroupBrand: unique symbol;
/** GPU bind group opaque handle (instantiated layout). */
export interface BindGroup {
  readonly [RhiBindGroupBrand]: void;
}

declare const RhiBindGroupLayoutBrand: unique symbol;
/** GPU bind group layout opaque handle (declares binding shapes). */
export interface BindGroupLayout {
  readonly [RhiBindGroupLayoutBrand]: void;
}

declare const RhiPipelineLayoutBrand: unique symbol;
/** GPU pipeline layout opaque handle (aggregates BindGroupLayouts). */
export interface PipelineLayout {
  readonly [RhiPipelineLayoutBrand]: void;
}

declare const RhiRenderPipelineBrand: unique symbol;
/** GPU render pipeline opaque handle. */
export interface RenderPipeline {
  readonly [RhiRenderPipelineBrand]: void;
}

declare const RhiComputePipelineBrand: unique symbol;
/** GPU compute pipeline opaque handle. */
export interface ComputePipeline {
  readonly [RhiComputePipelineBrand]: void;
}

declare const RhiShaderModuleBrand: unique symbol;
/** GPU shader module opaque handle (WGSL / SPIR-V compile artifact). */
export interface ShaderModule {
  readonly [RhiShaderModuleBrand]: void;
}

declare const RhiQuerySetBrand: unique symbol;
/** GPU query set opaque handle (occlusion / timestamp). */
export interface QuerySet {
  readonly [RhiQuerySetBrand]: void;
}

declare const RhiFenceBrand: unique symbol;
/** GPU fence opaque handle (GPU/CPU sync barrier). */
export interface Fence {
  readonly [RhiFenceBrand]: void;
}

declare const RhiCommandEncoderBrand: unique symbol;
/** GPU command encoder opaque handle (single-use). */
export interface CommandEncoder {
  readonly [RhiCommandEncoderBrand]: void;
}

declare const RhiRenderBundleBrand: unique symbol;
/** Immutable commands, reusable across compatible passes on the issuing device. */
export interface RenderBundle {
  readonly [RhiRenderBundleBrand]: void;
}

export type RenderBundleEncoderDescriptor = ExplicitUndefined<GPURenderBundleEncoderDescriptor>;
export type RenderBundleDescriptor = ExplicitUndefined<GPURenderBundleDescriptor>;

/** The spec command mixins shared by render passes and bundle encoders. */
export type RhiRenderCommands = Pick<
  RhiRenderPassEncoder,
  | 'setPipeline'
  | 'setBindGroup'
  | 'setVertexBuffer'
  | 'setIndexBuffer'
  | 'draw'
  | 'drawIndexed'
  | 'drawIndirect'
  | 'drawIndexedIndirect'
  | 'pushDebugGroup'
  | 'popDebugGroup'
  | 'insertDebugMarker'
>;

export interface RhiRenderBundleEncoder extends RhiRenderCommands {
  finish(desc?: RenderBundleDescriptor | undefined): Result<RenderBundle, RhiError>;
}

declare const RhiCommandBufferBrand: unique symbol;
/** GPU command buffer opaque handle (submitted to Queue). */
export interface CommandBuffer {
  readonly [RhiCommandBufferBrand]: void;
}

// ============================================================================
// 5 core descriptors (MVP-1.1) - Pick<GPUXxxDescriptor, ...> field names
// align byte-for-byte with @webgpu/types
// ============================================================================
//
// Decision S-7 + research F-3: optional fields are uniformly `?: T | undefined`
// (compatible with exactOptionalPropertyTypes; explicitly accepts writers
// passing `{ x: undefined }`; charter proposition 4 explicit failure /
// distinguish missing vs explicit-undefined).
// R8 mitigation: Compatibility Mode field (textureBindingViewDimension) is
// optional follow-on.
//
// Note: @webgpu/types v0.1.69 spec uses the `?: T` simplified form; forgeax
// applies the ExplicitUndefined mapped type to `Pick<spec>` so the forgeax
// side accepts `{ label: undefined }` writes (research F-3 finding;
// ecosystem upgrade path = once upstream @webgpu/types v0.2.x ships
// `?: T | undefined` uniformly, ExplicitUndefined can be removed).

/**
 * Convert `?: T` optional fields to `?: T | undefined` (decision S-7).
 *
 * Compatible with exactOptionalPropertyTypes: writers may pass `undefined`
 * explicitly or omit the field; the M2 shim distinguishes the two via
 * `'x' in src` guards (research F-3 anti-pattern 2).
 */
type ExplicitUndefined<T> = { [K in keyof T]: T[K] | undefined };

/** GPU buffer descriptor. Field set strictly matches GPUBufferDescriptor;
 *  optional fields use `?: T | undefined`. */
export type BufferDescriptor = ExplicitUndefined<
  Pick<GPUBufferDescriptor, 'label' | 'size' | 'usage' | 'mappedAtCreation'>
>;

/** GPU texture descriptor. Field set strictly matches GPUTextureDescriptor
 *  (incl R8 Compatibility Mode field). */
export type TextureDescriptor = ExplicitUndefined<
  Pick<
    GPUTextureDescriptor,
    | 'label'
    | 'size'
    | 'mipLevelCount'
    | 'sampleCount'
    | 'dimension'
    | 'format'
    | 'usage'
    | 'viewFormats'
    | 'textureBindingViewDimension'
  >
>;

/** GPU sampler descriptor. Field set strictly matches GPUSamplerDescriptor. */
export type SamplerDescriptor = ExplicitUndefined<
  Pick<
    GPUSamplerDescriptor,
    | 'label'
    | 'addressModeU'
    | 'addressModeV'
    | 'addressModeW'
    | 'magFilter'
    | 'minFilter'
    | 'mipmapFilter'
    | 'lodMinClamp'
    | 'lodMaxClamp'
    | 'compare'
    | 'maxAnisotropy'
  >
>;

/** GPU bind group layout descriptor. Field set strictly matches
 *  GPUBindGroupLayoutDescriptor. */
export type BindGroupLayoutDescriptor = ExplicitUndefined<
  Pick<GPUBindGroupLayoutDescriptor, 'label'>
> & {
  entries: Iterable<BindGroupLayoutEntry>;
};

/**
 * Bind group layout entry: the spec `GPUBindGroupLayoutEntry` plus the
 * native `accelerationStructure` binding type (a TLAS, WGSL
 * `acceleration_structure`). Exactly one binding-type member is set, as in
 * the spec; the acceleration-structure member requires `caps.rayQuery.supported`.
 */
export type BindGroupLayoutEntry = GPUBindGroupLayoutEntry & {
  accelerationStructure?: AccelerationStructureBindingLayout | undefined;
};

/**
 * GPU texture view descriptor (Pick<GPUTextureViewDescriptor, 9 fields>).
 *
 * Spec anchor: W3C WebGPU §texture-view-creation /
 * [@webgpu/types.GPUTextureViewDescriptor]. Field NAMES align byte-for-byte;
 * field set excludes the feature-gated `swizzle` field (research §1.1 OOS-MVP;
 * a future closure can add it once `'texture-component-swizzle'` is enabled).
 *
 * Cross-resource validation (shim fast-path, research §1.1):
 *   - `format` must equal source.format OR be in source.viewFormats; otherwise
 *     the shim returns Result.err({ code: 'webgpu-runtime-error' }).
 *   - `usage` must be a subset of source.usage (bitmask); otherwise the shim
 *     returns the same code.
 *
 * @example
 *   const r = device.createTextureView(tex, { format: 'rgba8unorm', dimension: '2d' });
 *   if (!r.ok) {
 *     // route via switch (r.error.code)
 *   }
 */
export type TextureViewDescriptor = ExplicitUndefined<
  Pick<
    GPUTextureViewDescriptor,
    | 'label'
    | 'format'
    | 'dimension'
    | 'usage'
    | 'aspect'
    | 'baseMipLevel'
    | 'mipLevelCount'
    | 'baseArrayLayer'
    | 'arrayLayerCount'
  >
>;

/**
 * GPU compute pipeline descriptor (Pick<GPUComputePipelineDescriptor,
 * 'label' | 'layout' | 'compute'>).
 *
 * Spec anchor: W3C WebGPU §compute-pipeline-creation /
 * [@webgpu/types.GPUComputePipelineDescriptor]. Field NAMES align byte-for-byte
 * with spec.
 *
 * `layout` is the spec union `'auto' | GPUPipelineLayout`; forgeax tightens
 * the explicit form to the `PipelineLayout` opaque handle (D-S5 pattern):
 *   layout: 'auto' | PipelineLayout
 *
 * `compute` mirrors `GPUProgrammableStage` verbatim — `module` (required
 * `ShaderModule` opaque handle), `entryPoint?` (optional string),
 * `constants?` (optional `Record<string, number>`).
 *
 * Capability gate (research §1.2 NOTE; plan-strategy §4.3 boundary case row 1):
 *   - `caps.compute === false` -> shim returns Result.err({
 *     code: 'feature-not-enabled', expected: 'caps.compute === true',
 *     hint: 'check device.caps.compute before calling createComputePipeline'
 *   }). MVP WebGPU path always has caps.compute=true (spec mandate); the gate
 *   exists for potential future non-WebGPU backends.
 *
 * @example
 *   const r = device.createComputePipeline({
 *     label: 'cs',
 *     layout: 'auto',
 *     compute: { module: csModule, entryPoint: 'cs_main' },
 *   });
 */
export type ComputePipelineDescriptor = ExplicitUndefined<
  Omit<Pick<GPUComputePipelineDescriptor, 'label' | 'layout' | 'compute'>, 'layout' | 'compute'>
> & {
  /**
   * Either `'auto'` for user-agent BGL inference or a forgeax
   * `PipelineLayout` opaque handle (D-S5 pattern: forgeax handle replaces
   * spec polymorphism `(GPUAutoLayoutMode or GPUPipelineLayout)`).
   */
  layout: 'auto' | PipelineLayout;
  /**
   * The compute programmable stage. `module` is the forgeax `ShaderModule`
   * opaque handle (replacing spec `GPUShaderModule`); `entryPoint?` defaults
   * to the module's single compute entry; `constants?` is a record of
   * pipeline-overridable constants.
   */
  compute: {
    module: ShaderModule;
    entryPoint?: string | undefined;
    constants?: Record<string, number> | undefined;
  };
};

/**
 * GPU query set descriptor (Pick<GPUQuerySetDescriptor, 'label' | 'type' | 'count'>).
 *
 * Spec anchor: W3C WebGPU §queries / [@webgpu/types.GPUQuerySetDescriptor].
 * Field NAMES align byte-for-byte.
 *
 * Hard constraints (research §1.3):
 *   - `count <= 4096` (spec normative). The shim fast-paths a violation to
 *     Result.err({ code: 'limit-exceeded',
 *       expected: 'count <= 4096 (spec normative)',
 *       hint: 'create multiple QuerySet instances if more than 4096 queries needed' }).
 *   - `type === 'timestamp'` requires `caps.timestampQuery === true` (the
 *     'timestamp-query' feature). Otherwise the shim fast-paths to
 *     Result.err({ code: 'feature-not-enabled' }).
 *   - `count = 0` is legal (lower bound; dawn end2end test fixture).
 *
 * @example
 *   const r = device.createQuerySet({ type: 'occlusion', count: 4 });
 *   if (!r.ok) {
 *     // route via switch (r.error.code)
 *   }
 */
export type QuerySetDescriptor = ExplicitUndefined<
  Pick<GPUQuerySetDescriptor, 'label' | 'type' | 'count'>
>;

/**
 * Discriminated union over the 4 BindGroup entry resource kinds (the spec
 * polymorphic `GPUBindingResource` collapsed to a tagged union — charter
 * proposition 4 closed-union exhaustive switch + proposition 5 consistent
 * abstraction over duck-typing).
 *
 * Introduced in feat-20260511-rhi-spec-realign-aggressive w9 per requirements
 * AC-10 + plan-strategy §7.1 + D-P2 break-point #5. AI users `switch
 * (resource.kind)` is exhaustive without a default fallback; construction-side
 * typos like `{ kind: 'samplre', ... }` trip TS2322 at the literal slot.
 *
 * Kind discriminator uses kebab-case for multi-word entries (`textureView` is
 * already single-word camelCase by convention; `externalTexture` is multi-word
 * camelCase for parity with the spec verb `GPUExternalTexture`).
 *
 * @example
 *   const e: RhiBindingResource = { kind: 'sampler', value: linearSampler };
 *   const e2: RhiBindingResource = {
 *     kind: 'buffer',
 *     value: { buffer: viewUniforms, offset: 0, size: 64 },
 *   };
 */
export type RhiBindingResource =
  | { readonly kind: 'sampler'; readonly value: Sampler }
  | {
      readonly kind: 'buffer';
      readonly value: {
        readonly buffer: Buffer;
        readonly offset?: number;
        readonly size?: number;
      };
    }
  | { readonly kind: 'textureView'; readonly value: TextureView }
  | { readonly kind: 'externalTexture'; readonly value: ExternalTexture }
  | { readonly kind: 'accelerationStructure'; readonly value: Tlas };

/**
 * BindGroup entry — one slot in a BindGroup, identified by `binding` (the
 * shader binding number) and `resource` (the tagged-union `RhiBindingResource`
 * — replaces the spec polymorphic `GPUBindingResource`).
 *
 * Field set strictly mirrors `Pick<GPUBindGroupEntry, 'binding'>`; the
 * `resource` field is tightened to the forgeax `RhiBindingResource` tagged
 * union per D-P2 break-point #5 (charter proposition 5 consistent abstraction:
 * AI users see one canonical 4-kind switch rather than spec duck-typing).
 */
export type BindGroupEntry = Pick<GPUBindGroupEntry, 'binding'> & {
  resource: RhiBindingResource;
};

/**
 * GPU bind group descriptor (Pick<GPUBindGroupDescriptor, 'label' | 'layout' | 'entries'>).
 *
 * Spec anchor: W3C WebGPU 10 Resource binding /
 * [@webgpu/types.GPUBindGroupDescriptor].
 *
 * Introduced in feat-20260509-ecs-render-bridge-mvp (D-S1) so the RenderSystem
 * can record `pass.setBindGroup(0/1/2, bg, ...)` through a single RHI surface
 * (charter proposition 5 consistent abstraction; never via raw GPUDevice).
 *
 * The `layout` field references the forgeax `BindGroupLayout` opaque handle
 * (created via `RhiDevice.createBindGroupLayout`); the `entries` array uses
 * the forgeax `BindGroupEntry` shape (binding number + tagged-union
 * `RhiBindingResource`) per feat-20260511-rhi-spec-realign-aggressive D-P2
 * break-point #5 (was previously verbatim `GPUBindGroupEntry`).
 *
 * @example
 *   const desc: BindGroupDescriptor = {
 *     label: 'view-bg',
 *     layout: bgl,
 *     entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: viewUniforms } } }],
 *   };
 */
export type BindGroupDescriptor = ExplicitUndefined<
  Omit<Pick<GPUBindGroupDescriptor, 'label' | 'layout' | 'entries'>, 'layout' | 'entries'>
> & {
  /**
   * BindGroupLayout opaque handle (forgeax tightening: `layout` is the
   * already-shipped `BindGroupLayout` brand, not the spec
   * `GPUBindGroupLayout`). Same D-S5 pattern as RenderPassColorAttachment.view
   * — AI users receive a forgeax-creatable handle, never a phantom spec type.
   */
  layout: BindGroupLayout;
  /**
   * Iterable of forgeax `BindGroupEntry` (binding + tagged-union
   * `RhiBindingResource`); replaces the spec polymorphic
   * `iterable<GPUBindGroupEntry>` per D-P2 break-point #5.
   */
  entries: Iterable<BindGroupEntry>;
};

/**
 * GPU pipeline layout descriptor (Pick<GPUPipelineLayoutDescriptor, 'label' | 'bindGroupLayouts'>).
 *
 * Spec anchor: W3C WebGPU 10.3 Pipeline layout /
 * [@webgpu/types.GPUPipelineLayoutDescriptor].
 *
 * Introduced in feat-20260509-ecs-render-bridge-mvp (D-S1) so the
 * `Renderer.ready` step 2 (PBR pipeline compile) can compose the 3
 * BindGroupLayouts (view / material / mesh-array) into a single
 * `PipelineLayout` for `RhiDevice.createRenderPipeline`.
 *
 * @example
 *   const desc: PipelineLayoutDescriptor = {
 *     label: 'pbr-pl',
 *     bindGroupLayouts: [viewBgl, materialBgl, meshArrayBgl],
 *   };
 */
export type PipelineLayoutDescriptor = ExplicitUndefined<
  Omit<Pick<GPUPipelineLayoutDescriptor, 'label' | 'bindGroupLayouts'>, 'bindGroupLayouts'>
> & {
  /**
   * Iterable of BindGroupLayout opaque handles (forgeax tightening: the
   * iterable element type is the forgeax `BindGroupLayout` brand). Same D-S5
   * pattern as BindGroupDescriptor.layout.
   */
  bindGroupLayouts: Iterable<BindGroupLayout>;
};

/** GPU render pipeline vertex stage with an opaque forgeax shader module. */
export type RenderPipelineVertexState = ExplicitUndefined<
  Omit<GPUVertexState, 'module' | 'buffers'>
> & {
  module: ShaderModule;
  buffers: NonNullable<GPUVertexState['buffers']>;
};

/** GPU render pipeline fragment stage with an opaque forgeax shader module. */
export type RenderPipelineFragmentState = ExplicitUndefined<
  Omit<GPUFragmentState, 'module' | 'targets'>
> & {
  module: ShaderModule;
  targets: NonNullable<GPUFragmentState['targets']>;
};

/** GPU render pipeline descriptor with opaque forgeax layout and shader handles. */
export type RenderPipelineDescriptor = ExplicitUndefined<
  Omit<
    Pick<
      GPURenderPipelineDescriptor,
      'label' | 'layout' | 'vertex' | 'primitive' | 'depthStencil' | 'multisample' | 'fragment'
    >,
    'layout' | 'vertex' | 'fragment'
  >
> & {
  layout: 'auto' | PipelineLayout;
  vertex: RenderPipelineVertexState;
  fragment?: RenderPipelineFragmentState | undefined;
};

// ============================================================================
// 4 new descriptors (feat-20260508-rhi-surface-completion w8 / D-S5,
// feat-20260510-rhi-resource-creation M2 view narrow Path X)
// ============================================================================
//
// Field NAMES align byte-for-byte with @webgpu/types (Pick<GPUXxxDescriptor,
// ...> shape preserved; R12 lint enforces this). Field TYPES for `view` are
// SPEC-ALIGNED to the forgeax `TextureView` opaque handle (per
// feat-20260510-rhi-resource-creation IN-2 / AC-02 view narrow Path X;
// breakage point #1). The earlier D-S5 temporary tightening to `Texture` was
// retired once M1 of feat-20260510-rhi-resource-creation shipped
// `RhiDevice.createTextureView`, so AI users now follow the spec idiom:
//   const view = device.createTextureView(texture, desc).unwrap();
//   pass.beginRenderPass({ colorAttachments: [{ view, ... }] });
//
// Charter mapping: proposition 5 consistent abstraction (call site lines up
// with what `createTextureView` returns) + proposition 4 explicit failure
// (passing a Texture brand to `view` is a tsc red signal at the call site,
// not a runtime swap). The breakage point is registered in the AGENTS.md
// RHI / Shader error model contract section -> breakage point list (M7 of
// this closure).

/**
 * Command encoder descriptor (Pick<GPUCommandEncoderDescriptor, 'label'>).
 *
 * Spec anchor: W3C WebGPU 22 GPUCommandEncoder /
 * [@webgpu/types.GPUCommandEncoderDescriptor].
 *
 * @example
 * const desc: CommandEncoderDescriptor = { label: 'frame-encoder' };
 */
export type CommandEncoderDescriptor = ExplicitUndefined<
  Pick<GPUCommandEncoderDescriptor, 'label'>
>;

/**
 * Render-pass color attachment (Pick<GPURenderPassColorAttachment, ...> with
 * `view` field aligned to the forgeax `TextureView` opaque handle, per
 * feat-20260510-rhi-resource-creation M2 view narrow Path X / breakage point
 * #1).
 *
 * Spec anchor: W3C WebGPU 22.7 Render pass /
 * [@webgpu/types.GPURenderPassColorAttachment].
 *
 * v0.1.69 spec shape: `view: GPUTexture | GPUTextureView`. The forgeax RHI
 * tightens the union to the single `TextureView` brand (the only branch the
 * shim ever produces post-M1). Charter proposition 5 consistent abstraction
 * (the field type matches what `RhiDevice.createTextureView` returns) +
 * proposition 4 explicit failure (passing a `Texture` brand here is a tsc red
 * signal; the AI user is steered to the spec idiom).
 *
 * **Migration**: see AGENTS.md break-point list 2026-05-10 #1
 * "view: Texture -> TextureView narrow (major breaking)" for the call-site
 * upgrade diff (3 narrowed fields: this `view` + `resolveTarget` +
 * `RenderPassDepthStencilAttachment.view`).
 *
 * @example
 * const view = device.createTextureView(tex, {}).unwrap();
 * const att: RenderPassColorAttachment = {
 *   view,
 *   clearValue: { r: 0, g: 0, b: 0, a: 1 },
 *   loadOp: 'clear',
 *   storeOp: 'store',
 * };
 */
export type RenderPassColorAttachment = ExplicitUndefined<
  Omit<
    Pick<
      GPURenderPassColorAttachment,
      'view' | 'depthSlice' | 'resolveTarget' | 'clearValue' | 'loadOp' | 'storeOp'
    >,
    'view' | 'resolveTarget'
  >
> & {
  /**
   * TextureView target of this color attachment (view narrow Path X: aligned
   * to the forgeax `TextureView` brand returned by `createTextureView`; not
   * the spec union `GPUTexture | GPUTextureView`).
   */
  view: TextureView;
  /**
   * Optional resolve target for multisample resolution. Same view narrow
   * alignment as `view`.
   */
  resolveTarget?: TextureView | undefined;
};

/**
 * Render-pass depth/stencil attachment (Pick<GPURenderPassDepthStencilAttachment,
 * ...> with `view` field aligned to the forgeax `TextureView` opaque handle,
 * per feat-20260510-rhi-resource-creation M2 view narrow Path X / breakage
 * point #1).
 *
 * Spec anchor: W3C WebGPU 22.7 Render pass /
 * [@webgpu/types.GPURenderPassDepthStencilAttachment].
 *
 * Same view narrow alignment as RenderPassColorAttachment.
 *
 * **Migration**: see AGENTS.md break-point list 2026-05-10 #1 for the
 * call-site upgrade diff covering this `view` field plus the two
 * `RenderPassColorAttachment` narrowed fields.
 *
 * @example
 * const view = device.createTextureView(depthTex, {}).unwrap();
 * const ds: RenderPassDepthStencilAttachment = {
 *   view,
 *   depthClearValue: 1,
 *   depthLoadOp: 'clear',
 *   depthStoreOp: 'store',
 * };
 */
export type RenderPassDepthStencilAttachment = ExplicitUndefined<
  Omit<
    Pick<
      GPURenderPassDepthStencilAttachment,
      | 'view'
      | 'depthClearValue'
      | 'depthLoadOp'
      | 'depthStoreOp'
      | 'depthReadOnly'
      | 'stencilClearValue'
      | 'stencilLoadOp'
      | 'stencilStoreOp'
      | 'stencilReadOnly'
    >,
    'view'
  >
> & {
  /**
   * TextureView target of this depth/stencil attachment (view narrow Path X:
   * aligned to the forgeax `TextureView` brand).
   */
  view: TextureView;
};

/**
 * Render-pass descriptor (Pick<GPURenderPassDescriptor, ...>).
 *
 * Spec anchor: W3C WebGPU 22.7 Render pass /
 * [@webgpu/types.GPURenderPassDescriptor].
 *
 * `colorAttachments` element type uses the forgeax narrow
 * `RenderPassColorAttachment` (with `view: TextureView`);
 * `depthStencilAttachment` uses `RenderPassDepthStencilAttachment`.
 *
 * @example
 * const view = device.createTextureView(tex, {}).unwrap();
 * const desc: RenderPassDescriptor = {
 *   label: 'frame',
 *   colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store',
 *                        clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
 * };
 */
export type RenderPassDescriptor = ExplicitUndefined<
  Omit<
    Pick<
      GPURenderPassDescriptor,
      | 'label'
      | 'colorAttachments'
      | 'depthStencilAttachment'
      | 'occlusionQuerySet'
      | 'timestampWrites'
      | 'maxDrawCount'
    >,
    'colorAttachments' | 'depthStencilAttachment' | 'occlusionQuerySet' | 'timestampWrites'
  >
> & {
  /**
   * Color attachments for this render pass (forgeax narrow element type per
   * view narrow Path X: each entry's `view` field is `TextureView`, not the
   * spec union `GPUTexture | GPUTextureView`).
   */
  colorAttachments: Iterable<RenderPassColorAttachment | null | undefined>;
  /** Optional depth/stencil attachment with the same view narrow alignment. */
  depthStencilAttachment?: RenderPassDepthStencilAttachment | undefined;
  /** Occlusion query set (capability-gated). The shim accepts a
   *  `QuerySet` brand created via `device.createQuerySet({ type: 'occlusion',
   *  count })` and pairs it with `pass.beginOcclusionQuery(idx) /
   *  pass.endOcclusionQuery()`; both methods now have real implementations
   *  (see `RhiRenderPassEncoder` below). Capability gate: read
   *  `device.caps.timestampQuery` ahead of `'timestamp'` query sets;
   *  occlusion sets are unconditionally available. */
  occlusionQuerySet?: QuerySet | undefined;
  /** Optional timestamp query set and the pass boundary write slots. */
  timestampWrites?: RenderPassTimestampWrites | undefined;
};

/** Timestamp writes attached to a render pass descriptor. */
export type RenderPassTimestampWrites = ExplicitUndefined<
  Omit<GPURenderPassTimestampWrites, 'querySet'>
> & {
  querySet: QuerySet;
};

/** Compute-pass descriptor with forgeax-owned timestamp query handles. */
export type ComputePassDescriptor = ExplicitUndefined<
  Omit<Pick<GPUComputePassDescriptor, 'label' | 'timestampWrites'>, 'timestampWrites'>
> & {
  timestampWrites?: ComputePassTimestampWrites | undefined;
};

/** Timestamp writes attached to a compute pass descriptor. */
export type ComputePassTimestampWrites = RenderPassTimestampWrites;

// ============================================================================
// Capabilities trio (MVP-1.2) - readonly + independent fields
// ============================================================================
//
// Charter proposition 5 (consistent abstraction / discoverable differences):
// caps (hardware probe) / features (enabled set) / limits (numeric ceilings)
// are three independent semantic layers; `caps.X = false` is an explicit
// signal, never an exception (proposition 4).

/** Hardware-probe layer: readonly boolean capability flags. */
export interface RhiCaps {
  /**
   * The rendering backend kind — single source of truth for backend-aware
   * logic (e.g. explicit barrier insertion vs. spec-managed / GL-implicit
   * sync). Closed 4-member union: every backend reports exactly one.
   *
   * - `'webgpu'`: browser WebGPU — spec-managed barriers, no explicit
   *   barrier insertion needed.
   * - `'wgpu-native'`: wgpu native-desktop runtime (Tauri / native) —
   *   requires explicit Vulkan/Metal/DX12 barrier commands.
   * - `'wgpu-webgl2'`: wgpu GLES3/WebGL2 backend — GL implicit sync, no
   *   explicit barrier insertion needed (equivalence group with `'webgpu'`).
   * - `'null'`: headless no-op backend (`@forgeax/engine-rhi-null`) for
   *   structural unit tests — no GPU / DOM; records command-stream shape into
   *   a ledger instead of executing it. No barrier insertion needed (the
   *   no-op backend executes nothing); falls into the same no-barrier branch
   *   as `'webgpu'` / `'wgpu-webgl2'`.
   *
   * @note `exactOptionalPropertyTypes` requires every backend fill this
   *   field; a backend that omits it produces a tsc compile error.
   */
  readonly backendKind: 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null';
  /** Whether compute pipelines are supported. */
  readonly compute: boolean;
  /** Whether timestamp queries are supported. */
  readonly timestampQuery: boolean;
  /** Backend-owned nanoseconds represented by one timestamp tick, or null when unavailable. */
  readonly timestampPeriodNanoseconds: number | null;
  /** Whether indirect drawing is supported. */
  readonly indirectDrawing: boolean;
  /**
   * Whether BC texture compression (BC1-BC7) is available.
   *
   * Derived from `adapter.features.has('texture-compression-bc')`.
   * On rhi-null this is always `false` (headless has no compression hardware,
   * AC-06).
   */
  readonly textureCompressionBc: boolean;
  /**
   * Whether ETC2 texture compression is available.
   *
   * Derived from `adapter.features.has('texture-compression-etc2')`.
   * On rhi-null this is always `false` (headless has no compression hardware,
   * AC-06).
   */
  readonly textureCompressionEtc2: boolean;
  /**
   * Whether ASTC texture compression is available.
   *
   * Derived from `adapter.features.has('texture-compression-astc')`.
   * On rhi-null this is always `false` (headless has no compression hardware,
   * AC-06).
   */
  readonly textureCompressionAstc: boolean;
  /**
   * Whether multi-draw indirect is available (wgpu native extension).
   *
   * @reserved-for-wgpu-native-only always `false` on browser backends; only
   *   available when the forgeax renderer runs against a wgpu native runtime
   *   (Tauri / native runtime, not the wasm bundle). `caps.X = false` is an
   *   explicit signal, never an exception (charter proposition 4 / AGENTS.md
   *   `RHI / WebGPU` shape rule #2 capability-gated).
   */
  readonly multiDrawIndirect: boolean;
  /**
   * Whether push constants are available (wgpu native extension).
   *
   * @reserved-for-wgpu-native-only always `false` on browser backends; only
   *   available when the forgeax renderer runs against a wgpu native runtime
   *   (Tauri / native runtime, not the wasm bundle). `caps.X = false` is an
   *   explicit signal, never an exception (charter proposition 4 / AGENTS.md
   *   `RHI / WebGPU` shape rule #2 capability-gated).
   */
  readonly pushConstants: boolean;
  /**
   * Whether bindless texture array is available (wgpu native extension).
   *
   * @reserved-for-wgpu-native-only always `false` on browser backends; only
   *   available when the forgeax renderer runs against a wgpu native runtime
   *   (Tauri / native runtime, not the wasm bundle). `caps.X = false` is an
   *   explicit signal, never an exception (charter proposition 4 / AGENTS.md
   *   `RHI / WebGPU` shape rule #2 capability-gated).
   */
  readonly textureBindingArray: boolean;
  /**
   * Whether sampler binding aliasing is supported across pipelines.
   *
   * @spec-anchor W3C WebGPU §10.3 Bind group layout — spec mandates that a
   *   sampler may alias multiple binding slots; both navigator.gpu and the
   *   wgpu wasm bundle satisfy this so the field is always `true` on browser
   *   backends.
   * @note Always `true` on shipped backends (WebGPU + wgpu wasm). The field
   *   exists for potential future backends that lack sampler aliasing.
   * @hint AI users use `caps.samplerAliasing` to gate code that creates two
   *   `BindGroupEntry`s pointing at the same `Sampler` across different
   *   layouts; `caps.X = false` is an explicit signal, never an exception
   *   (charter proposition 4).
   */
  readonly samplerAliasing: boolean;
  /**
   * Whether the renderer can issue indirect draws with a non-zero
   * `firstInstance`.
   *
   * @spec-anchor W3C WebGPU §22.4 drawIndirect — the `indirect-first-instance`
   *   feature on `GPUAdapter.features` gates non-zero `firstInstance` in
   *   indirect draws; rhi-webgpu maps this to `device.features.has(
   *   'indirect-first-instance')`.
   * @note `false` on backends without indirect drawing support.
   * @hint Most AI users never need this; the field surfaces so a renderer
   *   author building instanced draw batchers can gate the fast path. With
   *   `caps.firstInstanceIndirect === false` the renderer must pre-rebase
   *   instance indices in the vertex shader (charter proposition 5
   *   consistent abstraction over a discoverable cap difference).
   */
  readonly firstInstanceIndirect: boolean;
  /**
   * Whether storage buffer bindings are available
   * (`device.limits.maxStorageBuffersPerShaderStage > 0`).
   *
   * @spec-anchor W3C WebGPU §3.6.2 GPUSupportedLimits.
   *   maxStorageBuffersPerShaderStage; `> 0` means the device supports the
   *   `storage` / `read-only-storage` binding types.
   * @note `false` on backends without storage buffer support.
   * @hint AI users gate compute / large-buffer paths on
   *   `caps.storageBuffer`; the per-stage numeric limit lives on
   *   `device.limits.maxStorageBuffersPerShaderStage` for capacity planning
   *   (charter proposition 4: `caps.X = false` is an explicit signal).
   */
  readonly storageBuffer: boolean;
  /**
   * Whether storage texture bindings are available
   * (`device.limits.maxStorageTexturesPerShaderStage > 0`).
   *
   * @spec-anchor W3C WebGPU §3.6.2 GPUSupportedLimits.
   *   maxStorageTexturesPerShaderStage; `> 0` means the device supports the
   *   `write-only` / `read-write` storage texture binding types.
   * @note `false` on backends without storage texture support.
   * @hint AI users gate image-effects compute / postprocess paths on
   *   `caps.storageTexture`; the per-stage numeric limit lives on
   *   `device.limits.maxStorageTexturesPerShaderStage` (charter proposition
   *   4: `caps.X = false` is an explicit signal).
   */
  readonly storageTexture: boolean;
  /**
   * Whether the device can create `rgba16float` textures with `RENDER_ATTACHMENT`
   * usage, enabling the HDR cubemap path for IBL irradiance / specular prefilter
   * and downstream HDR render-target chains.
   *
   * @spec-anchor W3C WebGPU $25.1 GPUTextureFormat — `rgba16float` is an
   *   optional texture format whose `RENDER_ATTACHMENT` capability is probed by
   *   attempting `createTexture({ format: 'rgba16float', usage:
   *   GPUTextureUsage.RENDER_ATTACHMENT, size: [1, 1, 1] })` on the live
   *   device; failure maps the cap to `false`.
   * @note Probed at device-creation time via a synchronous `createTexture`
   *   call, not via `GPUAdapter.features`. The `rgba16float` format is widely
   *   supported but `RENDER_ATTACHMENT` with float formats is optional per spec
   *   so the cap reflects the concrete device, not the adapter feature list.
   * @hint AI users gate IBL / HDR post-processing paths on
   *   `caps.rgba16floatRenderable`; when `false` the internal equirect-to-cubemap
   *   IBL projection (driven by declaring `Skylight{equirect}`) degrades to the
   *   white-cube fallback and fires `{ code: 'equirect-projection-failed' }` with
   *   a machine-readable `expected` field naming this cap (charter P3 structured
   *   failure).
   */
  readonly rgba16floatRenderable: boolean;
  /**
   * Whether the device can create `rg11b10ufloat` textures with
   * `RENDER_ATTACHMENT` usage, enabling the HDR swapchain / render-target path
   * with reduced bit-depth precision versus `rgba16float`.
   *
   * @spec-anchor W3C WebGPU $25.1 GPUTextureFormat — `rg11b10ufloat` is
   *   `RENDER_ATTACHMENT`-capable only when the optional feature
   *   `rg11b10ufloat-renderable` is enabled (W3C WebGPU $4.2). Probed by gating
   *   on `device.features.has('rg11b10ufloat-renderable')` first; only then
   *   confirmed by `createTexture({ format: 'rg11b10ufloat', usage:
   *   GPUTextureUsage.RENDER_ATTACHMENT, size: [1, 1, 1] })`.
   * @note The format packs 11+11+10 unsigned float bits into 32 bits per pixel;
   *   it is a popular HDR swapchain format for engines that trade precision
   *   for bandwidth but its `RENDER_ATTACHMENT` capability is not universal.
   *   The feature gate is the authoritative answer (avoiding fan-out via
   *   `device.onuncapturederror` when the optional feature is absent); the
   *   subsequent probe handles the rare case where the feature is reported
   *   but the concrete device still rejects.
   * @hint AI users can select an HDR back-buffer format by reading
   *   `caps.rg11b10ufloatRenderable` before creating a
   *   `GPUTextureUsage.RENDER_ATTACHMENT` texture at that format; when `false`
   *   fall back to `rgba16float` (if `caps.rgba16floatRenderable` is true)
   *   or an SDR format.
   */
  readonly rg11b10ufloatRenderable: boolean;
  /**
   * Whether the device supports sampling `rgba32float` textures with a
   * `filtering` sampler (linear / mipmap filtering), NOT just with a
   * `non-filtering` sampler.
   *
   * @spec-anchor W3C WebGPU $10.3 Bind group layout — a bind group layout
   *   entry pairing a `filtering` sampler type with `sampleType: 'float'`
   *   (matching `rgba32float`) validates only when the
   *   `float32-filterable` feature is enabled. The cap probes this via
   *   `device.createBindGroupLayout({ entries: [{ sampler: { type:
   *   'filtering' } }, { texture: { sampleType: 'float' } }] })` and
   *   `device.createSampler({ minFilter: 'linear', magFilter: 'linear' })`;
   *   failure maps the cap to `false`.
   * @note Probed by gating on `device.features.has('float32-filterable')`
   *   first (the authoritative answer per spec $4.2; avoids fan-out via
   *   `device.onuncapturederror` when the optional feature is absent); only
   *   then confirmed by exercising the bind-group-layout. The subsequent
   *   probe handles the rare case where the feature is reported but the
   *   concrete device still rejects (spec ambiguity, driver quirks).
   * @hint AI users gate float32-sampled compute / post-process paths on
   *   `caps.float32Filterable`; when `false` use `sampleType: 'unfilterable-
   *   float'` with a `non-filtering` sampler and compute the filter kernel
   *   manually in the shader, or fall back to `rgba16float` with filtering.
   */
  readonly float32Filterable: boolean;
  /**
   * `importTexture` wraps a caller-created native `GPUTexture` from the same
   * device. `false` on rhi-wgpu (no native WebGPU device), where the call
   * returns `feature-not-enabled`. rhi-null admits it structurally.
   */
  readonly textureImport: boolean;
  /**
   * `importExternalTexture` produces zero-copy `texture_external` bindings.
   * Requires `GPUDevice.importExternalTexture` and a media source realm
   * (`HTMLVideoElement` or `VideoFrame`). When `false`, bind a sampled
   * texture view in the same `externalTexture` layout slot (copy path).
   */
  readonly externalTexture: boolean;
  /**
   * Maximum number of color attachments per render pass.
   *
   * @spec-anchor W3C WebGPU $3.6.2 GPUSupportedLimits.maxColorAttachments;
   *   spec minimum = 4, defaults to 8 on mainstream backends.
   *   HDRP deferred pipeline requires >= 4 (3 g-buffer RT + 1 depth);
   *   installPipeline checks this cap at install time and throws
   *   a structured Standard transport refusal on violation (charter P3).
   * @note add-only minor (feat-20260612-hdrp-deferred-shading-learn-render-5-8
   *   M1 / w5); no existing field is modified.
   */
  readonly maxColorAttachments: number;
  /**
   * Hardware Ray Query (inline `ray_query` in compute/fragment WGSL over a
   * BLAS/TLAS). Absence is data: `{ supported: false, reason }` with a closed
   * reason; browser WebGPU, wgpu WebGL2 and the default RhiNull device report
   * `'backend-has-no-ray-query'`. When supported, the record carries the
   * admitted acceleration-structure limits. See `./ray-query.ts`.
   */
  readonly rayQuery: RhiRayQueryCaps;
}

/**
 * Enabled feature set, opaque iteration only via `has()`.
 *
 * Aligned with `GPUSupportedFeatures` shape; this empty interface intentionally
 * adds no fields — the concrete enabled set is decided at `requestDevice` time
 * and is then probed by AI users via `device.features.has('feature-name')`
 * (charter proposition 5 consistent abstraction; no implementation-detail leak,
 * no enumeration helper that would tie callers to a fixed feature list).
 *
 * @see {@link GPUSupportedFeatures}
 */
export interface RhiFeatures extends ReadonlySet<GPUFeatureName> {
  /** Aligned with GPUSupportedFeatures shape; concrete enabled set is decided
   *  at device creation time. */
}

/** Numeric-limits layer aligned with GPUSupportedLimits (incl Compatibility
 *  Mode follow-on fields). */
export type RhiLimits = Readonly<GPUSupportedLimits>;

// ============================================================================
// 7 main interfaces: Device / Queue / CommandEncoder / RenderPassEncoder /
//                   ComputePassEncoder / RenderPipeline / ComputePipeline
// ============================================================================
//
// Interface signatures accept POD + ArrayBuffer / Float32Array (math-free /
// MVP-1.5); all fallible operations return Result<T, RhiError>
// (D-5 + AGENTS.md error baseline).
//
// Note: interface names RenderPipeline / ComputePipeline / CommandEncoder
// match opaque handle names - spec-aligned choice (per plan-strategy 7.1)
// matching GPURenderPipeline et al; module-path semantics distinguish them.
// M1 interfaces express "operation verb sets"; opaque handles serve as
// return-value types.

// ============================================================================
// RhiInstance + RhiAdapter (M3 break-point #2; K-5 / K-6)
// ============================================================================
//
// Strict two-step path: `rhi.requestAdapter(opts) -> adapter.requestDevice(opts)`
// mirrors wgpu (research §6.1) + Dawn (§6.2) source-level idiom. The legacy
// top-level `rhi.requestDevice(opts)` factory is deprecated in favour of this
// path; AGENTS.md break-point list registers the deprecation under
// feat-20260510-rhi-resource-creation.
//
// K-5: `RhiAdapter.features: ReadonlySet<GPUFeatureName>` (Round 3 fix-up
//      F-P1-2: aligned with `RhiDevice.features: RhiFeatures extends
//      ReadonlySet<GPUFeatureName>` so the cross-tier surface is uniform —
//      AI users use `.has(name)` on both abstraction layers; previously a
//      `ReadonlyArray<string>` projection drifted from the spec
//      `GPUSupportedFeatures` Set shape and split the AI-user idiom).
//      `RhiAdapter.limits: Readonly<Record<string, number>>` aligns with
//      `GPUAdapter.limits` (`GPUSupportedLimits`). RhiDevice.caps stays
//      as the existing high-level boolean gate (caps.compute /
//      caps.timestampQuery etc.).
//
// K-6: `RhiAdapter.requestDevice` returns `Result<RhiDevice, RhiError>` (NOT a
//      `(Device, Queue)` tuple). The queue continues to be exposed via the
//      existing `RhiDevice.queue: RhiQueue` field (spec `device.queue` auto-
//      provisioned, packages/rhi/src/index.ts).

/**
 * RhiAdapter request options.
 *
 * Spec anchor: W3C WebGPU §3.2 `GPURequestAdapterOptions` /
 * [@webgpu/types.GPURequestAdapterOptions]. Fields pass through to the
 * underlying `navigator.gpu.requestAdapter(opts)` call.
 */
export type RequestAdapterOptions = ExplicitUndefined<
  Pick<GPURequestAdapterOptions, 'powerPreference' | 'forceFallbackAdapter'>
>;

/**
 * RhiAdapter.requestDevice options.
 *
 * Spec anchor: W3C WebGPU §3.4 `GPUDeviceDescriptor` /
 * [@webgpu/types.GPUDeviceDescriptor]. Fields pass through to the underlying
 * `adapter.requestDevice(opts)` call.
 */
export type RequestDeviceOptions = ExplicitUndefined<
  Pick<GPUDeviceDescriptor, 'label' | 'requiredFeatures' | 'requiredLimits'>
>;

/**
 * RhiInstance — entry point for adapter discovery (K-6 strict two-step path).
 *
 * Spec anchor: W3C WebGPU §3.1 `GPU` interface / [@webgpu/types.GPU]; wgpu
 * `Instance::request_adapter` (research §6.1) + Dawn
 * `InstanceBase::APIRequestAdapter` (§6.2).
 *
 * Replaces the legacy top-level `rhi.requestDevice(opts)` factory (break-
 * point #2). AI users follow the spec idiom:
 *   const a = (await rhi.requestAdapter()).unwrap();
 *   const d = (await a.requestDevice(opts)).unwrap();
 *
 * @example
 *   const adapterResult = await rhi.requestAdapter();
 *   if (!adapterResult.ok) {
 *     // route via switch (adapterResult.error.code)
 *   }
 */
export interface RhiInstance {
  /**
   * Request a GPU adapter.
   *
   * Spec anchor: W3C WebGPU §3.1 `GPU.requestAdapter` /
   * [@webgpu/types.GPU.requestAdapter].
   *
   * @param opts — W3C-spec request adapter options (powerPreference,
   *   forceFallbackAdapter).
   * @param compatibleSurface — non-W3C extension required by the wgpu GL
   *   backend for adapter enumeration. Provided as a positional escape hatch
   *   so the first parameter stays spec-aligned (plan-strategy D-5).
   *   rhi-webgpu accepts and ignores this parameter (dual-impl symmetry);
   *   rhi-wgpu routes it to `requestAdapterWithCanvas`.
   *
   * Failure paths (research §F-5):
   *   - adapter null -> `Result.err({ code: 'adapter-unavailable' })`.
   */
  requestAdapter(
    opts?: RequestAdapterOptions | undefined,
    compatibleSurface?: RhiCanvasTarget | undefined,
  ): Promise<Result<RhiAdapter, RhiError>>;
}

/**
 * RhiAdapter — capability-probe layer + device-creation entry (K-5 + K-6).
 *
 * Spec anchor: W3C WebGPU §3.2 `GPUAdapter` interface /
 * [@webgpu/types.GPUAdapter]; wgpu `Adapter::request_device` (research §6.1)
 * + Dawn `AdapterBase::APIRequestDevice` (§6.2).
 *
 * The `features` / `limits` fields let AI users **pre-screen** device
 * capabilities before calling `requestDevice(opts)` (charter proposition 4
 * forward-reachable: features mismatch becomes visible before spec
 * validation surfaces it).
 *
 * @example
 *   if (!adapter.features.has('timestamp-query')) {
 *     // skip timestamp-related code paths
 *   }
 *   const deviceResult = await adapter.requestDevice({
 *     requiredFeatures: ['timestamp-query'],
 *   });
 */
export interface RhiAdapter {
  /**
   * Read-only feature-name set (K-5).
   *
   * Aligned with `GPUAdapter.features` projection of `GPUSupportedFeatures`
   * (a read-only Set) **and** with `RhiDevice.features` (Round 3 fix-up
   * F-P1-2: cross-tier shape uniformity — AI users use `.has(name)` on
   * both abstraction layers, no projection drift).
   *
   * F-1 ai-user-review: mutation of set entries (`features.add('x')` /
   * deletion / clear) is rejected at compile time via `ReadonlySet`;
   * charter proposition 4 explicit failure + proposition 5 consistent
   * abstraction.
   */
  readonly features: ReadonlySet<GPUFeatureName>;
  /**
   * Read-only numeric-limits map (K-5).
   *
   * Aligned with `GPUAdapter.limits` projection of `GPUSupportedLimits`. The
   * forgeax form flattens to a `Readonly<Record<string, number>>` so AI users
   * can do `adapter.limits.maxTextureDimension2D` lookups without holding the
   * spec object handle.
   *
   * F-1 ai-user-review: mutation of values (`limits.x = 0`) is rejected at
   * compile time.
   */
  readonly limits: Readonly<Record<string, number>>;
  /**
   * Request a GPU device.
   *
   * Spec anchor: W3C WebGPU §3.2 `GPUAdapter.requestDevice` /
   * [@webgpu/types.GPUAdapter.requestDevice].
   *
   * Returns `Result<RhiDevice, RhiError>` (K-6: NOT a `(Device, Queue)` tuple
   * — queue is exposed via `RhiDevice.queue`).
   *
   * Failure paths (research §F-5):
   *   - feature not enabled -> `Result.err({ code: 'feature-not-enabled' })`.
   *   - limit exceeded -> `Result.err({ code: 'limit-exceeded' })`.
   */
  requestDevice(opts?: RequestDeviceOptions | undefined): Promise<Result<RhiDevice, RhiError>>;
}

// ============================================================================
// RhiSurface + RhiCanvasContext (M3 / K-4)
// ============================================================================
//
// Spec anchor: W3C WebGPU §3.3 GPUCanvasContext / §3.3 GPUCanvasConfiguration.
// 4 methods + 7 fields per research §3.1 + §3.2; 4-method algorithms per
// research §3.3. K-4 decision: getCurrentTexture returns Result<Texture,
// RhiError> (NOT TextureView) — spec literal alignment + AI users go two-step:
//   const tex = canvasContext.getCurrentTexture().unwrap();
//   const view = device.createTextureView(tex, {}).unwrap();

/**
 * Canvas configuration descriptor (Pick<GPUCanvasConfiguration, 7 fields>).
 *
 * Spec anchor: W3C WebGPU §3.3 `GPUCanvasConfiguration` /
 * [@webgpu/types.GPUCanvasConfiguration].
 *
 * 7 fields (research §3.2):
 *   - `device` (required): the GPUDevice for the configured context.
 *   - `format` (required): one of `{'bgra8unorm', 'rgba8unorm', 'rgba16float'}`
 *     (the spec normative supported context formats).
 *   - `usage` (default `0x10` = RENDER_ATTACHMENT): bitmask of GPUTextureUsage
 *     for the swap-chain textures.
 *   - `viewFormats` (default `[]`): list of formats createView may yield;
 *     **the spec sRGB-render-target idiom** uses `format='bgra8unorm'` +
 *     `viewFormats=['bgra8unorm-srgb']` + `device.createTextureView` (research
 *     §3.2 normative).
 *   - `colorSpace` (default `'srgb'`): predefined color space for the canvas.
 *   - `toneMapping` (default `{}` ≅ `{ mode: 'standard' }`): HDR tone-mapping
 *     descriptor; the spec NOTE in research §3.2 says implementations
 *     without tone-mapping support **omit** this from `getConfiguration()`.
 *   - `alphaMode` (default `'opaque'`): canvas compositing mode.
 *
 * Field NAMES align byte-for-byte with the spec; the forgeax `?: T |
 * undefined` shape (S-7 / hard-constraint 10) lets writers omit or pass
 * `undefined` explicitly while the shim distinguishes via `'x' in src`.
 */
export type CanvasConfiguration = ExplicitUndefined<
  Omit<
    Pick<
      GPUCanvasConfiguration,
      'device' | 'format' | 'usage' | 'viewFormats' | 'colorSpace' | 'toneMapping' | 'alphaMode'
    >,
    'device'
  >
> & {
  /**
   * The forgeax RhiDevice the configured context binds to (D-S5 pattern: spec
   * `device: GPUDevice` is replaced by the forgeax brand so AI users pass the
   * device they got from `rhi.requestAdapter().requestDevice()`).
   */
  device: RhiDevice;
};

/** Same-realm display target. The Host owns extent changes and native context identity. */
export interface RhiCanvasTarget {
  readonly width: number;
  readonly height: number;
  getContext(kind: string, options?: unknown): unknown;
}

declare const RhiSurfaceBrand: unique symbol;
/**
 * RhiSurface — opaque abstraction over a canvas surface
 * (HTMLCanvasElement / OffscreenCanvas).
 *
 * Spec couples GPUCanvasContext to a canvas (research §3.1); the forgeax
 * abstraction wraps the raw GPUCanvasContext in an opaque brand. AI users
 * obtain the `RhiCanvasContext` via
 * `rhi.acquireCanvasContext(canvas)` (returns `Result<RhiCanvasContext, RhiError>`).
 *
 * Charter proposition 5 consistent abstraction: the surface brand decouples
 * AI-user code from the DOM canvas zoo (HTMLCanvasElement / OffscreenCanvas /
 * native Window).
 */
export interface RhiSurface {
  readonly [RhiSurfaceBrand]: void;
}

/**
 * RhiCanvasContext — forgeax canvas-context abstraction (M3 / K-4).
 *
 * Spec anchor: W3C WebGPU §3.3 `GPUCanvasContext` /
 * [@webgpu/types.GPUCanvasContext]. 4 methods (research §3.1) match the spec
 * names; the return types differ:
 *   - `configure` returns `Result<void, RhiError>` (the spec returns void; the
 *     forgeax form surfaces `webgpu-runtime-error` on format-gate / device-
 *     lost paths via Result, charter proposition 4 explicit failure).
 *   - `unconfigure` returns void (spec literal alignment).
 *   - `getConfiguration` returns `CanvasConfiguration | undefined` (the spec
 *     returns `GPUCanvasConfiguration?`; forgeax uses `undefined`).
 *   - `getCurrentTexture` returns `Result<Texture, RhiError>` (K-4: Texture
 *     brand, NOT TextureView; AI users go two-step
 *     `device.createTextureView(canvasContext.getCurrentTexture().unwrap(), {})`).
 *
 * Lifecycle (research §3.3 [[Expire the current texture]]): currentTexture
 * **must NOT be cached across frames** — every frame must call
 * `getCurrentTexture()` afresh.
 */
/** Configure-time proof that a storage surface can present through its endpoint. */
export interface RhiCanvasSurfaceDescriptorFacts {
  readonly format: string;
  readonly usage: number;
  readonly width: number;
  readonly height: number;
  readonly alphaMode: string;
  readonly presentMode: string;
}

export interface RhiCanvasSurfacePresentationProof {
  readonly descriptor: boolean;
  readonly acquisition: boolean;
  readonly validation: boolean;
  /** Stable identity for the concrete surface that produced this proof. */
  readonly surfaceIdentity?: string;
  /** Descriptor requested by the owner at configure time. */
  readonly requested?: RhiCanvasSurfaceDescriptorFacts;
  /** Descriptor accepted and validated by the concrete surface. */
  readonly validated?: RhiCanvasSurfaceDescriptorFacts;
}

export interface RhiCanvasContext {
  /** Concrete surface composition modes. Absent uses the WebGPU context contract; [] admits none. */
  readonly supportedAlphaModes?: readonly GPUCanvasAlphaMode[] | undefined;
  /** Backend-produced configure-time presentation proof; absent means fail closed. */
  readonly presentationProof?: RhiCanvasSurfacePresentationProof;
  /**
   * Configure the canvas context with a forgeax CanvasConfiguration.
   *
   * Returns `Result<void, RhiError>` (charter proposition 4 explicit failure).
   *
   * Failure paths (research §3.3):
   *   - `format` not in supported context formats (`{'bgra8unorm',
   *     'rgba8unorm', 'rgba16float'}`) -> `'webgpu-runtime-error'` with
   *     `.expected = 'one of bgra8unorm/rgba8unorm/rgba16float'`.
   *   - `device` invalid | lost -> `'rhi-not-available'`.
   *
   * @example
   *   const out = canvasContext.configure({
   *     device,
   *     format: 'bgra8unorm',
   *     usage: GPUTextureUsage.RENDER_ATTACHMENT,
   *     viewFormats: ['rgba8unorm-srgb'],
   *   });
   *   if (!out.ok) {
   *     // route via switch (out.error.code)
   *   }
   */
  configure(desc: CanvasConfiguration): Result<void, RhiError>;
  /**
   * Unconfigure the canvas context (spec literal void return).
   *
   * Idempotent (already-unconfigured contexts continue to be unconfigured;
   * Operation is silent).
   */
  unconfigure(): void;
  /**
   * Return the current canvas configuration, or `undefined` if the context is
   * unconfigured.
   *
   * Feature-detection entry (research §3.2 spec NOTE): when an implementation
   * does not support a configuration field (e.g. tone-mapping), the field is
   * **omitted** from the returned record (NOT defaulted) so AI users can use
   * `'toneMapping' in conf` to detect support.
   */
  getConfiguration(): CanvasConfiguration | undefined;
  /**
   * Get the current swap-chain texture (K-4: returns Texture brand, NOT
   * TextureView).
   *
   * Spec anchor: W3C WebGPU §3.3 `GPUCanvasContext.getCurrentTexture` /
   * [@webgpu/types.GPUCanvasContext.getCurrentTexture].
   *
   * Failure paths (research §3.3):
   *   - context unconfigured -> `'webgpu-runtime-error'` (spec
   *     `InvalidStateError` mapping).
   *
   * AI users typically pair this with `device.createTextureView` to get the
   * render-pass attachment view (charter proposition 5 consistent abstraction):
   *   const tex = canvasContext.getCurrentTexture().unwrap();
   *   const view = device.createTextureView(tex, {}).unwrap();
   *   pass.beginRenderPass({ colorAttachments: [{ view, ... }] });
   *
   * Lifecycle (research §3.3 [[Expire the current texture]]): each frame
   * **must call this fresh**; the forgeax shim does NOT cache across frames.
   */
  getCurrentTexture(): Result<Texture, RhiError>;
}

/** GPU device - sole entry point for resource creation + capability probing. */
export type {
  PipelineLibrary,
  PipelineLibraryCompute,
  PipelineLibraryInspection,
  PipelineLibraryLimits,
  PipelineLibraryManifest,
  PipelineLibraryPrepareOptions,
  PipelineLibraryRender,
  PipelineLibraryStage,
} from './pipeline-library';

export interface RhiDevice {
  /** Backend-owned exact pipeline reuse and portable startup preparation, when supported. */
  readonly pipelineLibrary?: import('./pipeline-library').PipelineLibrary;
  /** Hardware-probe layer (charter proposition 5). */
  readonly caps: RhiCaps;
  /** Enabled-features layer. */
  readonly features: RhiFeatures;
  /** Numeric-limits layer. */
  readonly limits: RhiLimits;

  /** Probe the complete r32float sampled/storage/readback profile once per device generation. */
  probeTextureFormatCapability(): Promise<Result<RhiTextureFormatCapabilityReceipt, RhiError>>;

  /**
   * Create GPU buffer. `usage` is the W3C `GPUBufferUsage` mask plus the RHI
   * extension `BLAS_INPUT_BUFFER_USAGE`, which returns `feature-not-enabled`
   * unless `caps.rayQuery.supported`.
   */
  createBuffer(desc: BufferDescriptor): Result<Buffer, RhiError>;
  /** Create GPU texture. */
  createTexture(desc: TextureDescriptor): Result<Texture, RhiError>;
  /**
   * Native WebGPU device for caller-created interop textures. Returns
   * `feature-not-enabled` on backends without one (rhi-wgpu, rhi-null).
   */
  nativeDevice(): Result<GPUDevice, RhiError>;
  /**
   * Borrow a caller-owned `GPUTexture` as an RHI texture. The texture must
   * belong to this device, be 2D and carry TEXTURE_BINDING usage; the
   * returned handle's `destroyTexture` releases only RHI bookkeeping and never
   * destroys the caller's texture. Device identity is validated through an
   * error scope, so the result is asynchronous.
   *
   * Failure paths:
   *   - `caps.textureImport === false` -> `feature-not-enabled`
   *   - foreign device -> `rhi-not-available`
   *   - wrong dimension / missing usage / destroyed -> `rhi-descriptor-invalid`
   */
  importTexture(texture: GPUTexture): Promise<Result<Texture, RhiError>>;
  /**
   * Import one frame of a video source for zero-copy sampling through a
   * `texture_external` binding. The handle expires with the current task.
   * Returns `feature-not-enabled` when `caps.externalTexture` is false.
   */
  importExternalTexture(desc: ExternalTextureDescriptor): Result<ExternalTexture, RhiError>;
  /**
   * Destroy a GPU buffer obtained from `createBuffer`.
   *
   * Spec anchor: W3C WebGPU §gpubuffer-destroy /
   * [@webgpu/types.GPUBuffer.destroy]; wgpu wasm
   * `RhiWgpuBuffer::destroy` (research §F-1; both surfaces are idempotent
   * void at the underlying GPU).
   *
   * The forgeax form prefers fail-fast over the spec idempotent void:
   * the shim layer (rhi-webgpu / rhi-wgpu) tracks per-handle
   * `destroyed: boolean` and surfaces a second destroy as
   * `Result.err({ code: 'destroy-after-destroy' })` rather than silently
   * succeeding. Double destroy is almost always a lifecycle bug — caching
   * a stale handle, a forgotten registry slot, a race between dispose
   * paths — and surfacing it early at the call site is more useful than
   * swallowing it (plan-strategy D-7 + architecture-principles §5 Fail
   * Fast). Charter proposition 4 explicit failure.
   *
   * Failure paths:
   *   - second destroy on the same handle ->
   *     `Result.err({ code: 'destroy-after-destroy' })`.
   *
   * @example
   *   const r = device.destroyBuffer(buf);
   *   if (!r.ok) {
   *     // route via switch (r.error.code)
   *   }
   */
  destroyBuffer(buf: Buffer): Result<void, RhiError>;

  /**
   * Create a bottom-level acceleration structure for opaque triangle
   * geometry. Requires `caps.rayQuery.supported`; otherwise
   * `feature-not-enabled`. Topology (geometry count, vertex/index counts) is
   * fixed here; data is supplied by `encoder.buildAccelerationStructures`.
   */
  createBlas(desc: BlasDescriptor): Result<Blas, RhiError>;
  /** Create a top-level acceleration structure holding up to `maxInstances` BLAS instances. */
  createTlas(desc: TlasDescriptor): Result<Tlas, RhiError>;
  /** Release a BLAS; TLAS builds that still reference it fail with `destroy-after-destroy`. */
  destroyBlas(blas: Blas): Result<void, RhiError>;
  /** Release a TLAS. */
  destroyTlas(tlas: Tlas): Result<void, RhiError>;
  /**
   * Destroy a GPU query set obtained from `createQuerySet`.
   *
   * Query sets are device-owned resources even though the WebGPU surface does
   * not expose them through the Buffer/Texture families. The explicit RHI
   * seam lets Render release timestamp query sets exactly once after queue
   * completion, including failure and disposal paths.
   */
  destroyQuerySet(querySet: QuerySet): Result<void, RhiError>;
  /**
   * Destroy a GPU texture obtained from `createTexture`.
   *
   * Spec anchor: W3C WebGPU §gputexture-destroy /
   * [@webgpu/types.GPUTexture.destroy]; wgpu wasm idempotent void at the
   * underlying GPU.
   *
   * Same fail-fast contract as `destroyBuffer`: the shim layer tracks
   * per-handle `destroyed: boolean` and surfaces a second destroy as
   * `Result.err({ code: 'destroy-after-destroy' })`.
   *
   * @example
   *   const r = device.destroyTexture(tex);
   *   if (!r.ok) {
   *     // route via switch (r.error.code)
   *   }
   */
  destroyTexture(tex: Texture): Result<void, RhiError>;
  /**
   * Create a GPU texture view of an existing texture.
   *
   * Spec anchor: W3C WebGPU §texture-view-creation /
   * [@webgpu/types.GPUTexture.createView].
   *
   * Introduced in feat-20260510-rhi-resource-creation (M1). Cross-resource
   * validation is performed fast-path by the shim before forwarding to raw
   * GPUTexture.createView (research §1.1):
   *   - `format` must be in `source.format ∪ source.viewFormats`; violation
   *     returns Result.err({ code: 'webgpu-runtime-error' }).
   *   - `usage` must be a subset of source.usage (bitmask); violation returns
   *     the same code.
   *
   * @example
   *   const r = device.createTextureView(tex, { format: 'rgba8unorm', dimension: '2d' });
   *   if (!r.ok) {
   *     // route via switch (r.error.code)
   *   }
   */
  createTextureView(texture: Texture, desc: TextureViewDescriptor): Result<TextureView, RhiError>;
  /** Create sampler (spec defaults are applied by the shim). */
  createSampler(desc?: SamplerDescriptor | undefined): Result<Sampler, RhiError>;
  /** Create bind group layout. */
  createBindGroupLayout(desc: BindGroupLayoutDescriptor): Result<BindGroupLayout, RhiError>;
  /**
   * Create a bind group (instantiated layout + resource bindings).
   *
   * Spec anchor: W3C WebGPU 10 Resource binding /
   * [@webgpu/types.GPUDevice.createBindGroup].
   *
   * Introduced in feat-20260509-ecs-render-bridge-mvp (D-S1) — additive
   * extension; reuses the existing 17-member `RhiErrorCode` union
   * ('feature-not-enabled' / 'limit-exceeded' / 'webgpu-runtime-error').
   * No new error code is introduced (AGENTS.md evolution contract no-op,
   * breakage list stays empty).
   *
   * @example
   *   const out = device.createBindGroup({ label: 'view-bg', layout: bgl, entries: [...] });
   *   if (!out.ok) {
   *     // route via switch (out.error.code)
   *   }
   */
  createBindGroup(desc: BindGroupDescriptor): Result<BindGroup, RhiError>;
  /**
   * Create a pipeline layout (aggregates BindGroupLayouts).
   *
   * Spec anchor: W3C WebGPU 10.3 Pipeline layout /
   * [@webgpu/types.GPUDevice.createPipelineLayout].
   *
   * Introduced in feat-20260509-ecs-render-bridge-mvp (D-S1) — additive
   * extension; reuses the existing 17-member `RhiErrorCode` union.
   *
   * @example
   *   const out = device.createPipelineLayout({ label: 'pbr-pl', bindGroupLayouts: [viewBgl, materialBgl, meshArrayBgl] });
   *   if (!out.ok) {
   *     // route via switch (out.error.code)
   *   }
   */
  createPipelineLayout(desc: PipelineLayoutDescriptor): Result<PipelineLayout, RhiError>;
  /** Create render pipeline (synchronous path). */
  createRenderPipeline(desc: RenderPipelineDescriptor): Result<RenderPipeline, RhiError>;
  /** Completion-qualified PSO: immediate only for an already completed device recipe; otherwise native async completion. */
  createRenderPipelineAsync?(
    desc: RenderPipelineDescriptor,
  ): Result<RenderPipeline, RhiError> | Promise<Result<RenderPipeline, RhiError>>;
  /**
   * Create a compute pipeline (synchronous path).
   *
   * Spec anchor: W3C WebGPU §compute-pipeline-creation /
   * [@webgpu/types.GPUDevice.createComputePipeline].
   *
   * Introduced in feat-20260510-rhi-resource-creation (M1). Capability gate
   * (research §1.2 + plan-strategy §4.3 boundary case row 1):
   *   `caps.compute === false` -> Result.err({ code: 'feature-not-enabled' }).
   * The MVP WebGPU path always has caps.compute=true; the gate exists for
   * potential future backends that lack compute.
   *
   * @example
   *   const r = device.createComputePipeline({
   *     layout: 'auto',
   *     compute: { module, entryPoint: 'cs_main' },
   *   });
   *   if (!r.ok) {
   *     // route via switch (r.error.code)
   *   }
   */
  createComputePipeline(desc: ComputePipelineDescriptor): Result<ComputePipeline, RhiError>;
  /** Completion-qualified compute recipe; a synchronous factory handle alone never qualifies. */
  createComputePipelineAsync?(
    desc: ComputePipelineDescriptor,
  ): Result<ComputePipeline, RhiError> | Promise<Result<ComputePipeline, RhiError>>;
  /**
   * Create a query set (occlusion or timestamp).
   *
   * Spec anchor: W3C WebGPU §queries / [@webgpu/types.GPUDevice.createQuerySet].
   *
   * Introduced in feat-20260510-rhi-resource-creation (M1). Hard constraints
   * (research §1.3):
   *   - `count <= 4096` (spec normative); violation -> 'limit-exceeded'.
   *   - `type === 'timestamp'` requires caps.timestampQuery; otherwise ->
   *     'feature-not-enabled'.
   *   - `count = 0` is legal.
   *
   * @example
   *   const r = device.createQuerySet({ type: 'occlusion', count: 4 });
   *   if (!r.ok) {
   *     // route via switch (r.error.code)
   *   }
   */
  createQuerySet(desc: QuerySetDescriptor): Result<QuerySet, RhiError>;

  /** Begin recording immutable commands for compatible render passes. */
  createRenderBundleEncoder(
    desc: RenderBundleEncoderDescriptor,
  ): Result<RhiRenderBundleEncoder, RhiError>;

  /**
   * Create a command encoder.
   *
   * Spec anchor: W3C WebGPU 21.2 createCommandEncoder /
   * [@webgpu/types.GPUDevice.createCommandEncoder].
   *
   * @example
   *   const encResult = device.createCommandEncoder({ label: 'frame' });
   *   if (!encResult.ok) {
   *     // route via switch (encResult.error.code)
   *   } else {
   *     const enc = encResult.value;
   *     // ... record commands ...
   *   }
   */
  createCommandEncoder(
    desc?: CommandEncoderDescriptor | undefined,
  ): Result<RhiCommandEncoder, RhiError>;

  // fix-f3: synchronous createShaderModule placeholder removed - the
  // shader-compile-failed error path must go through the top-level async
  // factory `createShaderModule(device, desc)` exported from
  // `@forgeax/engine-rhi-webgpu`. A synchronous placeholder would render the
  // 'shader-compile-failed' branch unreachable in
  // `switch (err.code)` exhaustive consumers (charter proposition 5
  // consistent abstraction). See plan-strategy 7.3 error-info table
  // shader row + verify Round 1 finding F3.

  /** Queue for command submission. */
  readonly queue: RhiQueue;

  /**
   * Spec-style device.lost Promise (research F-4 / R2 mitigation). The engine
   * layer performs single-source subscription + dual-form fan-out without a
   * second cache. `reason` is a binary union ('destroyed' / 'unknown').
   */
  // forgeax-async-whitelist: dom-native — spec `GPUDevice.lost` Promise
  // passthrough; resolves (never rejects) per spec normative when the
  // underlying device transitions to the lost state.
  readonly lost: Promise<{ readonly reason: 'destroyed' | 'unknown'; readonly message: string }>;
}

/** GPU command queue - writeBuffer / submit + M5 writeTexture /
 *  copyExternalImageToTexture / onSubmittedWorkDone. */
export interface RhiQueue {
  /** Direct write to a buffer (POD + ArrayBufferView, math-free). */
  writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number | undefined,
    size?: number | undefined,
  ): Result<void, RhiError>;
  /**
   * Direct write to a texture region.
   *
   * Spec anchor: W3C WebGPU §queue-writetexture /
   * [@webgpu/types.GPUQueue.writeTexture]. Field NAMES align byte-for-byte
   * with the spec; the forgeax form returns Result<void, RhiError> instead
   * of void so AI users can route alignment failures (research §1.3 +
   * plan-strategy 2 K-2: bytesPerRow % 256 != 0 maps to
   * 'queue-write-buffer-out-of-bounds').
   *
   * @example
   *   const out = device.queue.writeTexture(
   *     { texture: tex, mipLevel: 0, origin: [0, 0, 0] },
   *     pixels,
   *     { offset: 0, bytesPerRow: 256, rowsPerImage: H },
   *     { width: W, height: H, depthOrArrayLayers: 1 },
   *   );
   *   if (!out.ok) {
   *     // route via switch (out.error.code)
   *   }
   */
  writeTexture(
    destination: TexelCopyTextureInfo,
    data: ArrayBufferView | ArrayBuffer,
    dataLayout: Pick<GPUTexelCopyBufferLayout, 'offset' | 'bytesPerRow' | 'rowsPerImage'>,
    size: GPUExtent3DStrict,
  ): Result<void, RhiError>;
  /**
   * Copy an external image source (ImageBitmap / canvas / video) into a
   * GPUTexture region.
   *
   * Spec anchor: W3C WebGPU §queue-copyexternalimagetotexture /
   * [@webgpu/types.GPUQueue.copyExternalImageToTexture]. The forgeax form
   * returns Result<void, RhiError>.
   *
   * dawn-node note: dawn-node lacks HTMLCanvasElement / VideoFrame /
   * HTMLImageElement; only the ImageBitmap subset reachable from
   * createImageBitmap is exercised in dawn tests (research §7.1).
   */
  copyExternalImageToTexture(
    source: Pick<GPUCopyExternalImageSourceInfo, 'source' | 'origin' | 'flipY'>,
    destination: ExternalImageTextureDestination,
    copySize: GPUExtent3DStrict,
  ): Result<void, RhiError>;
  /** Submit command buffers (single-use). */
  submit(commandBuffers: readonly CommandBuffer[]): Result<void, RhiError>;
  /**
   * Resolve when all currently-enqueued operations have completed.
   *
   * Spec anchor: W3C WebGPU §queue-onsubmittedworkdone /
   * [@webgpu/types.GPUQueue.onSubmittedWorkDone]. Returns
   * `Promise<undefined>` per spec normative (research §5.1: no reject path;
   * device-lost flows through `RhiDevice.lost` instead). Ordering
   * constraints (research §5.2):
   *   - constraint #1 (FIFO): if p1 = q.onSubmittedWorkDone() is called
   *     before p2 = q.onSubmittedWorkDone(), p1 must settle before p2.
   *   - constraint #2 (mapAsync vs onSubmittedWorkDone): if p1 =
   *     b.mapAsync() is called before p2 = q.onSubmittedWorkDone(), p1 must
   *     settle before p2.
   *
   * @example Pattern A read-back idiom:
   *   const cb = enc.finish().value;
   *   queue.submit([cb]);
   *   await queue.onSubmittedWorkDone();
   *   await readBuf.mapAsync(GPUMapMode.READ);
   *   const range = readBuf.getMappedRange().value;
   */
  // forgeax-async-whitelist: dom-native — spec `GPUQueue.onSubmittedWorkDone`
  // never rejects (research §5.1 normative); failure surfaces via
  // `RhiDevice.lost` instead.
  onSubmittedWorkDone(): Promise<undefined>;
  /**
   * Optional delivery hold for `onSubmittedWorkDone`. While at least one hold
   * is open, promises from `onSubmittedWorkDone` that complete stay pending;
   * they settle, in their original order, once the last hold is released.
   * A cooperative frame takes a hold before it yields mid-preparation, so a
   * completion-driven release cannot destroy a resource that frame captured.
   * Returns an idempotent release.
   */
  holdCompletions?(): () => void;
  /**
   * Optional `onSubmittedWorkDone` that ignores `holdCompletions`. Reserved for
   * frame-credit feedback that never releases resources.
   */
  onSubmittedWorkDoneUnheld?(): Promise<undefined>;
}

/** GPU command encoder - records render / compute passes + resource copies.
 *
 * Method NAMES align byte-for-byte with `@webgpu/types.GPUCommandEncoder` +
 * `GPUDebugCommandsMixin` (research F-1 / D-S4). 12 spec methods plus one
 * ForgeAX compound operation:
 *   - 9 direct: beginRenderPass / beginComputePass / copyBufferToBuffer /
 *               copyBufferToTexture / copyTextureToBuffer / copyTextureToTexture /
 *               clearBuffer / resolveQuerySet / finish
 *   - 3 mixin (GPUDebugCommandsMixin): pushDebugGroup / popDebugGroup /
 *                                     insertDebugMarker
 *
 * Lifecycle: after `finish()`, all subsequent recording calls return
 * Result.err({ code: 'command-encoder-finished' }) per D-S3 template 1
 * (where the method returns Result; void-returning methods throw the
 * structured error so AI users observe the failure consistently).
 */
export interface RhiCommandEncoder {
  /** Begin render pass (auto-closes on end()).
   *
   * Spec anchor: [@webgpu/types.GPUCommandEncoder.beginRenderPass].
   *
   * @throws RhiError code === 'command-encoder-finished' when invoked on a finished encoder (dual-channel: spec-aligned void return throws on finished state; AI users wrap call sites with `try / catch (e: unknown) { if (e instanceof RhiError && e.code === 'command-encoder-finished') ... }`).
   * @example
   *   const pass = encoder.beginRenderPass({ colorAttachments: [{ ... }] });
   */
  beginRenderPass(desc: RenderPassDescriptor): RhiRenderPassEncoder;
  /** Begin compute pass.
   *
   * Spec anchor: [@webgpu/types.GPUCommandEncoder.beginComputePass].
   *
   * @throws RhiError code === 'command-encoder-finished' when invoked on a finished encoder (dual-channel: see beginRenderPass for the recovery pattern).
   * @example
   *   const pass = encoder.beginComputePass();
   */
  beginComputePass(desc?: ComputePassDescriptor | undefined): RhiComputePassEncoder;
  /**
   * Record an empty timestamp-enabled compute pass and close it immediately.
   *
   * This is a ForgeAX compound recording operation equivalent to
   * `const pass = encoder.beginComputePass(desc); pass.end()`; it is not a
   * native `GPUCommandEncoder` method and does not write a timestamp directly.
   *
   * @throws RhiError code === 'command-encoder-finished' when invoked on a
   *   finished encoder.
   */
  encodeEmptyComputePass(desc: ComputePassDescriptor): void;
  /** Copy a sub-region of a Buffer to another Buffer (5-arg full form).
   *
   * Spec anchor: [@webgpu/types.GPUCommandEncoder.copyBufferToBuffer].
   *
   * @throws RhiError code === 'command-encoder-finished' when invoked on a finished encoder (dual-channel; see beginRenderPass JSDoc for the recovery pattern). Both overloads share the same throw contract.
   * @example
   *   encoder.copyBufferToBuffer(src, 0, dst, 0, 256);
   */
  copyBufferToBuffer(
    source: Buffer,
    sourceOffset: number,
    destination: Buffer,
    destinationOffset: number,
    size: number,
  ): void;
  /** Copy a Buffer to another Buffer (3-arg shorthand).
   *
   * Spec anchor: [@webgpu/types.GPUCommandEncoder.copyBufferToBuffer].
   *
   * @throws RhiError code === 'command-encoder-finished' when invoked on a finished encoder (dual-channel; see beginRenderPass JSDoc for the recovery pattern). Both overloads share the same throw contract.
   * @example
   *   encoder.copyBufferToBuffer(src, dst, 256);
   */
  copyBufferToBuffer(source: Buffer, destination: Buffer, size?: number | undefined): void;
  /** Copy a Buffer sub-region to a Texture sub-region.
   *
   * Spec anchor: [@webgpu/types.GPUCommandEncoder.copyBufferToTexture].
   *
   * @throws RhiError code === 'command-encoder-finished' when invoked on a finished encoder (dual-channel; see beginRenderPass JSDoc for the recovery pattern).
   * @example
   *   encoder.copyBufferToTexture(srcInfo, dstInfo, [w, h, 1]);
   */
  copyBufferToTexture(
    source: TexelCopyBufferInfo,
    destination: TexelCopyTextureInfo,
    copySize: GPUExtent3DStrict,
  ): void;
  /** Copy a Texture sub-region to a Buffer sub-region.
   *
   * Spec anchor: [@webgpu/types.GPUCommandEncoder.copyTextureToBuffer].
   *
   * @throws RhiError code === 'command-encoder-finished' when invoked on a finished encoder (dual-channel; see beginRenderPass JSDoc for the recovery pattern).
   * @example
   *   encoder.copyTextureToBuffer(srcInfo, dstInfo, [w, h, 1]);
   */
  copyTextureToBuffer(
    source: TexelCopyTextureInfo,
    destination: TexelCopyBufferInfo,
    copySize: GPUExtent3DStrict,
  ): void;
  /** Copy a Texture sub-region to a Texture sub-region.
   *
   * Spec anchor: [@webgpu/types.GPUCommandEncoder.copyTextureToTexture].
   *
   * @throws RhiError code === 'command-encoder-finished' when invoked on a finished encoder (dual-channel; see beginRenderPass JSDoc for the recovery pattern).
   * @example
   *   encoder.copyTextureToTexture(srcInfo, dstInfo, [w, h, 1]);
   */
  copyTextureToTexture(
    source: TexelCopyTextureInfo,
    destination: TexelCopyTextureInfo,
    copySize: GPUExtent3DStrict,
  ): void;
  /** Fill a Buffer sub-region with zeros.
   *
   * Spec anchor: [@webgpu/types.GPUCommandEncoder.clearBuffer].
   *
   * @throws RhiError code === 'command-encoder-finished' when invoked on a finished encoder (dual-channel; see beginRenderPass JSDoc for the recovery pattern).
   * @example
   *   encoder.clearBuffer(buf, 0, 256);
   */
  clearBuffer(buffer: Buffer, offset?: number | undefined, size?: number | undefined): void;
  /** Resolve query results from a QuerySet to a Buffer.
   *
   * Real implementation (M3 / w26): writes 8-byte query results in 256-byte
   * aligned strides into `destination` starting at `destinationOffset`.
   * Validates `destination.usage & GPUBufferUsage.QUERY_RESOLVE` and the
   * 256-byte alignment up front; on misuse returns
   * `Result.err({ code: 'webgpu-runtime-error', ... })` with a structured
   * .expected / .hint pair.
   *
   * Spec anchor: [@webgpu/types.GPUCommandEncoder.resolveQuerySet].
   *
   * @example
   *   const out = encoder.resolveQuerySet(qs, 0, 4, dstBuf, 0);
   *   if (!out.ok) {
   *     // switch (out.error.code) { case 'webgpu-runtime-error': ... }
   *   }
   */
  resolveQuerySet(
    querySet: QuerySet,
    firstQuery: number,
    queryCount: number,
    destination: Buffer,
    destinationOffset: number,
  ): Result<void, RhiError>;
  /** Push a labelled debug group (GPUDebugCommandsMixin).
   *
   * Spec anchor: [@webgpu/types.GPUDebugCommandsMixin.pushDebugGroup].
   *
   * @note silent delegate to raw GPU encoder on finished encoder; matches W3C spec lenience (the debug-commands mixin permits a no-op pass-through after finish() so the signal stays real instead of forging a `@throws` contract; charter proposition 4).
   * @example
   *   encoder.pushDebugGroup('frame-setup');
   */
  pushDebugGroup(groupLabel: string): void;
  /** Pop the most recent debug group (GPUDebugCommandsMixin).
   *
   * Spec anchor: [@webgpu/types.GPUDebugCommandsMixin.popDebugGroup].
   *
   * @note silent delegate to raw GPU encoder on finished encoder; matches W3C spec lenience (see pushDebugGroup JSDoc for the dual-channel rationale).
   * @example
   *   encoder.popDebugGroup();
   */
  popDebugGroup(): void;
  /** Insert a labelled debug marker (GPUDebugCommandsMixin).
   *
   * Spec anchor: [@webgpu/types.GPUDebugCommandsMixin.insertDebugMarker].
   *
   * @note silent delegate to raw GPU encoder on finished encoder; matches W3C spec lenience (see pushDebugGroup JSDoc for the dual-channel rationale).
   * @example
   *   encoder.insertDebugMarker('post-resolve');
   */
  insertDebugMarker(markerLabel: string): void;
  /** Finish recording -> CommandBuffer. After finish() any further recording
   *  call returns Result.err({ code: 'command-encoder-finished' }).
   *
   * Spec anchor: [@webgpu/types.GPUCommandEncoder.finish].
   *
   * @example
   *   const cb = encoder.finish();
   *   if (cb.ok) device.queue.submit([cb.value]);
   */
  finish(): Result<CommandBuffer, RhiError>;
  /**
   * Record acceleration-structure builds: every BLAS entry first, then every
   * TLAS entry, so a TLAS may reference a BLAS built in the same call.
   * Re-building an existing handle is the update path (a TLAS re-build with
   * new instance transforms each frame; a BLAS created with
   * `updateMode: 'refit'` may refit in place). Requires
   * `caps.rayQuery.supported`; otherwise `feature-not-enabled`.
   */
  buildAccelerationStructures(
    blas: readonly BlasBuildEntry[],
    tlas: readonly TlasBuildEntry[],
  ): Result<void, RhiError>;
}

/** GPU render pass encoder - records draw calls + state changes.
 *
 * Method NAMES align byte-for-byte with @webgpu/types.GPURenderPassEncoder +
 * GPURenderCommandsMixin + GPUBindingCommandsMixin + GPUDebugCommandsMixin
 * Typed immutable bundles use the same drawing mixins. Occlusion queries
 * use RenderPassDescriptor.occlusionQuerySet.
 *
 * `setImmediates` (PROPOSED) is intentionally NOT exposed (charter
 * proposition 4: untested features hide behind caps, not surfaces).
 *
 * Lifecycle: encoder.finish() while a pass is unfinished returns
 * Result.err({ code: 'render-pass-not-ended' }) per D-S3 template 2.
 */
export interface RhiRenderPassEncoder {
  // ===== Existing 7 methods (Round 1 baseline) =====
  /** Set the bound render pipeline.
   *
   * Spec anchor: [@webgpu/types.GPURenderCommandsMixin.setPipeline].
   *
   * @example pass.setPipeline(pipeline);
   */
  setPipeline(pipeline: RenderPipeline): void;
  /** Set a vertex buffer.
   *
   * Spec anchor: [@webgpu/types.GPURenderCommandsMixin.setVertexBuffer].
   *
   * @example pass.setVertexBuffer(0, vbo);
   */
  setVertexBuffer(
    slot: number,
    buffer: Buffer,
    offset?: number | undefined,
    size?: number | undefined,
  ): void;
  /** Set the index buffer.
   *
   * Spec anchor: [@webgpu/types.GPURenderCommandsMixin.setIndexBuffer].
   *
   * @example pass.setIndexBuffer(ibo, 'uint32');
   */
  setIndexBuffer(
    buffer: Buffer,
    format: 'uint16' | 'uint32',
    offset?: number | undefined,
    size?: number | undefined,
  ): void;
  /** Set a bind group with optional dynamic offsets array (overload (a)).
   *
   * Spec anchor: [@webgpu/types.GPUBindingCommandsMixin.setBindGroup].
   *
   * @example pass.setBindGroup(0, bg, [0, 256]);
   */
  setBindGroup(
    index: number,
    bindGroup: BindGroup,
    dynamicOffsets?: readonly number[] | undefined,
  ): void;
  /** Set a bind group with a Uint32Array slice for dynamic offsets (overload (b)).
   *
   * Spec anchor: [@webgpu/types.GPUBindingCommandsMixin.setBindGroup].
   *
   * @example
   *   pass.setBindGroup(0, bg, dynamicOffsetsData, dynamicOffsetsDataStart, dynamicOffsetsDataLength);
   */
  setBindGroup(
    index: number,
    bindGroup: BindGroup,
    dynamicOffsetsData: Uint32Array,
    dynamicOffsetsDataStart: number,
    dynamicOffsetsDataLength: number,
  ): void;
  /** Issue a draw.
   *
   * Spec anchor: [@webgpu/types.GPURenderCommandsMixin.draw].
   *
   * @example pass.draw(3);
   */
  draw(
    vertexCount: number,
    instanceCount?: number | undefined,
    firstVertex?: number | undefined,
    firstInstance?: number | undefined,
  ): void;
  /** Issue an indexed draw.
   *
   * Spec anchor: [@webgpu/types.GPURenderCommandsMixin.drawIndexed].
   *
   * @example pass.drawIndexed(36);
   */
  drawIndexed(
    indexCount: number,
    instanceCount?: number | undefined,
    firstIndex?: number | undefined,
    baseVertex?: number | undefined,
    firstInstance?: number | undefined,
  ): void;
  /** End the render pass.
   *
   * Spec anchor: [@webgpu/types.GPURenderPassEncoder.end].
   *
   * @example pass.end();
   */
  end(): void;

  // ===== 10 new spec stable methods (D-S4) =====
  /** Set the viewport.
   *
   * Spec anchor: [@webgpu/types.GPURenderPassEncoder.setViewport].
   *
   * @example pass.setViewport(0, 0, 800, 600, 0, 1);
   */
  setViewport(x: number, y: number, w: number, h: number, minDepth: number, maxDepth: number): void;
  /** Set the scissor rect.
   *
   * Spec anchor: [@webgpu/types.GPURenderPassEncoder.setScissorRect].
   *
   * @example pass.setScissorRect(0, 0, 800, 600);
   */
  setScissorRect(x: number, y: number, w: number, h: number): void;
  /** Set the blend constant color.
   *
   * Spec anchor: [@webgpu/types.GPURenderPassEncoder.setBlendConstant].
   *
   * @example pass.setBlendConstant({ r: 1, g: 0, b: 0, a: 1 });
   */
  setBlendConstant(color: GPUColor): void;
  /** Set the stencil reference value.
   *
   * Spec anchor: [@webgpu/types.GPURenderPassEncoder.setStencilReference].
   *
   * @example pass.setStencilReference(0xff);
   */
  setStencilReference(reference: number): void;
  /** Issue an indirect draw.
   *
   * Spec anchor: [@webgpu/types.GPURenderCommandsMixin.drawIndirect].
   *
   * @example pass.drawIndirect(indirectBuf, 0);
   */
  drawIndirect(indirectBuffer: Buffer, indirectOffset: number): void;
  /** Issue an indexed indirect draw.
   *
   * Spec anchor: [@webgpu/types.GPURenderCommandsMixin.drawIndexedIndirect].
   *
   * @example pass.drawIndexedIndirect(indirectBuf, 0);
   */
  drawIndexedIndirect(indirectBuffer: Buffer, indirectOffset: number): void;
  /** Push a labelled debug group (GPUDebugCommandsMixin).
   *
   * Spec anchor: [@webgpu/types.GPUDebugCommandsMixin.pushDebugGroup].
   *
   * @note silent delegate to raw GPU encoder on finished encoder; matches W3C spec lenience (the debug-commands mixin permits a no-op pass-through after finish() so the signal stays real instead of forging a `@throws` contract; charter proposition 4).
   * @example pass.pushDebugGroup('lighting');
   */
  pushDebugGroup(groupLabel: string): void;
  /** Pop the most recent debug group (GPUDebugCommandsMixin).
   *
   * Spec anchor: [@webgpu/types.GPUDebugCommandsMixin.popDebugGroup].
   *
   * @note silent delegate to raw GPU encoder on finished encoder; matches W3C spec lenience (see pushDebugGroup JSDoc for the dual-channel rationale).
   * @example pass.popDebugGroup();
   */
  popDebugGroup(): void;
  /** Insert a labelled debug marker (GPUDebugCommandsMixin).
   *
   * Spec anchor: [@webgpu/types.GPUDebugCommandsMixin.insertDebugMarker].
   *
   * @note silent delegate to raw GPU encoder on finished encoder; matches W3C spec lenience (see pushDebugGroup JSDoc for the dual-channel rationale).
   * @example pass.insertDebugMarker('post-shadow');
   */
  insertDebugMarker(markerLabel: string): void;

  /** Execute immutable bundles; pipeline, bind groups and vertex/index state
   * are cleared afterwards, including for an empty iterable (WebGPU semantics).
   */
  executeBundles(bundles: Iterable<RenderBundle>): Result<void, RhiError>;
  /** Begin an occlusion query. Real implementation (M3 / w23): pairs with
   *  `endOcclusionQuery()` against the `RenderPassDescriptor.occlusionQuerySet`
   *  and validates the spec [[occlusion_query_active]] state machine
   *  (queries cannot nest; missing occlusionQuerySet returns
   *  Result.err({ code: 'webgpu-runtime-error' }) with structured
   *  .expected / .hint fields).
   *
   * Spec anchor: [@webgpu/types.GPURenderPassEncoder.beginOcclusionQuery].
   *
   * @example
   *   const out = pass.beginOcclusionQuery(0);
   *   if (!out.ok) { ... route via switch (out.error.code) ... }
   */
  beginOcclusionQuery(queryIndex: number): Result<void, RhiError>;
  /** End an occlusion query. Real implementation (M3 / w23): finalizes the
   *  matching `beginOcclusionQuery(idx)` slot; emits
   *  Result.err({ code: 'render-pass-not-ended', ... }) if no active begin
   *  is pending.
   *
   * Spec anchor: [@webgpu/types.GPURenderPassEncoder.endOcclusionQuery].
   *
   * @example
   *   const out = pass.endOcclusionQuery();
   *   if (!out.ok) { ... route via switch (out.error.code) ... }
   */
  endOcclusionQuery(): Result<void, RhiError>;
}

/** GPU compute pass encoder - records dispatch calls. */
export interface RhiComputePassEncoder {
  setPipeline(pipeline: ComputePipeline): void;
  setBindGroup(
    index: number,
    bindGroup: BindGroup,
    dynamicOffsets?: readonly number[] | undefined,
  ): void;
  dispatchWorkgroups(x: number, y?: number | undefined, z?: number | undefined): void;
  /** Dispatch dimensions read from three consecutive u32 values in an indirect buffer. */
  dispatchWorkgroupsIndirect(indirectBuffer: Buffer, indirectOffset: number): void;
  end(): void;
}

/** GPU render pipeline operations - returned by RhiDevice.createRenderPipeline. */
export interface RhiRenderPipelineOps {
  /** Get bind group layout (used for dynamic bind-group creation). */
  getBindGroupLayout(index: number): BindGroupLayout;
}

/** GPU compute pipeline operations. */
export interface RhiComputePipelineOps {
  /** Get bind group layout. */
  getBindGroupLayout(index: number): BindGroupLayout;
}

// ============================================================================
// re-export errors (charter proposition 1: single entry shows the full surface)
// ============================================================================

export {
  type CreateUnavailableR32FloatReceiptOptions,
  createUnavailableR32FloatReceipt,
  R32FLOAT_MIP_SAMPLED_STORAGE_PROFILE,
  R32FLOAT_PROBE_STAGES,
  type RhiTextureFormatCapabilityReceipt,
  type RhiTextureFormatProbeEvidence,
  type RhiTextureFormatProbeStage,
  type RhiTextureFormatProbeStageReceipt,
  type RhiTextureFormatProbeVerdict,
  type RhiTextureFormatReadback,
  validateR32FloatReceipt,
} from './capability/texture-format';
export type {
  DrawOwnerSplit,
  LimitExceededDetail,
  Result,
  ResultErr,
  ResultOk,
  RhiAssetNotRegisteredDetail,
  RhiErrorCode,
  RhiErrorDetail,
  RhiOwnerOutOfRangeDetail,
  RhiShaderCompileDetail,
  RhiWebgpuRuntimeCause,
  RhiWebgpuRuntimeDetail,
} from './errors.js';
export {
  commandEncoderFinished,
  err,
  limitExceeded,
  ok,
  queueSubmitFailed,
  queueWriteBufferOutOfBounds,
  RhiError,
  renderPassNotEnded,
  shaderCompileFailed,
  validateDrawArgs,
} from './errors.js';
export {
  type AccelerationStructureBindingLayout,
  type AccelerationStructureBuildPreference,
  type AccelerationStructureUpdateMode,
  BLAS_INPUT_BUFFER_USAGE,
  type Blas,
  type BlasBuildEntry,
  type BlasDescriptor,
  type BlasTriangleGeometry,
  type BlasTriangleGeometrySize,
  type BlasVertexFormat,
  deriveRayQueryCaps,
  RAY_QUERY_BACKEND_UNSUPPORTED,
  RAY_QUERY_FEATURE,
  RAY_QUERY_WGSL_ENABLE,
  type RhiRayQueryCaps,
  type RhiRayQueryLimits,
  type RhiRayQueryUnsupportedReason,
  rayQueryUnsupported,
  type Tlas,
  type TlasBuildEntry,
  type TlasDescriptor,
  type TlasInstance,
  validateBlasBuild,
  validateBlasDescriptor,
  validateRayQueryBindGroupLayout,
  validateRayQueryBufferUsage,
  validateRayQueryShader,
  validateTlasBuild,
  validateTlasDescriptor,
  wgslEnablesRayQuery,
} from './ray-query';

// re-export common descriptor-related aliases for single-entry consumption.
export type { AddressMode, CompareFunction, FilterMode, TextureFormat };

// ============================================================================
// Descriptor builder helpers (feat-20260612-point-light-shadows-urp-hdrp M0)
// ============================================================================
//
// Pure functions that assemble descriptor objects for cube_array depth
// textures, comparison samplers, and cube-face texture views. These are
// zero-side-effect descriptor factories — the caller passes the returned
// descriptor to `device.createTexture(desc)` etc. Separating descriptor
// assembly from GPU calls keeps tests concise and prevents copy-paste of
// dimension/format/usage boilerplate across dawn + browser fixtures.

/**
 * Build a TextureDescriptor for a cube-array depth texture suitable for
 * point-light shadow atlas (texture_depth_cube_array).
 *
 * Usage: `device.createTexture(cubeArrayDepthDescriptor(512, 4))`
 *
 * @param faceSize - width and height of each cube face in pixels (default 512)
 * @param layers - number of cube layers (= max shadow-casting point lights, default 4)
 * @param usage - texture usage flags (default RENDER_ATTACHMENT | TEXTURE_BINDING)
 */
export function cubeArrayDepthDescriptor(
  faceSize: number = 512,
  layers: number = 4,
  usage: number = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
): TextureDescriptor {
  return {
    size: { width: faceSize, height: faceSize, depthOrArrayLayers: 6 * layers },
    format: 'depth32float',
    dimension: '2d',
    usage,
  };
}

/**
 * Build a SamplerDescriptor for a depth-comparison sampler used with
 * texture_depth_2d or texture_depth_cube_array.
 *
 * The returned descriptor uses clamp-to-edge addressing, linear filtering
 * (required for comparison sampling on some backends), and `compare: 'less'`.
 *
 * Usage: `device.createSampler(comparisonSamplerDescriptor())`
 */
export function comparisonSamplerDescriptor(): SamplerDescriptor {
  return {
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
    compare: 'less',
  };
}

/**
 * Build a TextureViewDescriptor to view a single cube layer + face as a 2D
 * depth attachment during shadow-caster rendering.
 *
 * Each shadow-caster pass renders to one face of one cube layer. This helper
 * produces the view descriptor that selects `baseArrayLayer = layerIndex * 6 + faceIndex`
 * with `arrayLayerCount = 1` and `dimension = '2d'`, which satisfies WebGPU's
 * requirement that render pass attachments are 2D views (cube views cannot be
 * bound as render targets).
 *
 * Usage:
 * ```
 * const viewDesc = cubeArrayDepthFaceView(lightIndex, faceIndex);
 * const view = device.createTextureView(atlas, viewDesc).unwrap();
 * ```
 *
 * @param layerIndex - 0-based shadow-casting light index (0..3)
 * @param faceIndex - 0-based cube face index (0..5, +X/-X/+Y/-Y/+Z/-Z per §5.3)
 */
export function cubeArrayDepthFaceView(
  layerIndex: number,
  faceIndex: number,
): TextureViewDescriptor {
  return {
    format: 'depth32float',
    dimension: '2d',
    aspect: 'depth-only',
    baseArrayLayer: layerIndex * 6 + faceIndex,
    arrayLayerCount: 1,
    baseMipLevel: 0,
    mipLevelCount: 1,
  };
}

export { projectAdapterCapabilities } from './adapter-capabilities';
export { PIPELINE_LIBRARY_LIMITS } from './pipeline-library';
export {
  checkPipelineLibraryAllocation,
  pipelineLibraryLimit,
  pipelineLibraryLimits,
} from './pipeline-library-limits';
export { ownPipelineLibrary } from './pipeline-library-source';
export { PipelineRecipeState, pipelineDescriptorState } from './pipeline-recipe-state';
export { createQueueCompletionHold, type QueueCompletionHold } from './queue-completion-hold';
export { textureCopyOrigin, textureReadbackLayout } from './texture-copy-layout';
