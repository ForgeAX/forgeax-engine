import { isStripTopology } from '@forgeax/engine-types';
import { pipelineVertexConstants } from './material-stage-constants';
// PipelineSpec 4-axis SSOT — single-file type + derive-fn + entrypoint + error model.
//
// feat-20260615-pipeline-spec-ssot M1: Establish PipelineSpec 4-axis type SSOT.
// M1-T1: type definitions + KNOWN_PASS_KINDS + PipelineSpecError closed union.
// M1-T2: 6 pure derive functions.
// M1-T3: deriveBglShapeFromShader helper.
// M1-T4: getOrBuildPipeline entrypoint + PipelineCache.
// M1-T5: 12 SPEC_CONST boot-time table.
//
// Design axiom: PipelineSpec is business-agnostic — no 'pbr' / 'sprite' / 'skybox'
// / 'fullscreen-*' strings appear on the type surface (plan-strategy D-7).
// BGL shape taxonomy lives in the ShaderCatalog implementation, not in spec.
//
// Charter alignment:
//   F1: single file entrypoint (getOrBuildPipeline) — AI user indexes once
//   P1: progressive disclosure — types at top, fns mid, error model bottom
//   P3: explicit failure — closed PipelineSpecError union, no silent routes
//   P4: consistent abstraction — 4-axis aligns with wgpu/Bevy/Three.js

import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexBufferLayout,
  deriveVertexBufferLayoutFromProjection,
  deriveVertexLayoutProjection,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import {
  err,
  KNOWN_PASS_KINDS,
  type MaterialRenderState,
  ok,
  type PrimitiveTopology,
  type Result,
} from '@forgeax/engine-types';
import { VertexColorVariantConflictError } from './errors/render';
import { materialColorTarget, materialDepthStencil } from './material-render-state';

export {
  type BglKind,
  type BindGroupLayoutDescriptorOutput,
  buildBindGroupLayoutDescriptor,
  createHdrpBindGroupLayoutDescriptor,
} from './pbr-pipeline';

// Re-export KNOWN_PASS_KINDS from @forgeax/engine-types for single-file discoverability (charter F1).
export { KNOWN_PASS_KINDS };

/**
 * The engine-owned deferred material target layout. `fs_gbuffer` returns
 * SceneColor (emissive/opacity), then packed normal/roughness, F0/AO,
 * albedo/metallic, lighting context, and receiver geometry/channels. Surface data costs 24 bytes/pixel.
 */
import { DEFERRED_COLOR_FORMATS } from './standard-attachments';

export { DEFERRED_COLOR_FORMATS } from './standard-attachments';

/** Derive the color attachment shape for a material pass kind. */
export function colorFormatsForPassKind(
  passKind: string,
  defaultColorFormat: GPUTextureFormat,
): readonly GPUTextureFormat[] {
  if (passKindPolicyTable[passKind]?.shape === 'depth-only') return [];
  if (passKind === 'deferred') return DEFERRED_COLOR_FORMATS;
  return [defaultColorFormat];
}

// ══════════════════════════════════════════════════════════════════════════════
// PipelineSpec — immutable 4-axis data description (D-7: business-agnostic)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Pipeline specification — immutable 4-axis data that completely determines
 * what `device.createRenderPipeline(...)` does for a material shader pass.
 *
 * The 4 axes are:
 * - `shader`: which WGSL source + material param schema + pass kind + variant set
 * - `attachments`: color/depth/stencil formats + sample count (MSAA)
 * - `geometry`: primitive topology + vertex attribute layout + index format
 * - `renderState`: optional per-material render-state overrides (blend/cull/depth/stencil)
 *
 * Business-agnostic: no `'pbr'` / `'sprite'` / `'skybox'` strings pollute this
 * type. BGL shape taxonomy is derived from `ShaderCatalog` internal reflection
 * and never appears on the spec surface (plan-strategy D-7).
 *
 * @see plan-strategy §1 (4-axis) · D-7 (business-agnostic) · requirements §3.1
 */
export type { PipelineSpec } from './pipeline-spec-types';

import type { PipelineSpec } from './pipeline-spec-types';
// ══════════════════════════════════════════════════════════════════════════════
// PipelineSpecError — closed union (5 + 2 transit codes)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Closed union of PipelineSpec error codes.
 *
 * 5 business codes:
 * - `'spec-inconsistent'`: axis mutual exclusion violated
 * - `'unknown-pass-kind'`: passKind not in KNOWN_PASS_KINDS or registered
 * - `'shader-bgl-reflection-mismatch'`: reflected BGL shape != shader declaration
 * - `'attachment-format-incompatible'`: depth/stencil format vs PSO mismatch
 * - `'unsupported-vertex-layout'`: vertex attributes don't match shader vs_main
 *
 * 2 transit codes:
 * - `'pipeline-build-failed'`: wraps RhiError from device.createRenderPipeline
 * - `'shader-not-registered'`: ShaderCatalog lookup returned undefined
 *
 * @see requirements §3.4 · AC-10 · charter P3
 */
export type PipelineSpecErrorCode =
  | 'spec-inconsistent'
  | 'unknown-pass-kind'
  | 'shader-bgl-reflection-mismatch'
  | 'attachment-format-incompatible'
  | 'unsupported-vertex-layout'
  | 'pipeline-build-failed'
  | 'shader-not-registered';

/**
 * Structured pipeline-spec error — carries `.code` (discriminated union) +
 * `.detail` (narrowed per code) + `.hint` (AI-user actionable prose).
 *
 * Inherits from `Error` so it integrates with existing catch blocks; the
 * `.code` field enables exhaustive `switch` narrowing without string parsing
 * (charter P3).
 */
export class PipelineSpecError extends Error {
  readonly code: PipelineSpecErrorCode;
  /**
   * Narrowed detail payload — shape depends on `code`.
   *
   * - `'spec-inconsistent'`: `{ reason: string }`
   * - `'unknown-pass-kind'`: `{ expected: readonly string[]; actual: string; hint?: string }`
   * - `'shader-bgl-reflection-mismatch'`: `{ reflected: unknown; declared: unknown }`
   * - `'attachment-format-incompatible'`: `{ reason: string; expected?: string; actual?: string }`
   * - `'unsupported-vertex-layout'`: `{ specAttrs: string[]; shaderAttrs: string[] }`
   * - `'pipeline-build-failed'`: `{ gpuMessage?: string; cause?: unknown }`
   * - `'shader-not-registered'`: `{ shaderId: string; hint?: string }`
   */
  readonly detail: Record<string, unknown>;

  constructor(args: {
    code: PipelineSpecErrorCode;
    detail: Record<string, unknown>;
    hint?: string;
  }) {
    super(
      args.hint !== undefined
        ? `PipelineSpecError [${args.code}]: ${args.hint}`
        : `PipelineSpecError [${args.code}]`,
    );
    this.name = 'PipelineSpecError';
    this.code = args.code;
    this.detail = args.detail;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// renderStateHashSuffix — deterministic hash of MaterialRenderState
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Material snapshots hand the renderer immutable render-state objects. Keep
 * the serialized suffix by object identity just like the vertex-layout
 * digest below; the hot path otherwise sorts keys and serializes the same
 * state once per renderable. Callers must not mutate a MaterialRenderState
 * after passing it to the renderer (the PipelineSpec contract is immutable).
 */
const RENDER_STATE_HASH_CACHE = new WeakMap<object, string>();

/**
 * Deterministic hash suffix for MaterialRenderState (sorted keys, JSON.stringify).
 *
 * Returns `''` when `renderState` is `undefined` or has zero entries,
 * preserving cache-key byte-compatibility with the pre-M1 shape.
 */
export function renderStateHash(renderState: MaterialRenderState | undefined): string {
  if (renderState === undefined) return '';
  const cached = RENDER_STATE_HASH_CACHE.get(renderState);
  if (cached !== undefined) return cached;
  const sorted = Object.keys(renderState).sort();
  if (sorted.length === 0) {
    RENDER_STATE_HASH_CACHE.set(renderState, '');
    return '';
  }
  const payload: Record<string, unknown> = {};
  for (const k of sorted) {
    const v = renderState[k as keyof MaterialRenderState];
    if (v !== undefined) payload[k] = v;
  }
  const result = `:${JSON.stringify(payload)}`;
  RENDER_STATE_HASH_CACHE.set(renderState, result);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 6 pure derive functions (M1-T2)
// ══════════════════════════════════════════════════════════════════════════════

function constantsKey(
  stage: 'constants' | 'vertex-constants',
  values: Readonly<Record<string, number>> | undefined,
): string {
  return values === undefined
    ? ''
    : `:${stage}:${JSON.stringify(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)))}`;
}

/**
 * Compute a deterministic cache key from a PipelineSpec.
 *
 * The key covers all 4 axes + BGL shape hash (derived from ShaderCatalog
 * reflection via {@link deriveBglShapeFromShader}). Two specs that produce
 * the same cache key MUST produce byte-identical PSO descriptors.
 *
 * Algorithm: concatenate each axis segment with `:` separators, hash the
 * BGL shape for compactness, and emit a single cache-key string.
 *
 * @see plan-strategy §3.1 · requirements AC-02
 */
export function cacheKeyOf(spec: PipelineSpec): string {
  const { shader, attachments, geometry, renderState } = spec;
  const topoSegment = geometry.topology;
  const stripSegment =
    isStripTopology(topoSegment) && geometry.stripIndexFormat !== undefined
      ? `:${geometry.stripIndexFormat}`
      : '';

  // The geometry owner publishes one immutable projection. Legacy callers may
  // still provide only the map; derive the same projection at this boundary.
  const vlDigest =
    geometry.vertexLayoutProjection?.digest ??
    deriveVertexLayoutProjection(geometry.vertexLayout).digest;

  const uvSetCountSegment =
    geometry.shaderUvSetCount !== undefined ? `:uvsc${geometry.shaderUvSetCount}` : '';
  // Prepared graphics may publish an explicit multi-stream layout (particle
  // material-input lanes are the canonical example). The attribute map alone
  // cannot describe those streams or their lane stride, so include the
  // normalized descriptors in the cache identity as well.
  const vertexBuffersSegment =
    geometry.vertexBuffers === undefined
      ? ''
      : `:vbs:${JSON.stringify(
          geometry.vertexBuffers.map((buffer) => ({
            arrayStride: buffer.arrayStride,
            stepMode: buffer.stepMode ?? 'vertex',
            attributes: [...buffer.attributes].map((attribute) => ({
              shaderLocation: attribute.shaderLocation,
              offset: attribute.offset,
              format: attribute.format,
            })),
          })),
        )}`;

  // bug-20260708 M2 (b): sentinel `~` distinguishes `variantSet=undefined`
  // (no-variant / default-variant request) from canonical all-true key `''`
  // (all variant axes true). Prior `?? ''` collapsed the two into the same
  // cache key, causing the first-cached pipeline to win and unrelated
  // variantSet requests to reuse its shader module (research R-11 / R-12).
  // `~` (ASCII 0x7E) is a reserved sentinel char — no legitimate
  // variantSet literal contains it; guarded by
  // `pipeline-cache-keying.unit.test.ts` sentinel-conflict assertions.
  const variantSegment = shader.variantSet === undefined ? '~' : shader.variantSet;
  return (
    [
      shader.id,
      shader.passKind,
      variantSegment,
      attachments.colorFormats.join(','),
      attachments.depthFormat ?? '',
      String(attachments.sampleCount),
      topoSegment,
      stripSegment,
      `vl:${vlDigest}`,
      renderStateHash(renderState),
    ].join(':') +
    vertexBuffersSegment +
    uvSetCountSegment +
    constantsKey('constants', shader.constants) +
    constantsKey('vertex-constants', shader.vertexConstants) +
    (shader.vertexEntry === undefined && shader.fragmentEntry === undefined
      ? ''
      : `:entries:${JSON.stringify([shader.vertexEntry ?? null, shader.fragmentEntry ?? null])}`)
  );
}

/**
 * Reconcile the authored vertex-color shader axis with the geometry-owned
 * projection. COLOR_0 is a geometry fact and cannot be selected independently
 * by a material variant.
 */
export function variantSetFromVertexLayoutProjection(
  projection: VertexLayoutProjection,
  authoredVariantSet: string | undefined,
): Result<string, VertexColorVariantConflictError> {
  const projected = projection.attributes.some((attribute) => attribute.key === 'color');
  const axis = `VERTEX_COLOR_AVAILABLE=${projected ? 'true' : 'false'}`;
  if (authoredVariantSet === undefined) return ok(axis);
  if (projected && authoredVariantSet === '') return ok(authoredVariantSet);

  const authoredParts = authoredVariantSet.split('+');
  const authoredColorPart = authoredParts.find((part) =>
    part.startsWith('VERTEX_COLOR_AVAILABLE='),
  );
  if (authoredColorPart === undefined) {
    const parts = authoredParts.filter((part) => part.length > 0);
    parts.push(axis);
    return ok(parts.join('+'));
  }

  const authoredValue = authoredColorPart.slice('VERTEX_COLOR_AVAILABLE='.length);
  const authored = authoredValue === 'true';
  if ((authoredValue !== 'true' && authoredValue !== 'false') || authored !== projected) {
    return err(new VertexColorVariantConflictError(authoredValue, projected));
  }
  const parts = authoredParts.filter(
    (part) => part.length > 0 && !part.startsWith('VERTEX_COLOR_AVAILABLE='),
  );
  parts.push(axis);
  return ok(parts.join('+'));
}

/** Explicit geometry and lighting facts survive composition before manifest key canonicalization. */
export function standardCapabilityVariantSet(
  clustered: boolean,
  storageBuffer: boolean,
  vertexColorAvailable: boolean,
): string {
  return `CLUSTER_FORWARD_AVAILABLE=${clustered}+STORAGE_BUFFER_AVAILABLE=${storageBuffer}+VERTEX_COLOR_AVAILABLE=${vertexColorAvailable}`;
}

/**
 * Project the frame-owned Standard topology onto its material variant axes.
 *
 * `StandardTopologyInputValue.kind` is the only runtime authority for the
 * cluster axis: a frame with local lights must request the clustered artifact,
 * while the no-local-light topology requests the direct artifact.  Keeping
 * this projection beside the canonical key builder prevents PBR, skin, and
 * sprite-lit record owners from independently inferring the active lane from
 * whichever bind group happened to be constructed first.
 */
export function standardTopologyVariantSet(
  topology: { readonly kind: 'no-local-lights' | 'clustered' } | undefined,
  storageBuffer: boolean,
  vertexColorAvailable: boolean,
  probeBlendAvailable = false,
): string {
  const capabilityVariantSet = standardCapabilityVariantSet(
    topology?.kind === 'clustered',
    storageBuffer,
    vertexColorAvailable,
  );
  if (!probeBlendAvailable || !storageBuffer) return capabilityVariantSet;
  return `${capabilityVariantSet}+PROBE_BLEND_AVAILABLE=true`;
}

/**
 * Keep a clustered frame fail-closed when its unified group(2) resource is
 * unavailable. A missing group is not evidence that the frame is direct; it
 * is an invalid prepared resource state.
 */
export function standardTopologyBindGroupReady(
  topology: { readonly kind: 'no-local-lights' | 'clustered' } | undefined,
  clusterBindGroup: unknown,
): boolean {
  return (
    topology?.kind !== 'clustered' || (clusterBindGroup !== null && clusterBindGroup !== undefined)
  );
}

/** Derive the storage axis for Standard-compatible unlit material draws. */
export function standardStorageVariantSet(
  storageBuffer: boolean,
  vertexColorAvailable: boolean,
): string {
  if (storageBuffer && vertexColorAvailable) return '';
  return `STORAGE_BUFFER_AVAILABLE=${storageBuffer}+VERTEX_COLOR_AVAILABLE=${vertexColorAvailable}`;
}

/**
 * Build a `GPURenderPipelineDescriptor` from a PipelineSpec + shader modules.
 *
 * Pure derivation: same (spec, modules) always produces the same descriptor.
 * Consumed by `getOrBuildPipeline` on cache miss; also available as a public
 * helper for AI users who want the descriptor shape without going through the
 * cache entrypoint.
 *
 * @param spec - the pipeline spec (4 axes)
 * @param modules - `{ vertex: GPUShaderModule; fragment: GPUShaderModule }`
 * @returns a complete WebGPU render-pipeline descriptor
 * @see plan-strategy §3.2 · requirements AC-02
 */
export function buildPipelineDescriptor(
  spec: PipelineSpec,
  modules: {
    vertex: unknown;
    fragment: unknown;
    vertexEntryPoint?: string;
    fragmentEntryPoint?: string;
    layout?: unknown;
  },
): Record<string, unknown> {
  // M2-T4: derive vertex buffers from spec.geometry.vertexLayout via
  // deriveVertexBufferLayout (imported from vertex-attribute-layout.ts).
  // Empty vertexLayout (fullscreen-post passes) → [].
  // Non-empty (material shaders) → interleaved single-buffer layout.
  //
  // Entry points default to 'vs_main' / 'fs_main' for the 3 standard material
  // shaders; fullscreen-post passes (skybox 'skybox_fs', SSAO 'vs_ssao' / 'fs_ssao_calc')
  // pass custom entry points through the modules parameter.
  //
  // The optional `layout` field, when present, is forwarded to the descriptor
  // so that the provider can detect it is already set and avoid overwriting.

  const { attachments, geometry, renderState } = spec;

  // A supplied projection is the geometry owner's immutable GPU descriptor.
  // Do not re-derive it from a possibly stale attribute map.
  const vertexBuffers =
    geometry.vertexBuffers ??
    (geometry.vertexLayoutProjection === undefined
      ? deriveVertexBufferLayout(geometry.vertexLayout, {
          ...(geometry.shaderUvSetCount !== undefined
            ? { shaderUvSetCount: geometry.shaderUvSetCount }
            : {}),
        })
      : deriveVertexBufferLayoutFromProjection(geometry.vertexLayoutProjection, {
          ...(geometry.shaderUvSetCount !== undefined
            ? { shaderUvSetCount: geometry.shaderUvSetCount }
            : {}),
        }));

  const vertexConstants = pipelineVertexConstants(spec.shader);
  const descriptor: Record<string, unknown> = {
    vertex: {
      module: modules.vertex,
      entryPoint: spec.shader.vertexEntry ?? modules.vertexEntryPoint ?? 'vs_main',
      buffers: vertexBuffers,
      ...(vertexConstants === undefined ? {} : { constants: vertexConstants }),
    },
  };

  // Fragment stage: absent for shadow-caster (depth-only), present for forward.
  if (attachments.colorFormats.length > 0) {
    descriptor.fragment = {
      module: modules.fragment,
      entryPoint: spec.shader.fragmentEntry ?? modules.fragmentEntryPoint ?? 'fs_main',
      ...(spec.shader.constants === undefined ? {} : { constants: spec.shader.constants }),
      targets: attachments.colorFormats.map((format, index) =>
        materialColorTarget(format, renderState, index),
      ),
    };
  }

  // Layout: forward if provided by caller (fullscreen-post passes set it).
  if (modules.layout !== undefined) {
    descriptor.layout = modules.layout;
  }

  // Primitive state.
  const primitive: Record<string, unknown> = {
    topology: geometry.topology,
    cullMode: renderState?.cullMode ?? 'back',
    frontFace: renderState?.frontFace ?? 'ccw',
  };
  if (geometry.topology.endsWith('strip') && geometry.stripIndexFormat !== undefined) {
    primitive.stripIndexFormat = geometry.stripIndexFormat;
  }
  descriptor.primitive = primitive;

  // Depth-stencil state.
  if (attachments.depthFormat !== undefined) {
    descriptor.depthStencil = materialDepthStencil(attachments.depthFormat, renderState);
  }

  // Multisample: absent for sampleCount=1 (undefined). For each value > 1,
  // emit { count: sampleCount } so forward-compat sample counts (2, 8, …)
  // flow through to the descriptor without requiring a type change.
  if (attachments.sampleCount > 1) {
    descriptor.multisample = {
      count: attachments.sampleCount,
      ...(renderState?.alphaToCoverageEnabled === true && { alphaToCoverageEnabled: true }),
    };
  }

  return descriptor;
}

// ══════════════════════════════════════════════════════════════════════════════
// passKindPolicyTable — closed map: passKind → attachment shape + default ops
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Default colour-attachment ops carried by a passKind policy.
 *
 * `clearValue` is `undefined` for `loadOp='load'` policies (no clear value
 * is emitted into the descriptor when the prior contents are loaded).
 */
interface AttachmentColorOps {
  readonly loadOp: 'clear' | 'load';
  readonly storeOp: 'store' | 'discard';
  readonly clearValue: GPUColor | undefined;
}

/**
 * Default depth-attachment ops carried by a passKind policy.
 *
 * `stencilLoadOp` / `stencilStoreOp` are absent on the policy itself — the
 * stencil-op gate is auto-derived from `specAttachments.depthFormat` at call
 * time (`'depth32float-stencil8'` → `'clear'+'discard'`; everything else
 * elides stencil ops). This collapses the R3/R5 stencil-op duplicates that
 * previously lived inline at every forward-pass beginRenderPass call site.
 */
interface AttachmentDepthOps {
  readonly loadOp: 'clear' | 'load';
  readonly storeOp: 'store' | 'discard';
  readonly clearValue: number;
}

/**
 * Attachment policy for a single passKind — declares the colour / depth shape
 * the pass produces and the default load/store ops. Per-call-site overrides
 * (for example the skybox `colorLoadOp`) flow through the `options` parameter
 * of {@link buildBeginRenderPassDescriptor}.
 *
 * `shape` discriminator drives which attachment slots the descriptor emits:
 * - `'depth-only'` → empty `colorAttachments[]`, `depthStencilAttachment` set
 * - `'color-only'` → populated `colorAttachments[]`, no `depthStencilAttachment`
 * - `'color-and-depth'` → both
 */
interface PassKindAttachmentPolicy {
  readonly shape: 'depth-only' | 'color-only' | 'color-and-depth';
  readonly defaultColorOps: AttachmentColorOps | undefined;
  readonly defaultDepthOps: AttachmentDepthOps | undefined;
}

const OPAQUE_BLACK: GPUColor = { r: 0, g: 0, b: 0, a: 1 };
/** Reverse-Z depth: every depth-writing passKind clears to the far plane (0). */
const REVERSE_Z_DEPTH_OPS: AttachmentDepthOps = {
  loadOp: 'clear',
  storeOp: 'store',
  clearValue: 0,
};
/** Fullscreen color-only passKinds overwrite their target: clear/store opaque black. */
const FULLSCREEN_COLOR_POLICY: PassKindAttachmentPolicy = {
  shape: 'color-only',
  defaultColorOps: { loadOp: 'clear', storeOp: 'store', clearValue: OPAQUE_BLACK },
  defaultDepthOps: undefined,
};
const DEPTH_ONLY_POLICY: PassKindAttachmentPolicy = {
  shape: 'depth-only',
  defaultColorOps: undefined,
  defaultDepthOps: REVERSE_Z_DEPTH_OPS,
};

/**
 * Closed map of passKind → attachment policy. Covers the 10 attachment shapes
 * the runtime ships (per plan-strategy M4):
 *
 * 1. `'forward'` — main geometry pass: color+depth(+stencil-gated)
 * 2. `'deferred'` — HDRP G-Buffer geometry pass: MRT color+depth
 * 3. `'shadow-caster'` — directional shadow caster: depth-only
 * 4. `'point-shadow-caster'` — HDRP point-shadow caster: depth-only
 * 5. `'skybox'` — fullscreen skybox: color-only clear/store
 * 6. `'tonemap'` — HDR→LDR tonemap fullscreen: color-only clear/store
 * 7. `'bloom-horizontal'` / `'bloom-vertical'` — multiscale Bloom pyramid:
 *    color-only clear/store
 * 8. `'bloom-composite'` — bloom add-back: color-only load/store (NOT clear)
 * 9. `'fxaa'` — fullscreen FXAA: color-only clear/store
 * 10. `'post-process'` — generic fullscreen primitive (SSAO, render-graph
 *    fullscreen-post-process-pass dispatcher, M2 tonemap pre-warm slot):
 *    color-only clear/store
 *
 * Stencil-op gate is NOT in this table — it is derived from
 * `specAttachments.depthFormat` inside the helper (depth32float-stencil8
 * → emit `stencilLoadOp:'clear' / stencilStoreOp:'discard'`).
 */
export const passKindPolicyTable: Readonly<Record<string, PassKindAttachmentPolicy>> = {
  forward: {
    shape: 'color-and-depth',
    defaultColorOps: { loadOp: 'clear', storeOp: 'store', clearValue: OPAQUE_BLACK },
    defaultDepthOps: REVERSE_Z_DEPTH_OPS,
  },
  deferred: {
    shape: 'color-and-depth',
    defaultColorOps: { loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
    defaultDepthOps: REVERSE_Z_DEPTH_OPS,
  },
  temporal: {
    shape: 'color-and-depth',
    defaultColorOps: { loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: -1, a: 1 } },
    defaultDepthOps: REVERSE_Z_DEPTH_OPS,
  },
  'shadow-caster': DEPTH_ONLY_POLICY,
  'point-shadow-caster': DEPTH_ONLY_POLICY,
  skybox: FULLSCREEN_COLOR_POLICY,
  tonemap: FULLSCREEN_COLOR_POLICY,
  'bloom-horizontal': FULLSCREEN_COLOR_POLICY,
  'bloom-vertical': FULLSCREEN_COLOR_POLICY,
  'bloom-composite': {
    shape: 'color-only',
    defaultColorOps: { loadOp: 'load', storeOp: 'store', clearValue: OPAQUE_BLACK },
    defaultDepthOps: undefined,
  },
  fxaa: FULLSCREEN_COLOR_POLICY,
  'post-process': FULLSCREEN_COLOR_POLICY,
};

/**
 * Build a `GPURenderPassDescriptor` from spec attachments + resolved views +
 * a passKind policy lookup.
 *
 * The helper is the single SSOT for `device.beginRenderPass(...)` descriptor
 * shape — every record-stage call site routes through it (plan-strategy M4
 * AC-06). It dispatches on `passKindPolicyTable[passKind]` to pick the
 * attachment shape (depth-only / color-only / color-and-depth) and applies
 * default color/depth load+store ops; per-call overrides (for example the
 * skybox's specific clearColor) flow through `options`. The main forward pass
 * and its sprite split are begun by the render graph, not by this helper.
 *
 * Stencil-op gate is auto-derived from `specAttachments.depthFormat`:
 * - `'depth32float-stencil8'` → emits `stencilLoadOp:'clear', stencilStoreOp:'discard'`
 * - every other depth format → omits stencil ops entirely
 *
 * This collapses the R3/R5 stencil-op duplicates that previously lived inline
 * at every forward-pass beginRenderPass site.
 *
 * @param specAttachments - the attachments axis from a PipelineSpec
 * @param viewBindings - resolved texture views: `{ colorViews, depthView?, resolveTargets? }`
 * @param passKind - one of the keys in {@link passKindPolicyTable}
 * @param options - per-call ops overrides (loadOp / clearValue / label)
 * @returns a WebGPU render-pass descriptor
 * @throws PipelineSpecError(`'unknown-pass-kind'`) when passKind is not registered
 * @see plan-strategy M4 · requirements AC-06
 */
export function buildBeginRenderPassDescriptor(
  specAttachments: PipelineSpec['attachments'],
  viewBindings: {
    readonly colorViews: readonly unknown[];
    readonly resolveTargets?: readonly (unknown | undefined)[];
    readonly depthView?: unknown;
  },
  passKind: string,
  options?: {
    readonly colorLoadOp?: 'clear' | 'load';
    readonly colorStoreOp?: 'store' | 'discard';
    readonly clearColor?: GPUColor;
    readonly depthLoadOp?: 'clear' | 'load';
    readonly depthStoreOp?: 'store' | 'discard';
    readonly label?: string;
  },
): Record<string, unknown> {
  const policy = passKindPolicyTable[passKind];
  if (policy === undefined) {
    throw new PipelineSpecError({
      code: 'unknown-pass-kind',
      detail: { expected: Object.keys(passKindPolicyTable), actual: passKind },
      hint: `passKind '${passKind}' is not in passKindPolicyTable; register an attachment policy or pick an existing one (e.g. 'post-process' for fullscreen-quad passes)`,
    });
  }

  const out: Record<string, unknown> = {};
  if (options?.label !== undefined) {
    out.label = options.label;
  }

  // Colour attachments: depth-only → empty array; otherwise iterate colorViews
  // and apply policy default ops + per-call overrides. resolveTargets[i] === undefined
  // means "no resolve for this slot"; only present slots emit a `resolveTarget`.
  if (policy.shape === 'depth-only') {
    out.colorAttachments = [];
  } else {
    const colorOps = policy.defaultColorOps;
    if (colorOps === undefined) {
      throw new PipelineSpecError({
        code: 'spec-inconsistent',
        detail: {
          reason: 'policy-shape-color-without-colorOps',
          actual: passKind,
        },
        hint: `passKind '${passKind}' has shape='${policy.shape}' but no defaultColorOps; fix passKindPolicyTable entry`,
      });
    }
    const loadOp = options?.colorLoadOp ?? colorOps.loadOp;
    const storeOp = options?.colorStoreOp ?? colorOps.storeOp;
    const clearValue = options?.clearColor ?? colorOps.clearValue;

    out.colorAttachments = viewBindings.colorViews.map((view, i) => {
      const slot: Record<string, unknown> = {
        view,
        loadOp,
        storeOp,
      };
      const resolveTarget = viewBindings.resolveTargets?.[i];
      if (resolveTarget !== undefined) {
        slot.resolveTarget = resolveTarget;
      }
      // Emit clearValue only when load is 'clear' AND a value is available.
      if (loadOp === 'clear' && clearValue !== undefined) {
        slot.clearValue = clearValue;
      }
      return slot;
    });
  }

  // Depth-stencil attachment: emitted iff policy declares depth ops AND
  // the spec carries a depthFormat. Stencil ops auto-derived from format.
  if (policy.shape !== 'color-only' && policy.defaultDepthOps !== undefined) {
    const dOps = policy.defaultDepthOps;
    const depthLoadOp = options?.depthLoadOp ?? dOps.loadOp;
    const depthStoreOp = options?.depthStoreOp ?? dOps.storeOp;
    const ds: Record<string, unknown> = {
      view: viewBindings.depthView,
      depthLoadOp,
      depthStoreOp,
    };
    if (depthLoadOp === 'clear') {
      ds.depthClearValue = dOps.clearValue;
    }
    // Stencil formats require explicit stencil operations.
    if (
      specAttachments.depthFormat === 'depth32float-stencil8' ||
      specAttachments.depthFormat === 'depth24plus-stencil8'
    ) {
      ds.stencilClearValue = 0;
      ds.stencilLoadOp = 'clear';
      ds.stencilStoreOp = 'discard';
    }
    out.depthStencilAttachment = ds;
  }

  return out;
}

/**
 * Validate a PipelineSpec before attempting to build.
 *
 * Fail-fast checks (charter P5) covering axis mutual-exclusion rules.
 * Returns `Result<void, PipelineSpecError>` — ok for valid specs,
 * err with structured code + detail for invalid ones.
 *
 * Checks:
 * 1. `sampleCount=4` with empty `colorFormats` → `'spec-inconsistent'`
 * 2. Pass kind not in `KNOWN_PASS_KINDS` → `'unknown-pass-kind'`
 * 3. `depthFormat` undefined but `renderState` implies depth testing →
 *    `'attachment-format-incompatible'`
 *
 * @see plan-strategy §3.2 · requirements AC-02 · charter P5
 */
export function validateSpec(
  spec: PipelineSpec,
):
  | { ok: true }
  | { ok: false; code: PipelineSpecErrorCode; detail: Record<string, unknown>; hint?: string } {
  const outputs = spec.renderState?.outputs;
  if (
    outputs !== undefined &&
    (outputs.length !== spec.attachments.colorFormats.length ||
      outputs.some((output, index) => output.format !== spec.attachments.colorFormats[index]))
  ) {
    return {
      ok: false,
      code: 'attachment-format-incompatible',
      detail: {
        expected: outputs.map((output) => output.format),
        actual: spec.attachments.colorFormats,
      },
      hint: 'bind graph color attachments in the declared material output location order',
    };
  }
  // Check 1: sampleCount=4 with empty colorFormats is inconsistent —
  // multisample requires a colour target to resolve to.
  if (spec.attachments.sampleCount === 4 && spec.attachments.colorFormats.length === 0) {
    return {
      ok: false,
      code: 'spec-inconsistent',
      detail: { reason: 'sample-count-format-incompatible' },
      hint: 'sampleCount=4 requires at least one colorFormat; shadow-caster (depth-only) passes should use sampleCount=1',
    };
  }

  // Check 2: unknown pass kind
  if (!KNOWN_PASS_KINDS.includes(spec.shader.passKind)) {
    return {
      ok: false,
      code: 'unknown-pass-kind',
      detail: { expected: KNOWN_PASS_KINDS, actual: spec.shader.passKind },
      hint: `passKind '${spec.shader.passKind}' is not in KNOWN_PASS_KINDS; register custom pass kinds via ShaderCatalog`,
    };
  }

  // Check 3: depth-testing renderState without a depthFormat
  const depthOnly = passKindPolicyTable[spec.shader.passKind]?.shape === 'depth-only';
  const depthRequired = !!spec.renderState?.depthCompare || depthOnly;
  if (!spec.attachments.depthFormat && depthRequired) {
    return {
      ok: false,
      code: 'attachment-format-incompatible',
      detail: {
        reason: 'depth-requirement-without-depth-format',
        expected: 'depthFormat must be set when depth testing or a depth-only pass is requested',
        actual: `depthFormat=${String(spec.attachments.depthFormat)}, depthCompare=${spec.renderState?.depthCompare}`,
      },
      hint: 'set attachments.depthFormat (e.g. depth32float-stencil8 or depth32float) when renderState specifies depthCompare',
    };
  }

  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// PipelineCache — Map<string, RenderPipeline> container (D-12)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Pipeline cache — Map from cacheKeyOf(spec) to opaque RenderPipeline handle.
 *
 * Constructed once at createRenderer boot time; shared across all call sites.
 * Consumers call `getOrBuildPipeline(spec, deviceProvider, cache)` — the
 * entrypoint does cache lookup internally; consumers never touch the Map
 * directly.
 *
 * @see plan-strategy D-12 · requirements §3.2
 */
export type PipelineCache = Map<string, unknown>;

// ══════════════════════════════════════════════════════════════════════════════
// getOrBuildPipeline — single entrypoint (D-12)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Device factory interface consumed by {@link getOrBuildPipeline}.
 *
 * Slim abstraction: only `createRenderPipeline` is needed; the entrypoint
 * does not depend on the full `RhiDevice` interface so it can be tested
 * with a mock.
 */
export interface PipelineDeviceProvider {
  createRenderPipeline(
    descriptor: Record<string, unknown>,
  ): { ok: true; value: unknown } | { ok: false; error: unknown };
}

/**
 * Single entrypoint for obtaining a render pipeline from a spec.
 *
 * Cache-hit path: key = cacheKeyOf(spec), returns cached handle immediately.
 * Cache-miss path: validates spec → builds descriptor → calls device.createRenderPipeline
 * → caches result → returns handle.
 * Build failure: throws PipelineSpecError (charter P3 fail-fast, no silent fallback).
 *
 * Pure function: same (spec, deviceProvider, cache) always produces the same result.
 * Boot-time call site: createRenderer wires the real device; record-stage call site
 * uses ctx.runtime.device (same entrypoint, same signature).
 *
 * @param spec - immutable 4-axis pipeline specification
 * @param deviceProvider - factory with createRenderPipeline method
 * @param cache - the PipelineCache (shared across boot + record stage)
 * @returns a RenderPipeline handle (opaque, typed as unknown for M1)
 * @throws PipelineSpecError on validation failure or build failure
 * @see plan-strategy D-12 · requirements AC-03 · charter F1
 */
export function getOrBuildPipeline(
  spec: PipelineSpec,
  deviceProvider: PipelineDeviceProvider,
  cache: PipelineCache,
  modules?: {
    vertex: unknown;
    fragment: unknown;
    vertexEntryPoint?: string;
    fragmentEntryPoint?: string;
    layout?: unknown;
  },
): unknown {
  const key = cacheKeyOf(spec);

  // Cache hit — return immediately.
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // Cache miss — validate, build, cache, return.
  const validation = validateSpec(spec);
  if (!validation.ok) {
    throw new PipelineSpecError({
      code: validation.code,
      detail: validation.detail,
      ...(validation.hint !== undefined ? { hint: validation.hint } : {}),
    });
  }

  const descriptor = buildPipelineDescriptor(
    spec,
    modules ?? { vertex: undefined, fragment: undefined },
  );
  const result = deviceProvider.createRenderPipeline(descriptor);

  if (!result.ok) {
    throw new PipelineSpecError({
      code: 'pipeline-build-failed',
      detail: { cause: result.error },
      hint: 'device.createRenderPipeline failed for spec; inspect gpuMessage on the error detail',
    });
  }

  cache.set(key, result.value);
  return result.value;
}

// ══════════════════════════════════════════════════════════════════════════════
// SPEC_CONST_TABLE — common boot-time pre-warm variants
// ══════════════════════════════════════════════════════════════════════════════

const PROCEDURAL_ATTR_LAYOUT = DEFAULT_VERTEX_ATTRIBUTE_MAP;

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const DEPTH_DS: GPUTextureFormat = 'depth32float-stencil8';

/**
 * Default LDR view format used when callers ask for the SPEC_CONST table
 * without an explicit swap-chain format. Kept for the backward-compatible
 * `SPEC_CONST_TABLE` export consumed by unit tests that exercise the
 * spec/cache-keying layer in isolation. Runtime callers always pass the
 * format selected by `selectSwapChainFormat` (Channel 2 BGRA / Channel 3
 * RGBA / dawn-node RGBA — see bug-20260615 fix-up note in `createRenderer`).
 */
const DEFAULT_LDR_FORMAT: GPUTextureFormat = 'bgra8unorm-srgb';

const TRI_GEOMETRY = {
  topology: 'triangle-list' as PrimitiveTopology,
  stripIndexFormat: undefined,
  vertexLayout: PROCEDURAL_ATTR_LAYOUT,
};

/**
 * Build seven common boot-time PipelineSpec variants: four unlit attachment /
 * sample-count combinations, tonemap and two skybox variants. Standard PBR
 * belongs to the material pipeline cache, where the admitted geometry, lighting,
 * render state and attachments determine its complete spec. Recovery prepares
 * those actual LKG requests before publication instead of compiling a second
 * generic Standard matrix in every replacement generation.
 *
 * `ldrViewFormat` parameterises the LDR color attachment format. Callers
 * pass the runtime-resolved swap-chain view format (Channel 2 typically
 * `bgra8unorm-srgb`; Channel 3 wgpu-wasm and dawn-node typically
 * `rgba8unorm-srgb`). Hard-coding `bgra8unorm-srgb` at module load made
 * the pre-warmed PSOs incompatible with the actual RenderPass color
 * attachment on Channel 3 / dawn-node, producing whole-commandBuffer
 * invalid errors on every frame (bug-20260615 fix-up — see
 * `createRenderer` boot-time pre-warm site).
 *
 * Fullscreen passes (fxaa / bloom x 3 / SSAO x 2) are lazy-build — they
 * use the same getOrBuildPipeline entrypoint but are not in this table.
 *
 * @see plan-strategy D-4 · research R-D4 · requirements AC-16
 * @see bug-20260612-webgpu-canvas-format-prefer-bgra-shipped (same trap shape)
 */
export function buildSpecConstTable(
  ldrViewFormat: GPUTextureFormat,
): readonly Readonly<PipelineSpec>[] {
  const TRI_ATTACHMENTS_LDR_S1 = {
    colorFormats: [ldrViewFormat],
    depthFormat: DEPTH_DS,
    sampleCount: 1 as const,
  };

  const TRI_ATTACHMENTS_LDR_S4 = {
    colorFormats: [ldrViewFormat],
    depthFormat: DEPTH_DS,
    sampleCount: 4 as const,
  };

  // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w14 (AC-12 / D-7):
  // SPRITE_ATTACHMENTS_LDR_S1 / S4 (the dedicated non-srgb storage-format
  // attachments the sprite spec entries consumed) were deleted alongside the
  // four `forgeax::default-sprite` SPEC_CONST entries. The bgra8unorm storage
  // format itself is still enforced at the LDR sprite sub-pass attachment
  // level (the WebGPU pipeline `colorFormats` derive from the actual render
  // pass attachment view, which is built off `pipelineState.format` =
  // swap-chain storage format — see `render-system-record.ts` LDR split
  // beginRenderPass call). The triggering source migrated from the
  // spec-table id to `material.transparent` (derived by the extract stage
  // from `passes[0].renderState.blend !== undefined`, the
  // post-feat-20260626-collapse SSOT; w7 onwards).

  const TRI_ATTACHMENTS_HDR_S1 = {
    colorFormats: [HDR_FORMAT],
    depthFormat: DEPTH_DS,
    sampleCount: 1 as const,
  };

  const TRI_ATTACHMENTS_HDR_S4 = {
    colorFormats: [HDR_FORMAT],
    depthFormat: DEPTH_DS,
    sampleCount: 4 as const,
  };

  return [
    // unlit LDR S1
    {
      shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_LDR_S1,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // unlit LDR S4
    {
      shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_LDR_S4,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // unlit HDR S1
    {
      shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_HDR_S1,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // unlit HDR S4
    {
      shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
      attachments: TRI_ATTACHMENTS_HDR_S4,
      geometry: TRI_GEOMETRY,
      renderState: undefined,
    },
    // ── M2-T4: fullscreen-post boot-time pre-warm (tonemap + skybox) ──────────
    //
    // Tonemap (LDR S1): fullscreen triangle writes to swap-chain LDR view format
    // (parameterised — `ldrViewFormat`; see buildSpecConstTable jsdoc + bug-20260615).
    // Skybox (HDR S1 + S4): fullscreen triangle writes to rgba16float; MSAA variant
    // has sampleCount=4. Both use empty vertexLayout (fullscreen triangle, no
    // attributes) and cullMode='none' (forward cull for fullscreen-quad passthrough).
    //
    // Shadow-probe / fxaa / Bloom 10-pass / SSAO 2-stage are lazy-build — not in
    // SPEC_CONST_TABLE (R-D4 decision: only entries that are always-present on
    // every boot).

    // tonemap LDR S1 (writes to runtime-resolved swap-chain LDR view format)
    {
      shader: { id: 'forgeax::post::tonemap', passKind: 'post-process', variantSet: undefined },
      attachments: {
        colorFormats: [ldrViewFormat],
        depthFormat: undefined,
        sampleCount: 1 as const,
      },
      geometry: {
        topology: 'triangle-list' as PrimitiveTopology,
        stripIndexFormat: undefined,
        vertexLayout: {},
      },
      renderState: {
        cullMode: 'none',
      },
    },

    // skybox HDR S1 (writes to rgba16float, no depth)
    {
      shader: { id: 'forgeax::skybox::cube', passKind: 'skybox', variantSet: undefined },
      attachments: {
        colorFormats: [HDR_FORMAT],
        depthFormat: undefined,
        sampleCount: 1 as const,
      },
      geometry: {
        topology: 'triangle-list' as PrimitiveTopology,
        stripIndexFormat: undefined,
        vertexLayout: {},
      },
      renderState: {
        cullMode: 'none',
      },
    },

    // skybox HDR S4 (MSAA variant)
    {
      shader: { id: 'forgeax::skybox::cube', passKind: 'skybox', variantSet: undefined },
      attachments: {
        colorFormats: [HDR_FORMAT],
        depthFormat: undefined,
        sampleCount: 4 as const,
      },
      geometry: {
        topology: 'triangle-list' as PrimitiveTopology,
        stripIndexFormat: undefined,
        vertexLayout: {},
      },
      renderState: {
        cullMode: 'none',
      },
    },
  ];
}

/**
 * Derive the material-only pre-warm table for a native linear-LDR target.
 *
 * The regular SPEC_CONST table targets the swap-chain view, while the
 * tonemap=none path records geometry directly into the graph-owned
 * `rgba16float` target. Keep that second attachment matrix derived from the
 * same material specs so the first frame does not depend on an asynchronous
 * lazy PSO build.
 */
export function buildLinearLdrMaterialSpecTable(
  ldrViewFormat: GPUTextureFormat,
): readonly Readonly<PipelineSpec>[] {
  return buildSpecConstTable(ldrViewFormat)
    .filter(
      (spec) =>
        spec.shader.passKind === 'forward' && spec.attachments.colorFormats[0] === ldrViewFormat,
    )
    .map((spec) => ({
      ...spec,
      attachments: {
        ...spec.attachments,
        colorFormats: [HDR_FORMAT],
      },
    }));
}

/**
 * Backward-compatible SPEC_CONST_TABLE — the table built with the default
 * LDR view format (`bgra8unorm-srgb`). Unit tests that exercise the
 * spec/cache-keying layer in isolation import this directly. Runtime
 * callers MUST call `buildSpecConstTable(swapChainFormats.view)` instead
 * so the pre-warmed PSO color format matches the actual RenderPass color
 * attachment on every backend (bug-20260615 fix-up).
 */
export const SPEC_CONST_TABLE: readonly Readonly<PipelineSpec>[] =
  buildSpecConstTable(DEFAULT_LDR_FORMAT);
