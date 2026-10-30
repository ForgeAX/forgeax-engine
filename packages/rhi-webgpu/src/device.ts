// @forgeax/engine-rhi-webgpu/src/device - WebGPU GPUDevice -> RhiDevice thin shim.
//
// Iron laws (README + AGENTS.md "## RHI / WebGPU"):
// - spec-aligned: 5 + 4 descriptor field names match GPUDevice.createX byte-for-byte.
// - `?: T | undefined` + `'x' in src` guard distinguishes "missing" vs
//   "explicit undefined" (research F-3 anti-pattern 2 / hard-constraint 10).
// - opaque handle: RhiDevice.createX returns Result.ok(handle); the handle
//   internally references the GPU resource but exposes only a brand-only
//   opaque shape (research R5).
// - capability-gated: caps / features / limits exposed independently as
//   readonly layers (charter proposition 5).
// - device.lost two-track: spec Promise passthrough + engine-layer
//   LostListenerRegistry (R2 mitigation / research F-4); this package only
//   exposes the spec Promise without a second cache.
//
// w3 / w5 / w6 (feat-20260508-rhi-surface-completion, co-commit):
// - createCommandEncoder + 12 RhiCommandEncoder spec methods plus the
//   ForgeAX encodeEmptyComputePass compound operation + 3 mixin (w3)
// - Shared draw/binding commands, pass state, queries and immutable bundles
// - Queue.submit / writeBuffer real implementation + bounds validation (w6)
//
// co-commit reason: w3, w5, w6 each modify both `@forgeax/engine-rhi/src/index.ts`
// and `@forgeax/engine-rhi-webgpu/src/device.ts`; the encoder lifecycle (D-S3
// templates 1 + 2) couples render-pass end() to command-encoder finish(),
// so independent commits would leave the interface and shim inconsistent
// between commits.

/// <reference types="@webgpu/types" />

import type {
  BindGroup,
  BindGroupDescriptor,
  BindGroupLayout,
  BindGroupLayoutDescriptor,
  Buffer,
  BufferDescriptor,
  CanvasConfiguration,
  CommandBuffer,
  CommandEncoderDescriptor,
  ComputePassDescriptor,
  ComputePipeline,
  ComputePipelineDescriptor,
  ExternalImageTextureDestination,
  MappedBuffer,
  PipelineLayout,
  PipelineLayoutDescriptor,
  QuerySet,
  QuerySetDescriptor,
  RenderBundle,
  RenderBundleDescriptor,
  RenderBundleEncoderDescriptor,
  RenderPassDescriptor,
  RenderPipeline,
  RenderPipelineDescriptor,
  Result,
  RhiCanvasContext,
  RhiCaps,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiError,
  RhiFeatures,
  RhiLimits,
  RhiQueue,
  RhiRenderBundleEncoder,
  RhiRenderCommands,
  RhiRenderPassEncoder,
  Sampler,
  SamplerDescriptor,
  TexelCopyBufferInfo,
  TexelCopyTextureInfo,
  Texture,
  TextureDescriptor,
  TextureView,
  TextureViewDescriptor,
} from '@forgeax/engine-rhi';
import {
  commandEncoderFinished,
  createQueueCompletionHold,
  err,
  ok,
  queueSubmitFailed,
  queueWriteBufferOutOfBounds,
  RhiError as RhiErrorClass,
  rayQueryUnsupported,
  renderPassNotEnded,
  validateRayQueryBindGroupLayout,
  validateRayQueryBufferUsage,
} from '@forgeax/engine-rhi';

import { COMMAND_COUNTS } from './command-counts';
import { probeR32FloatCapability } from './internal/r32float-capability';
import {
  hasExternalTextureCapability,
  importExternalTexture,
  validateImportedTexture,
} from './internal/texture-import';
import { resolveTimestampQueries } from './internal/timestamp-query';
import { WebGpuPipelineLibrary } from './pipeline-library';
import { WebGpuAccelerationStructures, webgpuRayQueryCaps } from './ray-query';

/**
 * Mirror forgeax `?: T | undefined` descriptor onto the spec GPUXxxDescriptor
 * shape with `'x' in src` guards distinguishing missing vs explicit-undefined:
 *
 * - missing key   -> out has no key (preserves the spec `?: T` simplified form)
 * - present + undefined -> out has the key set to undefined (technically out
 *   of bounds for spec `?: T` but the shim preserves writer intent for
 *   downstream test assertions; research F-3 trade-off)
 * - present + value -> out has the key with the value
 *
 * Equivalent shape: under exactOptionalPropertyTypes:true we must spread
 * rather than `dst[k] = src[k]` because the latter maps both missing and
 * explicit-undefined to "present + undefined".
 */
type MirrorOut = Record<string, unknown>;

function mirror<TIn extends Record<string, unknown>>(
  src: TIn,
  keys: readonly (keyof TIn & string)[],
): MirrorOut {
  const out: MirrorOut = {};
  for (const k of keys) {
    if (k in src) {
      out[k] = src[k];
    }
  }
  return out;
}

const BUFFER_KEYS = ['label', 'size', 'usage', 'mappedAtCreation'] as const;
const TEXTURE_KEYS = [
  'label',
  'size',
  'mipLevelCount',
  'sampleCount',
  'dimension',
  'format',
  'usage',
  'viewFormats',
  'textureBindingViewDimension',
] as const;
const SAMPLER_KEYS = [
  'label',
  'addressModeU',
  'addressModeV',
  'addressModeW',
  'magFilter',
  'minFilter',
  'mipmapFilter',
  'lodMinClamp',
  'lodMaxClamp',
  'compare',
  'maxAnisotropy',
] as const;
const BGL_KEYS = ['label', 'entries'] as const;
// BG_KEYS removed in w20 — createBindGroup now uses tagged-union dispatch
// over RhiBindingResource 4 kinds (not field-mirror passthrough).
const PL_KEYS = ['label', 'bindGroupLayouts'] as const;
const ENC_KEYS = ['label'] as const;
const TEXTURE_VIEW_KEYS = [
  'label',
  'format',
  'dimension',
  'usage',
  'aspect',
  'baseMipLevel',
  'mipLevelCount',
  'baseArrayLayer',
  'arrayLayerCount',
] as const;
const CP_KEYS = ['label', 'layout', 'compute'] as const;
const QS_KEYS = ['label', 'type', 'count'] as const;
/** Spec normative upper bound on QuerySet.count (research §1.3 device timeline step 1). */
const QUERY_SET_COUNT_LIMIT = 4096;

/**
 * RhiDevice -> raw GPUDevice reverse lookup table (fix-f3).
 *
 * After RhiDevice.createShaderModule was removed, the top-level async
 * `createShaderModule(device, desc)` entry point needs to reach the
 * underlying GPUDevice. The WeakMap keeps the public RhiDevice surface clean
 * (no internal field) and clears automatically when the device is GC'd
 * (charter proposition 5 consistent abstraction).
 *
 * Buffer<->raw GPUBuffer / Encoder<->raw GPUCommandEncoder etc. WeakMaps
 * follow the same pattern; they enable the queue.writeBuffer real-path to
 * resolve buffer.size for bounds validation, and the encoder shim to
 * forward recording calls to the underlying GPUCommandEncoder.
 */
const RAW_DEVICE_MAP: WeakMap<RhiDevice, GPUDevice> = new WeakMap();
const PIPELINE_LIBRARY_MAP = new WeakMap<RhiDevice, WebGpuPipelineLibrary>();

export function pipelineLibraryFor(device: RhiDevice): WebGpuPipelineLibrary | undefined {
  return PIPELINE_LIBRARY_MAP.get(device);
}
const DISPOSED_DEVICE_SET: WeakSet<RhiDevice> = new WeakSet();
const RAW_DEVICE_GENERATION_MAP: WeakMap<GPUDevice, number> = new WeakMap();
const R32FLOAT_PROBE_CACHE: WeakMap<
  RhiDevice,
  Promise<Result<import('@forgeax/engine-rhi').RhiTextureFormatCapabilityReceipt, RhiError>>
> = new WeakMap();
let NEXT_DEVICE_GENERATION = 1;
const BUFFER_RAW_MAP: WeakMap<Buffer, GPUBuffer> = new WeakMap();
const TEXTURE_VIEW_RAW_MAP: WeakMap<TextureView, GPUTextureView> = new WeakMap();
const ENCODER_STATE: WeakMap<RhiCommandEncoder, EncoderState> = new WeakMap();
const COMMAND_BUFFER_RAW_MAP: WeakMap<CommandBuffer, GPUCommandBuffer> = new WeakMap();

/**
 * Texture metadata tracked by the shim for createTextureView fast-path
 * cross-resource validation (research §1.1):
 *   - format / viewFormats: format must be in (format ∪ viewFormats).
 *   - usage: createTextureView usage must be a subset of source usage.
 *
 * The shim records these at createTexture time; createTextureView reads them
 * before forwarding to the raw GPU. spec rationale: GPUTexture exposes
 * `.format` / `.usage` etc. as readonly fields, but `.viewFormats` is not
 * surfaced as a runtime field on GPUTexture in @webgpu/types v0.1.69 — the
 * shim must remember it from the descriptor.
 */
interface TextureMeta {
  readonly format: GPUTextureFormat;
  readonly usage: GPUTextureUsageFlags;
  readonly viewFormats: readonly GPUTextureFormat[];
  /**
   * Per-handle lifecycle marker for `RhiDevice.destroyTexture` fail-fast
   * (feat-20260612 D-7). Mutated to `true` by the first successful
   * `destroyTexture(tex)` call; a second destroy on the same handle reads
   * the flag and surfaces `Result.err({ code: 'destroy-after-destroy' })`
   * rather than forwarding to the underlying spec idempotent void.
   */
  destroyed: boolean;
  /** Caller-owned texture from importTexture: destroy releases bookkeeping only. */
  readonly borrowed?: true;
}
const TEXTURE_META_MAP: WeakMap<Texture, TextureMeta> = new WeakMap();

interface EncoderState {
  raw: GPUCommandEncoder;
  finished: boolean;
  activePass: WebGpuRenderPassEncoder | null;
}

/** WeakMap that tracks raw GPUQuerySet for createQuerySet handles so the shim
 *  can read `.count` for queryIndex bounds checking (research §2.1 step 2). */
const QUERY_SET_RAW_MAP: WeakMap<QuerySet, GPUQuerySet> = new WeakMap();
const QUERY_SET_DESTROYED_MAP: WeakMap<QuerySet, { destroyed: boolean }> = new WeakMap();

/**
 * WeakMap that tracks Buffer metadata (size + usage) so resolveQuerySet (and
 * other shim entry points) can validate spec preconditions before forwarding
 * to the raw GPU (research §2.3 destination.usage / destinationOffset bounds).
 *
 * usage is the bitmask passed at createBuffer time; size is `desc.size` (the
 * underlying GPUBuffer.size is also readable but the shim records the
 * descriptor-level size for parity with TextureMeta).
 */
interface BufferMeta {
  readonly size: number;
  readonly usage: GPUBufferUsageFlags;
  /**
   * Per-handle lifecycle marker for `RhiDevice.destroyBuffer` fail-fast
   * (feat-20260612 D-7). Mutated to `true` by the first successful
   * `destroyBuffer(buf)` call; a second destroy on the same handle reads
   * the flag and surfaces `Result.err({ code: 'destroy-after-destroy' })`
   * rather than forwarding to the underlying spec idempotent void.
   */
  destroyed: boolean;
}
const BUFFER_META_MAP: WeakMap<Buffer, BufferMeta> = new WeakMap();
/** GPUBufferUsage.QUERY_RESOLVE bit (W3C WebGPU §3.5.2 GPUBufferUsage). */
const BUFFER_USAGE_QUERY_RESOLVE = 0x200;
/** Spec normative resolve alignment (research §2.3 step 6 +
 *  kQueryResolveAlignment in dawn). */
const QUERY_RESOLVE_ALIGNMENT = 256;

/**
 * Get the underlying GPUDevice associated with a RhiDevice.
 *
 * @internal
 *
 * Single-point escape hatch (D-S1 / feat-20260508-rhi-surface-completion).
 * The `_internal_` prefix + `@internal` JSDoc tag mark this as engine-internal
 * plumbing; the only sanctioned consumer is
 * `apps/hello/triangle/src/main.ts:96` which threads the raw GPUDevice into
 * the host's internal canvas-device configuration slot so the canvas
 * `GPUCanvasContext.configure({device})` slot keeps working
 * (GPUCanvasContext is outside the RHI surface). Every other engine path
 * goes through the RHI interface.
 *
 * Future: deprecated once `feat-future-rhi-adapter-surface` lands a
 * `RhiCanvasContext` abstraction; this function will be removed at that
 * closure. AC-08 grep gate keeps further callers out via word-boundary
 * `\bgetRawDevice\b` allow-list (see apps/hello/triangle/scripts/ac-08-grep-gate.mjs).
 */
export function _internal_getRawDevice(device: RhiDevice): GPUDevice | undefined {
  return RAW_DEVICE_MAP.get(device);
}

/** Release a raw device acquired for one Renderer generation. */
export function disposeDevice(device: RhiDevice): void {
  const rawDevice = RAW_DEVICE_MAP.get(device);
  if (rawDevice === undefined || DISPOSED_DEVICE_SET.has(device)) return;
  PIPELINE_LIBRARY_MAP.get(device)?.dispose();
  rawDevice.destroy();
  DISPOSED_DEVICE_SET.add(device);
}

// Caps probe — split by spec-feature gate vs mandatory-but-spec-noncompliant
// fallback (m1-1-b scope-amend, plan §6 D-2 gap):
//
//   * Optional spec features (`rg11b10ufloat-renderable`,
//     `float32-filterable`) carry an authoritative `device.features.has(...)`
//     answer. A `createTexture` probe on the unsupported format triggers a
//     WebGPU validation error which the dawn / Chrome implementations
//     fan out via `device.onuncapturederror` even when caught by JS try /
//     catch — the SUT-level `onerror-gate` (apps/shared/src/onerror-gate.ts)
//     observes that channel and turns a green-on-paper probe into a CI red
//     `limit-exceeded` error. Solution: gate the probe by `features.has(...)`
//     first and skip the destructive `createTexture` call entirely when the
//     feature is absent.
//
//   * `rgba16float` is mandatory `RENDER_ATTACHMENT` per spec but observed
//     unreliable on WebKit — exactly the AC-02 motivation. Keep the real
//     `createTexture` probe here: any browser declaring it but rejecting at
//     `createTexture` time deserves a `false` cap, and a violation under
//     `rgba16float` would ALREADY break HDR / IBL paths so the
//     onuncapturederror fan-out is correctly diagnostic, not noise.

function probeRgba16floatRenderable(device: GPUDevice): boolean {
  let tex: GPUTexture | undefined;
  try {
    tex = device.createTexture({
      label: 'forgeax-caps-probe-rgba16float-renderable',
      format: 'rgba16float',
      usage: 16, // GPUTextureUsage.RENDER_ATTACHMENT
      size: [1, 1, 1],
    });
    return true;
  } catch {
    return false;
  } finally {
    tex?.destroy?.();
  }
}

function probeRg11b10ufloatRenderable(device: GPUDevice, features: GPUSupportedFeatures): boolean {
  // Feature-gated: `rg11b10ufloat-renderable` is an optional feature per spec.
  // Skip the destructive createTexture probe when the feature is absent so the
  // dawn / Chrome backend's onuncapturederror channel does not fire (CI gate).
  if (!features.has('rg11b10ufloat-renderable' as GPUFeatureName)) return false;
  let tex: GPUTexture | undefined;
  try {
    tex = device.createTexture({
      label: 'forgeax-caps-probe-rg11b10ufloat-renderable',
      format: 'rg11b10ufloat',
      usage: 16, // GPUTextureUsage.RENDER_ATTACHMENT
      size: [1, 1, 1],
    });
    return true;
  } catch {
    return false;
  } finally {
    tex?.destroy?.();
  }
}

function probeFloat32Filterable(device: GPUDevice, features: GPUSupportedFeatures): boolean {
  // Feature-gated: `float32-filterable` is an optional feature per spec.
  // The bind-group-layout validation below would trigger
  // onuncapturederror when the feature is absent.
  if (!features.has('float32-filterable' as GPUFeatureName)) return false;
  try {
    device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, sampler: { type: 'filtering' } }, // GPUShaderStage.FRAGMENT = 2
        { binding: 1, visibility: 2, texture: { sampleType: 'float' } },
      ],
    });
    device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    return true;
  } catch {
    return false;
  }
}

/** Probe the 11 caps fields from GPUDevice.features + GPUDevice.limits
 *  (charter proposition 5). 4 new fields (samplerAliasing /
 *  firstInstanceIndirect / storageBuffer / storageTexture) added by
 *  feat-20260511-rhi-spec-realign-aggressive w19 per D-P3 + research R-03
 *  §3.1 mapping matrix. 3 new HDR / filterable caps fields
 *  (rgba16floatRenderable / rg11b10ufloatRenderable / float32Filterable)
 *  added by feat-20260608-rhi-hdr-renderable-caps-and-warn-once M1 per
 *  D-1 + D-2 + D-2.1. */
function timestampPeriodOf(rawDevice: GPUDevice): number {
  const period = (rawDevice as GPUDevice & { readonly timestampPeriod?: unknown }).timestampPeriod;
  return typeof period === 'number' && period > 0 ? period : 1;
}

function deriveCaps(
  rawDevice: GPUDevice,
  features: GPUSupportedFeatures,
  limits: GPUSupportedLimits,
): RhiCaps {
  const has = (name: string): boolean => features.has(name as GPUFeatureName);
  // Texture-compression three-way caps (M4 w26): derived from adapter.features
  // per-compression-format, replacing the single rolled-up boolean.
  // D-8: no hand-assigned true/false literals; all derived via has(...) from
  // the features Set.
  const textureCompressionBc = has('texture-compression-bc');
  const textureCompressionEtc2 = has('texture-compression-etc2');
  const textureCompressionAstc = has('texture-compression-astc');
  // HDR renderable + filterable caps (m1-1-b: split probe by spec-feature gate
  // vs mandatory-but-noncompliant fallback). `rgba16float` is mandatory
  // `RENDER_ATTACHMENT` per spec but unreliable on WebKit — keep the real
  // probe (AC-02 motivation). `rg11b10ufloat-renderable` and `float32-
  // filterable` carry authoritative `features.has(...)` answers; gate by
  // feature first to avoid fan-out via `device.onuncapturederror` (apps/
  // shared/src/onerror-gate.ts) when the optional feature is absent.
  const hdrCaps = {
    rgba16floatRenderable: probeRgba16floatRenderable(rawDevice),
    rg11b10ufloatRenderable: probeRg11b10ufloatRenderable(rawDevice, features),
    float32Filterable: probeFloat32Filterable(rawDevice, features),
  };
  return {
    backendKind: 'webgpu' as const,
    compute: true, // WebGPU spec mandates compute-pipeline support.
    timestampQuery: has('timestamp-query'),
    // W3C WebGPU resolves timestamps in nanoseconds; a native wgpu GPU resolves raw
    // ticks and publishes their period as `timestampPeriod`.
    timestampPeriodNanoseconds: has('timestamp-query') ? timestampPeriodOf(rawDevice) : null,
    indirectDrawing: true, // WebGPU spec mandates drawIndirect / drawIndexedIndirect.
    textureCompressionBc,
    textureCompressionEtc2,
    textureCompressionAstc,
    multiDrawIndirect: false, // wgpu native extension; unavailable on WebGPU browser path.
    pushConstants: false, // wgpu native extension; unavailable on WebGPU browser path.
    textureBindingArray: false, // wgpu native extension; unavailable on WebGPU browser path.
    // 4 new fields (D-P3 / R-03 §3.1):
    samplerAliasing: true, // spec mandatory on browser backends.
    firstInstanceIndirect: has('indirect-first-instance'),
    storageBuffer: (limits.maxStorageBuffersPerShaderStage ?? 0) > 0,
    storageTexture: (limits.maxStorageTexturesPerShaderStage ?? 0) > 0,
    // HDR / filterable caps (feat-20260608 M1):
    ...hdrCaps,
    textureImport: true,
    externalTexture: hasExternalTextureCapability(rawDevice),
    maxColorAttachments: limits.maxColorAttachments ?? 4,
    // Browser WebGPU and Dawn expose no acceleration structures; the native
    // wgpu GPU adds the Ray Query extension (./ray-query.ts).
    rayQuery: webgpuRayQueryCaps(rawDevice),
  };
}

/** Command-count fields of one recording lane (see ./command-counts). */
interface RenderCommandLane {
  readonly draws: 'draws' | 'bundleDraws';
  readonly pipelineSets: 'pipelineSets' | 'bundlePipelineSets';
  readonly bindGroupSets: 'bindGroupSets' | 'bundleBindGroupSets';
  readonly vertexBufferSets: 'vertexBufferSets' | 'bundleVertexBufferSets';
}
const PASS_LANE: RenderCommandLane = {
  draws: 'draws',
  pipelineSets: 'pipelineSets',
  bindGroupSets: 'bindGroupSets',
  vertexBufferSets: 'vertexBufferSets',
};
const BUNDLE_LANE: RenderCommandLane = {
  draws: 'bundleDraws',
  pipelineSets: 'bundlePipelineSets',
  bindGroupSets: 'bundleBindGroupSets',
  vertexBufferSets: 'bundleVertexBufferSets',
};

/**
 * Shared native draw, binding and debug commands for passes and bundles.
 * Encoders are class instances: one allocation per pass instead of a closure
 * per command, which every recorded pass and bundle paid on every frame.
 */
// Encoded work retains the JS dependency closure as well as native internal
// handles, so source/recipe metadata survives when only a bundle is retained.
const COMMAND_REFERENCES = new WeakMap<object, Set<object>>();
function commandReferences(owner: object): Set<object> {
  let references = COMMAND_REFERENCES.get(owner);
  if (references === undefined) {
    references = new Set();
    COMMAND_REFERENCES.set(owner, references);
  }
  return references;
}

class WebGpuRenderCommands implements RhiRenderCommands {
  constructor(
    protected readonly rawPass: GPURenderPassEncoder | GPURenderBundleEncoder,
    private readonly lane: RenderCommandLane,
    protected readonly references = new Set<object>(),
  ) {}

  setPipeline(pipeline: RenderPipeline): void {
    COMMAND_COUNTS[this.lane.pipelineSets]++;
    this.references.add(pipeline);
    this.rawPass.setPipeline(pipeline as unknown as GPURenderPipeline);
  }

  setVertexBuffer(
    slot: number,
    buffer: Buffer,
    offset?: number | undefined,
    size?: number | undefined,
  ): void {
    // M5 / w35: resolve forgeax Buffer wrapper to raw GPUBuffer.
    COMMAND_COUNTS[this.lane.vertexBufferSets]++;
    const rawBuf = BUFFER_RAW_MAP.get(buffer) ?? (buffer as unknown as GPUBuffer);
    this.rawPass.setVertexBuffer(slot, rawBuf, offset, size);
  }

  setIndexBuffer(
    buffer: Buffer,
    format: 'uint16' | 'uint32',
    offset?: number | undefined,
    size?: number | undefined,
  ): void {
    // M5 / w35: resolve forgeax Buffer wrapper to raw GPUBuffer.
    const rawBuf = BUFFER_RAW_MAP.get(buffer) ?? (buffer as unknown as GPUBuffer);
    this.rawPass.setIndexBuffer(rawBuf, format, offset, size);
  }

  setBindGroup(
    index: number,
    bindGroup: BindGroup,
    arg3?: readonly number[] | Uint32Array | undefined,
    arg4?: number | undefined,
    arg5?: number | undefined,
  ): void {
    // Two overload forms (D-S4 setBindGroup):
    //   (a) (index, bindGroup, dynamicOffsets?: readonly number[])
    //   (b) (index, bindGroup, dynamicOffsetsData: Uint32Array,
    //        dynamicOffsetsDataStart, dynamicOffsetsDataLength)
    COMMAND_COUNTS[this.lane.bindGroupSets]++;
    if (arg3 instanceof Uint32Array) {
      this.rawPass.setBindGroup(
        index,
        bindGroup as unknown as GPUBindGroup,
        arg3,
        arg4 ?? 0,
        arg5 ?? arg3.length,
      );
    } else if (arg3 === undefined) {
      this.rawPass.setBindGroup(index, bindGroup as unknown as GPUBindGroup);
    } else {
      this.rawPass.setBindGroup(index, bindGroup as unknown as GPUBindGroup, arg3);
    }
  }

  draw(
    vertexCount: number,
    instanceCount?: number | undefined,
    firstVertex?: number | undefined,
    firstInstance?: number | undefined,
  ): void {
    COMMAND_COUNTS[this.lane.draws]++;
    this.rawPass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
  }

  drawIndexed(
    indexCount: number,
    instanceCount?: number | undefined,
    firstIndex?: number | undefined,
    baseVertex?: number | undefined,
    firstInstance?: number | undefined,
  ): void {
    COMMAND_COUNTS[this.lane.draws]++;
    this.rawPass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
  }

  drawIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    const rawBuf = BUFFER_RAW_MAP.get(indirectBuffer) ?? (indirectBuffer as unknown as GPUBuffer);
    COMMAND_COUNTS[this.lane.draws]++;
    this.rawPass.drawIndirect(rawBuf, indirectOffset);
  }

  drawIndexedIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    const rawBuf = BUFFER_RAW_MAP.get(indirectBuffer) ?? (indirectBuffer as unknown as GPUBuffer);
    COMMAND_COUNTS[this.lane.draws]++;
    this.rawPass.drawIndexedIndirect(rawBuf, indirectOffset);
  }

  pushDebugGroup(groupLabel: string): void {
    this.rawPass.pushDebugGroup(groupLabel);
  }

  popDebugGroup(): void {
    this.rawPass.popDebugGroup();
  }

  insertDebugMarker(markerLabel: string): void {
    this.rawPass.insertDebugMarker(markerLabel);
  }
}

/** Render pass encoder; its own fields are the spec pass state. */
class WebGpuRenderPassEncoder extends WebGpuRenderCommands implements RhiRenderPassEncoder {
  ended = false;
  // [[occlusion_query_active]] (research §2.1): true when a beginOcclusionQuery
  // has been issued without a matching endOcclusionQuery yet. Spec normative:
  // pairs cannot nest.
  private occlusionQueryActive = false;
  // Query indices written in this pass (spec §queries); allocated on first use.
  private occlusionQueryWritten: Set<number> | undefined;

  constructor(
    private readonly renderPass: GPURenderPassEncoder,
    private readonly encoder: RhiCommandEncoder,
    // [[occlusion_query_set]] (research §2.1): the QuerySet injected via
    // GPURenderPassDescriptor.occlusionQuerySet at beginRenderPass time.
    // null means occlusion queries are unavailable in this pass.
    private readonly occlusionQuerySet: QuerySet | null,
  ) {
    super(renderPass, PASS_LANE, commandReferences(encoder));
  }

  setViewport(
    x: number,
    y: number,
    w: number,
    h: number,
    minDepth: number,
    maxDepth: number,
  ): void {
    this.renderPass.setViewport(x, y, w, h, minDepth, maxDepth);
  }

  setScissorRect(x: number, y: number, w: number, h: number): void {
    this.renderPass.setScissorRect(x, y, w, h);
  }

  setBlendConstant(color: GPUColor): void {
    this.renderPass.setBlendConstant(color);
  }

  setStencilReference(reference: number): void {
    this.renderPass.setStencilReference(reference);
  }

  executeBundles(bundles: Iterable<RenderBundle>): Result<void, RhiError> {
    try {
      const rawBundles = Array.from(bundles, (bundle) => bundle as unknown as GPURenderBundle);
      this.renderPass.executeBundles(rawBundles);
      for (const bundle of rawBundles) this.references.add(bundle);
      COMMAND_COUNTS.bundlesExecuted += rawBundles.length;
      return ok(undefined);
    } catch (cause) {
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected: 'compatible render bundles from this device in an open render pass',
          hint: String(cause),
        }),
      );
    }
  }

  beginOcclusionQuery(queryIndex: number): Result<void, RhiError> {
    // Step 1 (research §2.1): [[occlusion_query_set]] != null.
    if (this.occlusionQuerySet === null) {
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected: 'GPURenderPassDescriptor.occlusionQuerySet must be set',
          hint: 'pass occlusionQuerySet in RenderPassDescriptor before beginOcclusionQuery',
        }),
      );
    }
    // Step 4 (research §2.1): [[occlusion_query_active]] == false (no nesting).
    // K-2: nested begin maps to webgpu-runtime-error (NOT a new code).
    if (this.occlusionQueryActive) {
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected:
            '[[occlusion_query_active]] == false; pair beginOcclusionQuery / endOcclusionQuery',
          hint: 'call endOcclusionQuery() before beginOcclusionQuery() again; occlusion queries cannot nest (spec §render-passes)',
        }),
      );
    }
    // Step 2 (research §2.1): queryIndex < querySet.count.
    const rawQs = QUERY_SET_RAW_MAP.get(this.occlusionQuerySet);
    const qsCount =
      rawQs !== undefined && typeof rawQs.count === 'number'
        ? rawQs.count
        : Number.MAX_SAFE_INTEGER;
    if (queryIndex < 0 || queryIndex >= qsCount) {
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected: 'queryIndex < querySet.count',
          hint: `got queryIndex=${queryIndex}; querySet.count=${qsCount}`,
        }),
      );
    }
    // Step 3 (research §2.1): queryIndex not yet written in this pass.
    // Cross-pass reuse on the same querySet is legal (dawn `Rewrite` mode).
    if (this.occlusionQueryWritten?.has(queryIndex) === true) {
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected: 'queryIndex must not have been written in this pass',
          hint: `queryIndex=${queryIndex} was already written; cross-pass reuse on the same querySet is legal but in-pass reuse is not (spec §queries)`,
        }),
      );
    }
    try {
      this.renderPass.beginOcclusionQuery(queryIndex);
      this.occlusionQueryActive = true;
      this.occlusionQueryWritten ??= new Set<number>();
      this.occlusionQueryWritten.add(queryIndex);
      return ok(undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected: 'underlying GPURenderPassEncoder.beginOcclusionQuery to succeed',
          hint: `beginOcclusionQuery raised: ${message}`,
        }),
      );
    }
  }

  endOcclusionQuery(): Result<void, RhiError> {
    // Spec normative (research §2.1): [[occlusion_query_active]] must be true.
    // K-2: end without active begin maps to render-pass-not-ended (existing
    // 14-member union).
    if (!this.occlusionQueryActive) {
      return err(renderPassNotEnded());
    }
    try {
      this.renderPass.endOcclusionQuery();
      this.occlusionQueryActive = false;
      return ok(undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected: 'underlying GPURenderPassEncoder.endOcclusionQuery to succeed',
          hint: `endOcclusionQuery raised: ${message}`,
        }),
      );
    }
  }

  end(): void {
    this.ended = true;
    this.renderPass.end();
    // Clear active-pass tracking on the owning encoder.
    const encState = ENCODER_STATE.get(this.encoder);
    if (encState !== undefined && encState.activePass === this) {
      encState.activePass = null;
    }
  }
}

class WebGpuRenderBundleEncoder extends WebGpuRenderCommands implements RhiRenderBundleEncoder {
  private finished = false;

  constructor(private readonly bundle: GPURenderBundleEncoder) {
    super(bundle, BUNDLE_LANE);
  }

  finish(descriptor?: RenderBundleDescriptor | undefined): Result<RenderBundle, RhiError> {
    if (this.finished) return err(commandEncoderFinished('render bundle'));
    this.finished = true;
    try {
      const bundle = this.bundle.finish(descriptor as GPURenderBundleDescriptor);
      COMMAND_REFERENCES.set(bundle, this.references);
      return ok(bundle as unknown as RenderBundle);
    } catch (cause) {
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected: 'a valid render bundle command sequence',
          hint: String(cause),
        }),
      );
    }
  }
}

class WebGpuComputePassEncoder implements RhiComputePassEncoder {
  constructor(
    private readonly rawPass: GPUComputePassEncoder,
    private readonly references: Set<object>,
  ) {}

  setPipeline(pipeline: ComputePipeline): void {
    COMMAND_COUNTS.pipelineSets++;
    this.references.add(pipeline);
    this.rawPass.setPipeline(pipeline as unknown as GPUComputePipeline);
  }

  setBindGroup(
    index: number,
    bindGroup: BindGroup,
    dynamicOffsets?: readonly number[] | undefined,
  ): void {
    COMMAND_COUNTS.bindGroupSets++;
    if (dynamicOffsets === undefined) {
      this.rawPass.setBindGroup(index, bindGroup as unknown as GPUBindGroup);
    } else {
      this.rawPass.setBindGroup(index, bindGroup as unknown as GPUBindGroup, dynamicOffsets);
    }
  }

  dispatchWorkgroups(x: number, y?: number | undefined, z?: number | undefined): void {
    COMMAND_COUNTS.dispatches++;
    this.rawPass.dispatchWorkgroups(x, y, z);
  }

  dispatchWorkgroupsIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    COMMAND_COUNTS.dispatches++;
    const rawBuffer =
      BUFFER_RAW_MAP.get(indirectBuffer) ?? (indirectBuffer as unknown as GPUBuffer);
    this.rawPass.dispatchWorkgroupsIndirect(rawBuffer, indirectOffset);
  }

  end(): void {
    this.rawPass.end();
  }
}

function throwIfFinished(state: EncoderState | undefined): void {
  if (state?.finished) {
    throw commandEncoderFinished();
  }
}

function rawTextureView(view: TextureView): GPUTextureView {
  return TEXTURE_VIEW_RAW_MAP.get(view) ?? (view as unknown as GPUTextureView);
}

function mirrorRenderPassDescriptor(desc: RenderPassDescriptor): GPURenderPassDescriptor {
  // Optional members are assigned rather than spread: this runs for every
  // render pass of every frame, and each spread allocates a temporary object.
  const colorAttachments: Array<GPURenderPassColorAttachment | null> = [];
  for (const attachment of desc.colorAttachments) {
    if (attachment === null || attachment === undefined) {
      colorAttachments.push(null);
      continue;
    }
    if (attachment.loadOp === undefined || attachment.storeOp === undefined) {
      throw new TypeError('RHI render-pass color attachments require loadOp and storeOp');
    }
    const color: GPURenderPassColorAttachment = {
      view: rawTextureView(attachment.view),
      loadOp: attachment.loadOp,
      storeOp: attachment.storeOp,
    };
    if (attachment.depthSlice !== undefined) color.depthSlice = attachment.depthSlice;
    if (attachment.resolveTarget !== undefined)
      color.resolveTarget = rawTextureView(attachment.resolveTarget);
    if (attachment.clearValue !== undefined) color.clearValue = attachment.clearValue;
    colorAttachments.push(color);
  }

  const out: GPURenderPassDescriptor = { colorAttachments };
  if (desc.label !== undefined) out.label = desc.label;
  const depth = desc.depthStencilAttachment;
  if (depth !== undefined) {
    const raw: GPURenderPassDepthStencilAttachment = { view: rawTextureView(depth.view) };
    if (depth.depthClearValue !== undefined) raw.depthClearValue = depth.depthClearValue;
    if (depth.depthLoadOp !== undefined) raw.depthLoadOp = depth.depthLoadOp;
    if (depth.depthStoreOp !== undefined) raw.depthStoreOp = depth.depthStoreOp;
    if (depth.depthReadOnly !== undefined) raw.depthReadOnly = depth.depthReadOnly;
    if (depth.stencilClearValue !== undefined) raw.stencilClearValue = depth.stencilClearValue;
    if (depth.stencilLoadOp !== undefined) raw.stencilLoadOp = depth.stencilLoadOp;
    if (depth.stencilStoreOp !== undefined) raw.stencilStoreOp = depth.stencilStoreOp;
    if (depth.stencilReadOnly !== undefined) raw.stencilReadOnly = depth.stencilReadOnly;
    out.depthStencilAttachment = raw;
  }
  if (desc.occlusionQuerySet !== undefined)
    out.occlusionQuerySet =
      QUERY_SET_RAW_MAP.get(desc.occlusionQuerySet) ??
      (desc.occlusionQuerySet as unknown as GPUQuerySet);
  const writes = desc.timestampWrites;
  if (writes !== undefined) {
    const raw: GPURenderPassTimestampWrites = {
      querySet:
        QUERY_SET_RAW_MAP.get(writes.querySet) ?? (writes.querySet as unknown as GPUQuerySet),
    };
    if (writes.beginningOfPassWriteIndex !== undefined)
      raw.beginningOfPassWriteIndex = writes.beginningOfPassWriteIndex;
    if (writes.endOfPassWriteIndex !== undefined)
      raw.endOfPassWriteIndex = writes.endOfPassWriteIndex;
    out.timestampWrites = raw;
  }
  if (desc.maxDrawCount !== undefined) out.maxDrawCount = desc.maxDrawCount;
  return out;
}

function mirrorRenderPipelineDescriptor(
  desc: RenderPipelineDescriptor,
): GPURenderPipelineDescriptor {
  const vertex: GPUVertexState = {
    module: desc.vertex.module as unknown as GPUShaderModule,
    ...(desc.vertex.buffers === undefined ? {} : { buffers: Array.from(desc.vertex.buffers) }),
    ...(desc.vertex.entryPoint === undefined ? {} : { entryPoint: desc.vertex.entryPoint }),
    ...(desc.vertex.constants === undefined ? {} : { constants: desc.vertex.constants }),
  };
  const fragment: GPUFragmentState | undefined =
    desc.fragment === undefined
      ? undefined
      : {
          module: desc.fragment.module as unknown as GPUShaderModule,
          targets: Array.from(desc.fragment.targets),
          ...(desc.fragment.entryPoint === undefined
            ? {}
            : { entryPoint: desc.fragment.entryPoint }),
          ...(desc.fragment.constants === undefined ? {} : { constants: desc.fragment.constants }),
        };
  return {
    ...(desc.label === undefined ? {} : { label: desc.label }),
    layout: desc.layout === 'auto' ? 'auto' : (desc.layout as unknown as GPUPipelineLayout),
    vertex,
    ...(desc.primitive === undefined ? {} : { primitive: desc.primitive }),
    ...(desc.depthStencil === undefined ? {} : { depthStencil: desc.depthStencil }),
    ...(desc.multisample === undefined ? {} : { multisample: desc.multisample }),
    ...(fragment === undefined ? {} : { fragment }),
  };
}

function mirrorComputePassDescriptor(
  desc: ComputePassDescriptor | undefined,
): GPUComputePassDescriptor | undefined {
  if (desc === undefined) return undefined;
  const out: MirrorOut = {};
  if ('label' in desc) out.label = desc.label;
  if ('timestampWrites' in desc) {
    const writes = desc.timestampWrites;
    out.timestampWrites =
      writes === undefined
        ? undefined
        : {
            querySet:
              QUERY_SET_RAW_MAP.get(writes.querySet) ?? (writes.querySet as unknown as GPUQuerySet),
            ...(writes.beginningOfPassWriteIndex === undefined
              ? {}
              : { beginningOfPassWriteIndex: writes.beginningOfPassWriteIndex }),
            ...(writes.endOfPassWriteIndex === undefined
              ? {}
              : { endOfPassWriteIndex: writes.endOfPassWriteIndex }),
          };
  }
  return out as unknown as GPUComputePassDescriptor;
}

/**
 * Build a RhiCommandEncoder around a raw GPUCommandEncoder (w3).
 *
 * Lifecycle:
 *   - finish() flips finished=true and returns CommandBuffer once.
 *   - subsequent recording calls (beginRenderPass / copyXxx / clearBuffer /
 *     finish itself) return Result.err({ code: 'command-encoder-finished' })
 *     for those methods that return Result; the void-returning methods throw
 *     the structured error so AI users observe the failure (charter
 *     proposition 4 explicit failure).
 *   - render-pass-not-ended is detected by tracking activePass; finish()
 *     while a pass has not been end()-ed returns the structured error.
 */
class WebGpuCommandEncoder implements RhiCommandEncoder {
  readonly #rawEncoder: GPUCommandEncoder;
  readonly #accelerationStructures: WebGpuAccelerationStructures;
  constructor(rawEncoder: GPUCommandEncoder, accelerationStructures: WebGpuAccelerationStructures) {
    this.#rawEncoder = rawEncoder;
    this.#accelerationStructures = accelerationStructures;
    ENCODER_STATE.set(this, { raw: rawEncoder, finished: false, activePass: null });
  }
  buildAccelerationStructures(
    blas: Parameters<RhiCommandEncoder['buildAccelerationStructures']>[0],
    tlas: Parameters<RhiCommandEncoder['buildAccelerationStructures']>[1],
  ) {
    throwIfFinished(ENCODER_STATE.get(this));
    return this.#accelerationStructures.build(this.#rawEncoder, blas, tlas);
  }
  beginRenderPass(desc: RenderPassDescriptor): RhiRenderPassEncoder {
    const state = ENCODER_STATE.get(this);
    throwIfFinished(state);
    const rawPass = this.#rawEncoder.beginRenderPass(mirrorRenderPassDescriptor(desc));
    COMMAND_COUNTS.renderPasses++;
    // Extract occlusionQuerySet from the descriptor (research §2.2:
    // RPDesc.occlusionQuerySet is the injection point; the render pass
    // PassState.[[occlusion_query_set]] mirrors it). The forgeax
    // RenderPassDescriptor declares occlusionQuerySet as `QuerySet |
    // undefined`; the raw GPU descriptor is structurally compatible.
    const occlusionQuerySet = desc.occlusionQuerySet ?? null;
    const pass = new WebGpuRenderPassEncoder(rawPass, this, occlusionQuerySet);
    if (state !== undefined) state.activePass = pass;
    return pass;
  }
  beginComputePass(desc?: ComputePassDescriptor | undefined): RhiComputePassEncoder {
    const state = ENCODER_STATE.get(this);
    throwIfFinished(state);
    const rawDescriptor = mirrorComputePassDescriptor(desc);
    const rawPass =
      rawDescriptor === undefined
        ? this.#rawEncoder.beginComputePass()
        : this.#rawEncoder.beginComputePass(rawDescriptor);
    COMMAND_COUNTS.computePasses++;
    return new WebGpuComputePassEncoder(rawPass, commandReferences(this));
  }
  encodeEmptyComputePass(desc: ComputePassDescriptor): void {
    const state = ENCODER_STATE.get(this);
    throwIfFinished(state);
    const rawPass = this.#rawEncoder.beginComputePass(mirrorComputePassDescriptor(desc));
    rawPass.end();
  }
  copyBufferToBuffer(
    source: Buffer,
    arg2: number | Buffer,
    arg3?: Buffer | number | undefined,
    arg4?: number | undefined,
    arg5?: number | undefined,
  ): void {
    const state = ENCODER_STATE.get(this);
    throwIfFinished(state);
    // M5 / w35: the forgeax Buffer is a wrapper (not the raw GPUBuffer);
    // resolve through BUFFER_RAW_MAP before delegating.
    const rawSource = BUFFER_RAW_MAP.get(source) ?? (source as unknown as GPUBuffer);
    // Two overloads (research F-1):
    //   (a) (src, dst, size?)                        - 3-arg shorthand
    //   (b) (src, srcOffset, dst, dstOffset, size)   - 5-arg full form
    if (typeof arg2 === 'number') {
      // 5-arg form
      const dst = arg3 as Buffer;
      const rawDst = BUFFER_RAW_MAP.get(dst) ?? (dst as unknown as GPUBuffer);
      this.#rawEncoder.copyBufferToBuffer(rawSource, arg2, rawDst, arg4 ?? 0, arg5 ?? 0);
    } else {
      // 3-arg shorthand
      const dst = arg2 as Buffer;
      const rawDst = BUFFER_RAW_MAP.get(dst) ?? (dst as unknown as GPUBuffer);
      this.#rawEncoder.copyBufferToBuffer(rawSource, rawDst, arg3 as number | undefined);
    }
  }
  copyBufferToTexture(
    source: TexelCopyBufferInfo,
    destination: TexelCopyTextureInfo,
    copySize: GPUExtent3DStrict,
  ): void {
    const state = ENCODER_STATE.get(this);
    throwIfFinished(state);
    const rawSrc = {
      ...source,
      buffer: BUFFER_RAW_MAP.get(source.buffer) ?? (source.buffer as unknown as GPUBuffer),
    };
    this.#rawEncoder.copyBufferToTexture(rawSrc, rawTextureCopy(destination), copySize);
  }
  copyTextureToBuffer(
    source: TexelCopyTextureInfo,
    destination: TexelCopyBufferInfo,
    copySize: GPUExtent3DStrict,
  ): void {
    const state = ENCODER_STATE.get(this);
    throwIfFinished(state);
    const rawSource = rawTextureCopy(source);
    const rawDst: GPUTexelCopyBufferInfo = {
      buffer:
        BUFFER_RAW_MAP.get(destination.buffer) ?? (destination.buffer as unknown as GPUBuffer),
    };
    if (destination.offset !== undefined) rawDst.offset = destination.offset;
    if (destination.bytesPerRow !== undefined) rawDst.bytesPerRow = destination.bytesPerRow;
    if (destination.rowsPerImage !== undefined) rawDst.rowsPerImage = destination.rowsPerImage;
    this.#rawEncoder.copyTextureToBuffer(rawSource, rawDst, copySize);
  }
  copyTextureToTexture(
    source: TexelCopyTextureInfo,
    destination: TexelCopyTextureInfo,
    copySize: GPUExtent3DStrict,
  ): void {
    const state = ENCODER_STATE.get(this);
    throwIfFinished(state);
    this.#rawEncoder.copyTextureToTexture(
      rawTextureCopy(source),
      rawTextureCopy(destination),
      copySize,
    );
  }
  clearBuffer(buffer: Buffer, offset?: number | undefined, size?: number | undefined): void {
    const state = ENCODER_STATE.get(this);
    throwIfFinished(state);
    // M5 / w35: resolve forgeax Buffer wrapper to raw GPUBuffer.
    const rawBuf = BUFFER_RAW_MAP.get(buffer) ?? (buffer as unknown as GPUBuffer);
    this.#rawEncoder.clearBuffer(rawBuf, offset, size);
  }
  resolveQuerySet(
    querySet: QuerySet,
    firstQuery: number,
    queryCount: number,
    destination: Buffer,
    destinationOffset: number,
  ): Result<void, RhiError> {
    const state = ENCODER_STATE.get(this);
    if (state?.finished) {
      return err(commandEncoderFinished());
    }
    // Step 6 (research §2.3): destinationOffset is a multiple of 256.
    // K-2: alignment violation maps to webgpu-runtime-error.
    if (destinationOffset % QUERY_RESOLVE_ALIGNMENT !== 0) {
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected: 'destinationOffset % 256 == 0 (spec normative)',
          hint: `got destinationOffset=${destinationOffset}; align to a multiple of 256 bytes (kQueryResolveAlignment)`,
        }),
      );
    }
    // Step 3 (research §2.3): destination.usage contains QUERY_RESOLVE.
    const dstMeta = BUFFER_META_MAP.get(destination);
    if (dstMeta !== undefined && (dstMeta.usage & BUFFER_USAGE_QUERY_RESOLVE) === 0) {
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected: 'destination.usage must contain QUERY_RESOLVE',
          hint: `got destination.usage=0x${dstMeta.usage.toString(16)}; create the buffer with GPUBufferUsage.QUERY_RESOLVE (0x200)`,
        }),
      );
    }
    // Steps 4 + 5 (research §2.3): firstQuery + queryCount <= querySet.count
    // (which subsumes firstQuery < count as a derived constraint).
    const rawQs = QUERY_SET_RAW_MAP.get(querySet);
    const qsCount =
      rawQs !== undefined && typeof rawQs.count === 'number'
        ? rawQs.count
        : Number.MAX_SAFE_INTEGER;
    if (firstQuery < 0 || firstQuery + queryCount > qsCount) {
      return err(
        new RhiErrorClass({
          code: 'webgpu-runtime-error',
          expected: 'firstQuery + queryCount <= querySet.count',
          hint: `got firstQuery=${firstQuery}, queryCount=${queryCount}; querySet.count=${qsCount}`,
        }),
      );
    }
    // Step 7 (research §2.3): destinationOffset + 8 * queryCount <= dst.size.
    if (dstMeta !== undefined) {
      const requiredBytes = destinationOffset + 8 * queryCount;
      if (requiredBytes > dstMeta.size) {
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'destinationOffset + 8 * queryCount <= destination.size',
            hint: `got destinationOffset=${destinationOffset}, queryCount=${queryCount} (8 * queryCount = ${8 * queryCount}); destination.size=${dstMeta.size}`,
          }),
        );
      }
    }
    const rawQsHandle = QUERY_SET_RAW_MAP.get(querySet) ?? (querySet as unknown as GPUQuerySet);
    const rawDstHandle = BUFFER_RAW_MAP.get(destination) ?? (destination as unknown as GPUBuffer);
    return resolveTimestampQueries({
      rawEncoder: this.#rawEncoder,
      rawQuerySet: rawQsHandle,
      firstQuery,
      queryCount,
      rawDestination: rawDstHandle,
      destinationOffset,
    });
  }
  pushDebugGroup(groupLabel: string): void {
    this.#rawEncoder.pushDebugGroup(groupLabel);
  }
  popDebugGroup(): void {
    this.#rawEncoder.popDebugGroup();
  }
  insertDebugMarker(markerLabel: string): void {
    this.#rawEncoder.insertDebugMarker(markerLabel);
  }
  finish(): Result<CommandBuffer, RhiError> {
    const state = ENCODER_STATE.get(this);
    if (state === undefined) {
      // Should not happen in practice; treat as a finished encoder.
      return err(commandEncoderFinished());
    }
    if (state.finished) {
      return err(commandEncoderFinished());
    }
    if (state.activePass !== null && !state.activePass.ended) {
      return err(renderPassNotEnded());
    }
    const rawCommandBuffer = this.#rawEncoder.finish();
    state.finished = true;
    const cb = rawCommandBuffer as unknown as CommandBuffer;
    COMMAND_BUFFER_RAW_MAP.set(cb, rawCommandBuffer);
    COMMAND_REFERENCES.set(cb, commandReferences(this));
    return ok(cb);
  }
}

// ============================================================================
// M5 / w35 - Buffer wrapper (mapAsync / getMappedRange / unmap / mapState).
// ============================================================================
//
// research §4.1 mapState 3-state enum + §4.2 mapAsync 8-validation +
// §4.4 unmap detach. K-1 decision: mode is the raw GPUMapMode bitmask.
// K-2 decision: alignment / mode-usage / detach faults all ride
// 'webgpu-runtime-error' with structured .expected / .hint per F-3
// ai-user-review carry-over.

/** Spec normative GPUMapMode bits (research §4.2 step 7). */
const MAP_MODE_READ = 0x1;
const MAP_MODE_WRITE = 0x2;
/** GPUBufferUsage MAP_READ / MAP_WRITE bits (research §4.2 step 9 / F-8 row 3). */
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_MAP_WRITE = 0x0002;

function rangeError(args: { expected: string; hint: string }): Result<never, RhiError> {
  return err(
    new RhiErrorClass({
      code: 'webgpu-runtime-error',
      expected: args.expected,
      hint: args.hint,
    }),
  );
}

/**
 * Build a forgeax Buffer wrapper around a raw GPUBuffer (w35).
 *
 * The wrapper exposes the brand-only Buffer interface plus the M5 mapping
 * surface (mapAsync / getMappedRange / unmap + mapState getter).
 *
 * Validation policy (K-2 + research §4.2 + F-8 three rows):
 *   - mapAsync rejects on 8 spec validation steps + F-8 row 1/3 with
 *     'webgpu-runtime-error' before delegating to raw mapAsync. The raw
 *     mapAsync may still reject (driver-level validation); the shim wraps
 *     such rejections via 'webgpu-runtime-error' carrying the underlying
 *     message in .hint.
 *   - getMappedRange rejects with 'webgpu-runtime-error' when mapState !==
 *     'mapped' (F-8 row 2 detach guard) before delegating.
 *   - unmap is silent (spec normative). Mapping state is read directly from
 *     the native GPUBuffer, including pending, unmap and destroy transitions.
 */
function makeBufferWrapper(raw: GPUBuffer, size: number, usage: GPUBufferUsageFlags): Buffer {
  const wrapper = {
    get mapState(): Buffer['mapState'] {
      return raw.mapState;
    },
    async mapAsync(
      mode: GPUMapModeFlags,
      offset?: number | undefined,
      sizeArg?: number | undefined,
    ): Promise<Result<MappedBuffer, RhiError>> {
      // F-8 row 1: mapState must be 'unmapped' (research §4.2 step 1).
      const cur = wrapper.mapState;
      if (cur !== 'unmapped') {
        return rangeError({
          expected: 'buffer.mapState === "unmapped" before mapAsync',
          hint: `got mapState=${cur}; call buffer.unmap() before mapAsync, or wait for the previous mapAsync to settle`,
        });
      }
      const off = offset ?? 0;
      const rangeSize = sizeArg === undefined ? Math.max(0, size - off) : sizeArg;
      // step 4: offset % 8 == 0
      if (off % 8 !== 0) {
        return rangeError({
          expected: 'mapAsync offset % 8 == 0 (spec normative)',
          hint: `got offset=${off}; align offset to 8 bytes`,
        });
      }
      // step 5: rangeSize % 4 == 0
      if (rangeSize % 4 !== 0) {
        return rangeError({
          expected: 'mapAsync rangeSize % 4 == 0 (spec normative)',
          hint: `got rangeSize=${rangeSize}; align rangeSize to 4 bytes`,
        });
      }
      // step 6: offset + rangeSize <= size
      if (off + rangeSize > size) {
        return rangeError({
          expected: 'mapAsync offset + rangeSize <= buffer.size',
          hint: `got offset=${off}, rangeSize=${rangeSize}; buffer.size=${size}`,
        });
      }
      // step 7: mode contains only allowed bits
      const allowed = MAP_MODE_READ | MAP_MODE_WRITE;
      if ((mode & ~allowed) !== 0) {
        return rangeError({
          expected: 'mapAsync mode contains only READ or WRITE bits',
          hint: `got mode=0x${mode.toString(16)}; pass GPUMapMode.READ (0x1) or GPUMapMode.WRITE (0x2)`,
        });
      }
      // step 8: mode is exactly READ or WRITE (not both)
      if (mode !== MAP_MODE_READ && mode !== MAP_MODE_WRITE) {
        return rangeError({
          expected: 'mapAsync mode is exactly one of READ | WRITE (not both)',
          hint: `got mode=0x${mode.toString(16)}; pass GPUMapMode.READ (0x1) or GPUMapMode.WRITE (0x2), not the OR-combined mask`,
        });
      }
      // step 9: mode-usage cross-check (F-8 row 3)
      if ((mode & MAP_MODE_READ) !== 0 && (usage & BUFFER_USAGE_MAP_READ) === 0) {
        return rangeError({
          expected: 'mapAsync mode READ requires buffer.usage to contain MAP_READ',
          hint: `got mode=READ, buffer.usage=0x${usage.toString(16)}; create buffer with GPUBufferUsage.MAP_READ`,
        });
      }
      if ((mode & MAP_MODE_WRITE) !== 0 && (usage & BUFFER_USAGE_MAP_WRITE) === 0) {
        return rangeError({
          expected: 'mapAsync mode WRITE requires buffer.usage to contain MAP_WRITE',
          hint: `got mode=WRITE, buffer.usage=0x${usage.toString(16)}; create buffer with GPUBufferUsage.MAP_WRITE`,
        });
      }
      // Delegate to raw GPUBuffer; raw rejection wraps as webgpu-runtime-error.
      try {
        if (sizeArg === undefined && offset === undefined) {
          await raw.mapAsync(mode);
        } else if (sizeArg === undefined) {
          await raw.mapAsync(mode, off);
        } else {
          await raw.mapAsync(mode, off, sizeArg);
        }
        // D-P2 #6: the structural wrapper carries both Buffer + MappedBuffer
        // members; on the success path we surface the same JS object typed as
        // the branded MappedBuffer (charter proposition 5: brand is structural,
        // no runtime cost).
        return ok(wrapper as unknown as MappedBuffer);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return rangeError({
          expected: 'underlying GPUBuffer.mapAsync to succeed',
          hint: `mapAsync raised: ${message}`,
        });
      }
    },
    getMappedRange(
      offset?: number | undefined,
      sizeArg?: number | undefined,
    ): Result<ArrayBuffer, RhiError> {
      // F-8 row 2 detach guard: mapState must be 'mapped'.
      const cur = wrapper.mapState;
      if (cur !== 'mapped') {
        return rangeError({
          expected: 'buffer.mapState === "mapped" before getMappedRange',
          hint: 'call buffer.mapAsync(MODE) and await it before getMappedRange',
        });
      }
      try {
        if (typeof raw.getMappedRange !== 'function') {
          return rangeError({
            expected: 'underlying GPUBuffer.getMappedRange to be available',
            hint: 'mock or driver does not expose getMappedRange; use a real GPUBuffer',
          });
        }
        const view =
          sizeArg === undefined
            ? offset === undefined
              ? raw.getMappedRange()
              : raw.getMappedRange(offset)
            : raw.getMappedRange(offset ?? 0, sizeArg);
        return ok(view);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return rangeError({
          expected: 'underlying GPUBuffer.getMappedRange to succeed',
          hint: `getMappedRange raised: ${message}`,
        });
      }
    },
    unmap(): void {
      // Spec normative silent no-op (research §4.4): unmap on a destroyed or
      // already-unmapped buffer must NOT throw / return an error.
      try {
        if (typeof raw.unmap === 'function') {
          raw.unmap();
        }
      } catch {
        // swallow per spec; the forgeax form does not surface unmap failures.
      }
    },
  } as unknown as Buffer;
  return wrapper;
}

/**
 * Build a RhiQueue around a raw GPUQueue (w6).
 *
 * Real-path implementation:
 *   - submit forwards to rawQueue.submit; failures (validation / destroyed
 *     resource references) wrap to 'queue-submit-failed' (D-S3 #3).
 *   - writeBuffer validates offset alignment + bounds before forwarding;
 *     out-of-bounds writes return 'queue-write-buffer-out-of-bounds' (D-S3 #4).
 */
function makeQueue(rawQueue: GPUQueue): RhiQueue {
  const completions = createQueueCompletionHold();
  const inFlight = new Set<CommandBuffer[]>();
  let completion: Promise<undefined> | undefined;
  const nativeCompletion = () => (completion ??= rawQueue.onSubmittedWorkDone());
  return {
    writeBuffer(
      buffer: Buffer,
      bufferOffset: number,
      data: ArrayBufferView | ArrayBuffer,
      dataOffset?: number | undefined,
      size?: number | undefined,
    ): Result<void, RhiError> {
      completion = undefined;
      const rawBuffer = BUFFER_RAW_MAP.get(buffer) ?? (buffer as unknown as GPUBuffer);
      const bufferSize =
        typeof (rawBuffer as { size?: number }).size === 'number'
          ? (rawBuffer as { size: number }).size
          : Number.MAX_SAFE_INTEGER;
      // 4-byte alignment validation (W3C WebGPU 23.2 writeBuffer).
      if (bufferOffset % 4 !== 0) {
        return err(
          queueWriteBufferOutOfBounds({
            offset: bufferOffset,
            byteLength:
              data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength,
            bufferSize,
          }),
        );
      }
      const dataByteLength =
        data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;
      const writeStart = dataOffset ?? 0;
      const writeSize = size ?? dataByteLength - writeStart;
      // Bounds validation: bufferOffset + writeSize <= bufferSize.
      if (bufferOffset + writeSize > bufferSize) {
        return err(
          queueWriteBufferOutOfBounds({
            offset: bufferOffset,
            byteLength: writeSize,
            bufferSize,
          }),
        );
      }
      try {
        if (size !== undefined) {
          rawQueue.writeBuffer(
            rawBuffer,
            bufferOffset,
            data as GPUAllowSharedBufferSource,
            writeStart,
            size,
          );
        } else if (dataOffset !== undefined) {
          rawQueue.writeBuffer(
            rawBuffer,
            bufferOffset,
            data as GPUAllowSharedBufferSource,
            writeStart,
          );
        } else {
          rawQueue.writeBuffer(rawBuffer, bufferOffset, data as GPUAllowSharedBufferSource);
        }
        COMMAND_COUNTS.bufferWrites++;
        COMMAND_COUNTS.bufferWriteBytes += writeSize;
        return ok(undefined);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // GPU validation may surface bounds errors; wrap as out-of-bounds for
        // AI-user routing parity (charter proposition 4 explicit failure).
        if (/out of (bounds|range)|exceed/i.test(message)) {
          return err(
            queueWriteBufferOutOfBounds({
              offset: bufferOffset,
              byteLength: writeSize,
              bufferSize,
            }),
          );
        }
        return err(queueSubmitFailed(message));
      }
    },
    submit(commandBuffers: readonly CommandBuffer[]): Result<void, RhiError> {
      const rawList: GPUCommandBuffer[] = [];
      for (const cb of commandBuffers) {
        const raw = COMMAND_BUFFER_RAW_MAP.get(cb);
        if (raw !== undefined) {
          rawList.push(raw);
        } else {
          rawList.push(cb as unknown as GPUCommandBuffer);
        }
      }
      try {
        completion = undefined;
        rawQueue.submit(rawList);
        // Pin the owning buffers: their WeakMap entries already retain the full dependency closure.
        const references: CommandBuffer[] = [];
        for (const cb of commandBuffers) {
          const dependencies = COMMAND_REFERENCES.get(cb);
          if (dependencies !== undefined && dependencies.size > 0) references.push(cb);
        }
        if (references.length > 0 && typeof rawQueue.onSubmittedWorkDone === 'function') {
          inFlight.add(references);
          const release = () => {
            inFlight.delete(references);
            references.length = 0;
          };
          void nativeCompletion().then(release, release);
        }
        COMMAND_COUNTS.submits++;
        return ok(undefined);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(queueSubmitFailed(message));
      }
    },
    writeTexture(
      destination: TexelCopyTextureInfo,
      data: ArrayBufferView | ArrayBuffer,
      dataLayout: GPUTexelCopyBufferLayout,
      size: GPUExtent3DStrict,
    ): Result<void, RhiError> {
      // writeTexture calls validating texture buffer copy(..., aligned=false)
      // per WebGPU spec §19.2 GPUQueue.writeTexture, which explicitly notes
      // "unlike copyBufferToTexture, there is no alignment requirement on
      // either dataLayout.bytesPerRow or dataLayout.offset."
      // The 256-byte alignment lives in §11.2.2 validating GPUTexelCopyBufferInfo,
      // called only by copyBufferToTexture / copyTextureToBuffer where the source
      // is a GPUBuffer. The lower bound bytesPerRow >= widthInBlocks * blockSize
      // is enforced by dawn / WebGPU via §11.2.6 validating linear texture data
      // and surfaces as webgpu-runtime-error through the try/catch below.
      try {
        // The destination.texture is a forgeax Texture brand; the shim stored
        // the raw GPUTexture as the brand carrier in createTexture. Spec
        // structural compatibility lets us forward verbatim with a cast.
        // The data + size casts cover @webgpu/types polymorphism that the
        // forgeax form normalises to the strict spec subset.
        completion = undefined;
        rawQueue.writeTexture(
          rawTextureCopy(destination),
          data as unknown as GPUAllowSharedBufferSource,
          dataLayout,
          size as unknown as GPUExtent3D,
        );
        COMMAND_COUNTS.textureWrites++;
        COMMAND_COUNTS.textureWriteBytes += data.byteLength - (dataLayout.offset ?? 0);
        return ok(undefined);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'underlying GPUQueue.writeTexture to succeed',
            hint: `writeTexture raised: ${message}`,
          }),
        );
      }
    },
    copyExternalImageToTexture(
      source: GPUCopyExternalImageSourceInfo,
      destination: ExternalImageTextureDestination,
      copySize: GPUExtent3DStrict,
    ): Result<void, RhiError> {
      try {
        completion = undefined;
        rawQueue.copyExternalImageToTexture(
          source,
          {
            texture: destination.texture as unknown as GPUTexture,
            ...(destination.mipLevel === undefined ? {} : { mipLevel: destination.mipLevel }),
            ...(destination.origin === undefined ? {} : { origin: destination.origin }),
            ...(destination.aspect === undefined ? {} : { aspect: destination.aspect }),
            ...(destination.colorSpace === undefined ? {} : { colorSpace: destination.colorSpace }),
            ...(destination.premultipliedAlpha === undefined
              ? {}
              : { premultipliedAlpha: destination.premultipliedAlpha }),
          },
          copySize,
        );
        return ok(undefined);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'underlying GPUQueue.copyExternalImageToTexture to succeed',
            hint: `copyExternalImageToTexture raised: ${message}`,
          }),
        );
      }
    },
    // forgeax-async-whitelist: dom-native — spec `GPUQueue.onSubmittedWorkDone()` Promise passthrough
    onSubmittedWorkDone(): Promise<undefined> {
      // research §5.1 spec normative: no reject path; the forgeax
      // Promise<undefined> matches the spec shape (no Result wrapping;
      // device-lost flows through RhiDevice.lost). Delivery waits only while
      // a holdCompletions() hold is open; FIFO order is preserved.
      return completions.deliver(nativeCompletion());
    },
    holdCompletions(): () => void {
      return completions.hold();
    },
    // forgeax-async-whitelist: dom-native — spec `GPUQueue.onSubmittedWorkDone()` Promise passthrough
    onSubmittedWorkDoneUnheld(): Promise<undefined> {
      return nativeCompletion();
    },
  };
}

/**
 * Construct a RhiDevice shim wrapping GPUDevice.
 *
 * Does not cache or reclassify device.lost (single-source subscription +
 * dual-form fan-out is the engine layer's job; this package only exposes the
 * spec Promise). See plan-strategy 3 R2 mitigation.
 */
export function makeRhiDevice(rawDevice: GPUDevice): {
  device: RhiDevice;
  /** Exposed for createShaderModule and other shim entry points that need to
   *  bypass the createX Result wrapper. */
  raw: GPUDevice;
} {
  const pipelineLibrary = new WebGpuPipelineLibrary(rawDevice);
  void rawDevice.lost?.then(() => pipelineLibrary.dispose());
  const caps = deriveCaps(rawDevice, rawDevice.features, rawDevice.limits);
  const accelerationStructures = new WebGpuAccelerationStructures(
    caps.rayQuery,
    rawDevice,
    (buffer) => (BUFFER_META_MAP.get(buffer)?.usage as number | undefined) ?? 0,
    (buffer) => BUFFER_RAW_MAP.get(buffer) ?? (buffer as unknown as GPUBuffer),
  );
  const features = rawDevice.features as unknown as RhiFeatures;
  const limits = rawDevice.limits as RhiLimits;

  const queue: RhiQueue = makeQueue(rawDevice.queue);
  const deviceGeneration =
    RAW_DEVICE_GENERATION_MAP.get(rawDevice) ??
    (() => {
      const generation = NEXT_DEVICE_GENERATION++;
      RAW_DEVICE_GENERATION_MAP.set(rawDevice, generation);
      return generation;
    })();

  const device: RhiDevice = {
    pipelineLibrary,
    caps,
    features,
    limits,
    nativeDevice: () => ok(rawDevice),
    async importTexture(texture: GPUTexture): Promise<Result<Texture, RhiError>> {
      const handle = texture as unknown as Texture;
      const existing = TEXTURE_META_MAP.get(handle);
      if (existing !== undefined && !existing.destroyed) {
        return err(
          new RhiErrorClass({
            code: 'rhi-descriptor-invalid',
            expected: 'a texture not already registered with this RHI device',
            hint: 'reuse the Texture handle from the earlier import, or destroyTexture it first',
          }),
        );
      }
      const validated = await validateImportedTexture(rawDevice, texture);
      if (!validated.ok) return validated;
      TEXTURE_META_MAP.set(handle, {
        format: validated.value.format,
        usage: validated.value.usage,
        viewFormats: [],
        destroyed: false,
        borrowed: true,
      });
      return ok(handle);
    },
    importExternalTexture: (desc) => importExternalTexture(rawDevice, desc),
    probeTextureFormatCapability(): Promise<
      Result<import('@forgeax/engine-rhi').RhiTextureFormatCapabilityReceipt, RhiError>
    > {
      const cached = R32FLOAT_PROBE_CACHE.get(device);
      if (cached !== undefined) return cached;
      const probe = probeR32FloatCapability(rawDevice, deviceGeneration);
      R32FLOAT_PROBE_CACHE.set(device, probe);
      return probe;
    },
    queue,
    // The raw backend owns the only real loss-injection seam. Keep this
    // Promise as a transparent observation boundary; a test provider must
    // operate on the backend before this shim and must never be added to the
    // public RHI surface.
    lost: rawDevice.lost as unknown as Promise<{
      readonly reason: 'destroyed' | 'unknown';
      readonly message: string;
    }>,
    createBuffer(desc: BufferDescriptor): Result<Buffer, RhiError> {
      const usageGate = validateRayQueryBufferUsage(
        caps.rayQuery,
        (desc.usage as number | undefined) ?? 0,
      );
      if (!usageGate.ok) return usageGate;
      // M5 / K-7 / OQ-7 / D-R3: mappedAtCreation passthrough is delivered by
      // BUFFER_KEYS containing 'mappedAtCreation'; mirror() ships the field to
      // the raw GPUBufferDescriptor when present (`'mappedAtCreation' in desc`
      // semantics), so createBuffer({mappedAtCreation:true}) yields a buffer
      // in `'mapped'` state per spec §buffer-creation step 6 (research §4.3).
      // w31 (M5) dawn-real-gpu Pattern B is the regression guard - it asserts
      // mapState === 'mapped' + getMappedRange().byteLength === 16 + the init
      // data round-trips through copyBufferToBuffer + mapAsync(READ).
      const out = rawDevice.createBuffer(
        mirror(desc, BUFFER_KEYS) as unknown as GPUBufferDescriptor,
      );
      // Record metadata for downstream shim validation (resolveQuerySet
      // destination.usage / destinationOffset bounds, research §2.3 +
      // M5 mapAsync mode-usage cross-check, research §4.2 step 9 / F-8 row 3).
      const sizeField = typeof desc.size === 'number' ? desc.size : 0;
      const usageField = (desc.usage as GPUBufferUsageFlags | undefined) ?? 0;
      // M5 / w35: wrap the raw GPUBuffer in a forgeax Buffer wrapper that
      // exposes the mapping surface (mapAsync / getMappedRange / unmap /
      // mapState getter). The wrapper validates BEFORE delegating to the raw
      // GPUBuffer; failures ride 'webgpu-runtime-error' with structured
      // .expected / .hint (K-2 + research §4.2 / F-8 three rows).
      const handle = makeBufferWrapper(out, sizeField, usageField);
      COMMAND_COUNTS.bufferCreates++;
      BUFFER_RAW_MAP.set(handle, out);
      BUFFER_META_MAP.set(handle, {
        size: sizeField,
        usage: usageField,
        destroyed: false,
      });
      return ok(handle);
    },
    createTexture(desc: TextureDescriptor): Result<Texture, RhiError> {
      const out = rawDevice.createTexture(
        mirror(desc, TEXTURE_KEYS) as unknown as GPUTextureDescriptor,
      );
      const handle = out as unknown as Texture;
      COMMAND_COUNTS.textureCreates++;
      // Record metadata for createTextureView cross-resource validation.
      const viewFormats =
        desc.viewFormats === undefined
          ? []
          : Array.from(desc.viewFormats as Iterable<GPUTextureFormat>);
      TEXTURE_META_MAP.set(handle, {
        format: desc.format as GPUTextureFormat,
        usage: desc.usage as GPUTextureUsageFlags,
        viewFormats,
        destroyed: false,
      });
      return ok(handle);
    },
    createBlas: (desc) => accelerationStructures.createBlas(desc),
    createTlas: (desc) => accelerationStructures.createTlas(desc),
    destroyBlas: (blas) => accelerationStructures.destroy(blas, 'destroyBlas'),
    destroyTlas: (tlas) => accelerationStructures.destroy(tlas, 'destroyTlas'),
    destroyBuffer(buf: Buffer): Result<void, RhiError> {
      // feat-20260612 M1 / w4 — fail-fast over the spec idempotent-void
      // contract (plan-strategy D-7). The shim layer tracks
      // `destroyed: boolean` on per-handle BufferMeta and routes the second
      // destroy to 'destroy-after-destroy' rather than forwarding to the
      // underlying GPUBuffer.destroy(). Charter proposition 4 explicit
      // failure + architecture-principles §5 Fail Fast.
      const meta = BUFFER_META_MAP.get(buf);
      if (meta?.destroyed) {
        return err(
          new RhiErrorClass({
            code: 'destroy-after-destroy',
            expected: 'GPU buffer handle has not been destroyed yet',
            hint: 'object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy',
          }),
        );
      }
      const rawBuf = BUFFER_RAW_MAP.get(buf);
      try {
        if (rawBuf !== undefined && typeof rawBuf.destroy === 'function') {
          rawBuf.destroy();
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'underlying GPUBuffer.destroy() to succeed',
            hint: `destroy raised: ${message}`,
          }),
        );
      }
      if (meta !== undefined) meta.destroyed = true;
      return ok(undefined);
    },
    destroyTexture(tex: Texture): Result<void, RhiError> {
      // feat-20260612 M1 / w4 — fail-fast on second destroy (D-7); shape
      // mirrors destroyBuffer above. The shim tracks `destroyed: boolean`
      // on per-handle TextureMeta; the underlying GPUTexture.destroy()
      // is invoked exactly once per handle.
      const meta = TEXTURE_META_MAP.get(tex);
      if (meta?.destroyed) {
        return err(
          new RhiErrorClass({
            code: 'destroy-after-destroy',
            expected: 'GPU texture handle has not been destroyed yet',
            hint: 'object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy',
          }),
        );
      }
      const rawTex = tex as unknown as { destroy?: () => void };
      try {
        if (meta?.borrowed !== true && typeof rawTex.destroy === 'function') {
          rawTex.destroy();
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'underlying GPUTexture.destroy() to succeed',
            hint: `destroy raised: ${message}`,
          }),
        );
      }
      if (meta !== undefined) meta.destroyed = true;
      return ok(undefined);
    },
    createTextureView(
      texture: Texture,
      desc: TextureViewDescriptor,
    ): Result<TextureView, RhiError> {
      // Cross-resource validation fast-path (research §1.1). When metadata is
      // available, validate format ∈ source.format ∪ source.viewFormats and
      // usage ⊆ source.usage; both violations map to 'webgpu-runtime-error'
      // (charter proposition 4 explicit failure).
      const meta = TEXTURE_META_MAP.get(texture);
      if (meta !== undefined) {
        const fmt = desc.format as GPUTextureFormat | undefined;
        if (fmt !== undefined && fmt !== meta.format && !meta.viewFormats.includes(fmt)) {
          return err(
            new RhiErrorClass({
              code: 'webgpu-runtime-error',
              expected:
                'createTextureView format must be the source texture format or one of source.viewFormats',
              hint: `got format='${fmt}'; source.format='${meta.format}'; source.viewFormats=[${meta.viewFormats.join(', ')}]`,
            }),
          );
        }
        const reqUsage = desc.usage as GPUTextureUsageFlags | undefined;
        if (reqUsage !== undefined && reqUsage !== 0 && (reqUsage & ~meta.usage) !== 0) {
          return err(
            new RhiErrorClass({
              code: 'webgpu-runtime-error',
              expected: 'createTextureView usage must be a subset of source.usage',
              hint: `got usage=0x${reqUsage.toString(16)}; source.usage=0x${meta.usage.toString(16)}`,
            }),
          );
        }
      }
      const rawTexture = texture as unknown as GPUTexture;
      try {
        const rawView = rawTexture.createView(
          mirror(desc, TEXTURE_VIEW_KEYS) as unknown as GPUTextureViewDescriptor,
        );
        const handle = rawView as unknown as TextureView;
        TEXTURE_VIEW_RAW_MAP.set(handle, rawView);
        return ok(handle);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'underlying GPUTexture.createView to succeed',
            hint: `createView raised: ${message}`,
          }),
        );
      }
    },
    createSampler(desc?: SamplerDescriptor | undefined): Result<Sampler, RhiError> {
      // Sampler descriptor is fully optional; if undefined call createSampler() with no arg.
      if (desc === undefined) {
        const out = rawDevice.createSampler();
        return ok(out as unknown as Sampler);
      }
      const out = rawDevice.createSampler(
        mirror(desc, SAMPLER_KEYS) as unknown as GPUSamplerDescriptor,
      );
      return ok(out as unknown as Sampler);
    },
    createBindGroupLayout(desc: BindGroupLayoutDescriptor): Result<BindGroupLayout, RhiError> {
      const gate = validateRayQueryBindGroupLayout(caps.rayQuery, desc);
      if (!gate.ok) return gate;
      const out = pipelineLibrary.createBindGroupLayout(
        mirror(desc, BGL_KEYS) as unknown as GPUBindGroupLayoutDescriptor,
      );
      return ok(out as unknown as BindGroupLayout);
    },
    createBindGroup(desc: BindGroupDescriptor): Result<BindGroup, RhiError> {
      // w20 — tagged-union RhiBindingResource 4-kind adapter. Each forgeax
      // entry carries `{ binding, resource: { kind, value } }` (the 4
      // discriminator values are 'sampler' / 'buffer' / 'textureView' /
      // 'externalTexture' per @forgeax/engine-rhi RhiBindingResource). The shim
      // dispatches on `resource.kind` and emits the spec-verbatim
      // GPUBindGroupEntry shape per kind. The default branch trips
      // `assertNever` so a future RhiBindingResource extension forces a
      // TS2367 here at compile time (charter proposition 4 explicit failure
      // + proposition 5 consistent abstraction over duck-typing).
      const mirrored: {
        label?: string | undefined;
        layout: GPUBindGroupLayout;
        entries: GPUBindGroupEntry[];
      } = {
        layout: desc.layout as unknown as GPUBindGroupLayout,
        entries: [],
      };
      if ('label' in desc && desc.label !== undefined) mirrored.label = desc.label;
      for (const entry of desc.entries) {
        const resource = entry.resource;
        switch (resource.kind) {
          case 'sampler': {
            mirrored.entries.push({
              binding: entry.binding,
              resource: resource.value as unknown as GPUSampler,
            });
            break;
          }
          case 'buffer': {
            const { buffer, offset, size } = resource.value;
            const rawBuf = BUFFER_RAW_MAP.get(buffer) ?? (buffer as unknown as GPUBuffer);
            const bufferBinding: GPUBufferBinding = { buffer: rawBuf };
            if (offset !== undefined) bufferBinding.offset = offset;
            if (size !== undefined) bufferBinding.size = size;
            mirrored.entries.push({ binding: entry.binding, resource: bufferBinding });
            break;
          }
          case 'textureView': {
            mirrored.entries.push({
              binding: entry.binding,
              resource: resource.value as unknown as GPUTextureView,
            });
            break;
          }
          case 'externalTexture': {
            mirrored.entries.push({
              binding: entry.binding,
              resource: resource.value as unknown as GPUExternalTexture,
            });
            break;
          }
          case 'accelerationStructure': {
            if (!caps.rayQuery.supported) {
              return rayQueryUnsupported(`bind group entry ${entry.binding}`, caps.rayQuery);
            }
            if (!accelerationStructures.isBuiltTlas(resource.value)) {
              return err(
                new RhiErrorClass({
                  code: 'rhi-descriptor-invalid',
                  expected: 'a live TLAS built by encoder.buildAccelerationStructures',
                  hint: `bind group entry ${entry.binding} binds a TLAS that is destroyed or was never built`,
                }),
              );
            }
            mirrored.entries.push({
              binding: entry.binding,
              resource: resource.value as unknown as GPUBindingResource,
            });
            break;
          }
          default: {
            // assertNever — adding a sixth kind would trip TS2367 here.
            const _exhaustive: never = resource;
            void _exhaustive;
            throw new Error(`rhi-webgpu: unreachable RhiBindingResource kind in createBindGroup`);
          }
        }
      }
      const out = rawDevice.createBindGroup(mirrored as unknown as GPUBindGroupDescriptor);
      COMMAND_COUNTS.bindGroupCreates++;
      return ok(out as unknown as BindGroup);
    },
    createPipelineLayout(desc: PipelineLayoutDescriptor): Result<PipelineLayout, RhiError> {
      const out = pipelineLibrary.createPipelineLayout(
        mirror(desc, PL_KEYS) as unknown as GPUPipelineLayoutDescriptor,
      );
      return ok(out as unknown as PipelineLayout);
    },
    createRenderPipeline(desc: RenderPipelineDescriptor): Result<RenderPipeline, RhiError> {
      try {
        const out = pipelineLibrary.createRenderPipeline(mirrorRenderPipelineDescriptor(desc));
        return ok(out as unknown as RenderPipeline);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Keep synchronous render-pipeline creation on the same structured
        // Result boundary as compute-pipeline creation. A failed PSO must not
        // escape as an exception and abort the caller's whole frame.
        if (/compile|shader|wgsl/i.test(message)) {
          return err(
            new RhiErrorClass({
              code: 'shader-compile-failed',
              expected: 'render shader modules + entry points to be valid',
              hint: `compile error: ${message}`,
            }),
          );
        }
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'underlying GPUDevice.createRenderPipeline to succeed',
            hint: `createRenderPipeline raised: ${message}`,
          }),
        );
      }
    },
    ...(typeof rawDevice.createRenderPipelineAsync !== 'function'
      ? {}
      : {
          createRenderPipelineAsync(
            desc: RenderPipelineDescriptor,
          ): Result<RenderPipeline, RhiError> | Promise<Result<RenderPipeline, RhiError>> {
            const failed = (cause: unknown): Result<RenderPipeline, RhiError> => {
              const reason =
                cause !== null && typeof cause === 'object' && 'reason' in cause
                  ? cause.reason
                  : undefined;
              return err(
                new RhiErrorClass({
                  code: reason === 'validation' ? 'rhi-descriptor-invalid' : 'webgpu-runtime-error',
                  expected: 'WebGPU render pipeline compilation to complete successfully',
                  hint: cause instanceof Error ? cause.message : String(cause),
                }),
              );
            };
            try {
              const completion = pipelineLibrary.createRenderPipelineAsync(
                mirrorRenderPipelineDescriptor(desc),
              );
              // forgeax-async-whitelist: dom-native - only a completed device recipe can return immediately.
              return completion instanceof Promise
                ? completion.then((pipeline) => ok(pipeline as unknown as RenderPipeline), failed)
                : ok(completion as unknown as RenderPipeline);
            } catch (cause) {
              return failed(cause);
            }
          },
        }),
    ...(typeof rawDevice.createComputePipelineAsync !== 'function'
      ? {}
      : {
          createComputePipelineAsync(
            desc: ComputePipelineDescriptor,
          ): Result<ComputePipeline, RhiError> | Promise<Result<ComputePipeline, RhiError>> {
            if (caps.compute === false)
              return err(
                new RhiErrorClass({
                  code: 'feature-not-enabled',
                  expected: 'caps.compute === true',
                  hint: 'check compute capability before preparing a compute pipeline',
                }),
              );
            const failed = (cause: unknown): Result<ComputePipeline, RhiError> => {
              const reason =
                cause !== null && typeof cause === 'object' && 'reason' in cause
                  ? cause.reason
                  : undefined;
              return err(
                new RhiErrorClass({
                  code: reason === 'validation' ? 'rhi-descriptor-invalid' : 'webgpu-runtime-error',
                  expected: 'WebGPU compute pipeline compilation to complete successfully',
                  hint: cause instanceof Error ? cause.message : String(cause),
                }),
              );
            };
            try {
              const completion = pipelineLibrary.createComputePipelineAsync(
                mirror(desc, CP_KEYS) as unknown as GPUComputePipelineDescriptor,
              );
              // forgeax-async-whitelist: dom-native - only a completed device recipe can return immediately.
              return completion instanceof Promise
                ? completion.then((pipeline) => ok(pipeline as unknown as ComputePipeline), failed)
                : ok(completion as unknown as ComputePipeline);
            } catch (cause) {
              return failed(cause);
            }
          },
        }),
    createComputePipeline(desc: ComputePipelineDescriptor): Result<ComputePipeline, RhiError> {
      // Capability gate (research §1.2 NOTE; plan-strategy §4.3 boundary
      // case row 1). MVP WebGPU path always has caps.compute=true; the gate
      // exists for potential future backends that lack compute.
      if (caps.compute === false) {
        return err(
          new RhiErrorClass({
            code: 'feature-not-enabled',
            expected: 'caps.compute === true',
            hint: 'check device.caps.compute before calling createComputePipeline',
          }),
        );
      }
      try {
        const out = pipelineLibrary.createComputePipeline(
          mirror(desc, CP_KEYS) as unknown as GPUComputePipelineDescriptor,
        );
        return ok(out as unknown as ComputePipeline);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Shader / module compilation issues surface as 'shader-compile-failed'
        // with the underlying message; everything else maps to a generic
        // webgpu runtime error (charter proposition 4 explicit failure).
        if (/compile|shader|wgsl/i.test(message)) {
          return err(
            new RhiErrorClass({
              code: 'shader-compile-failed',
              expected: 'compute shader module + entry point to be valid',
              hint: `compile error: ${message}`,
            }),
          );
        }
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'underlying GPUDevice.createComputePipeline to succeed',
            hint: `createComputePipeline raised: ${message}`,
          }),
        );
      }
    },
    createQuerySet(desc: QuerySetDescriptor): Result<QuerySet, RhiError> {
      // Hard constraint: count <= 4096 (research §1.3 device timeline step 1).
      const count = desc.count as number | undefined;
      if (typeof count === 'number' && count > QUERY_SET_COUNT_LIMIT) {
        return err(
          new RhiErrorClass({
            code: 'limit-exceeded',
            expected: 'count <= 4096 (spec normative)',
            hint: 'create multiple QuerySet instances if more than 4096 queries needed',
          }),
        );
      }
      // Hard constraint: timestamp requires caps.timestampQuery.
      if (desc.type === 'timestamp' && caps.timestampQuery !== true) {
        return err(
          new RhiErrorClass({
            code: 'feature-not-enabled',
            expected: 'caps.timestampQuery === true (timestamp-query feature)',
            hint: 'request the timestamp-query feature at requestDevice and check device.caps.timestampQuery before creating timestamp QuerySets',
          }),
        );
      }
      try {
        const out = rawDevice.createQuerySet(
          mirror(desc, QS_KEYS) as unknown as GPUQuerySetDescriptor,
        );
        const handle = out as unknown as QuerySet;
        // Register raw handle so the RPE / encoder paths can read `.count` /
        // `.type` for bounds + alignment checks (research §2.1 + §2.3).
        QUERY_SET_RAW_MAP.set(handle, out);
        QUERY_SET_DESTROYED_MAP.set(handle, { destroyed: false });
        return ok(handle);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'underlying GPUDevice.createQuerySet to succeed',
            hint: `createQuerySet raised: ${message}`,
          }),
        );
      }
    },
    destroyQuerySet(querySet: QuerySet): Result<void, RhiError> {
      const marker = QUERY_SET_DESTROYED_MAP.get(querySet);
      if (marker?.destroyed) {
        return err(
          new RhiErrorClass({
            code: 'destroy-after-destroy',
            expected: 'GPU query-set handle has not been destroyed yet',
            hint: 'object already destroyed; release each timestamp QuerySet exactly once',
          }),
        );
      }
      const rawQuery = QUERY_SET_RAW_MAP.get(querySet) as
        | (GPUQuerySet & { destroy?: () => void })
        | undefined;
      try {
        if (rawQuery !== undefined && typeof rawQuery.destroy === 'function') rawQuery.destroy();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'underlying GPUQuerySet.destroy() to succeed',
            hint: `destroy raised: ${message}`,
          }),
        );
      }
      if (marker !== undefined) marker.destroyed = true;
      return ok(undefined);
    },
    createRenderBundleEncoder(
      desc: RenderBundleEncoderDescriptor,
    ): Result<RhiRenderBundleEncoder, RhiError> {
      try {
        const raw = rawDevice.createRenderBundleEncoder(desc as GPURenderBundleEncoderDescriptor);
        return ok(new WebGpuRenderBundleEncoder(raw));
      } catch (cause) {
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'a valid render bundle descriptor',
            hint: String(cause),
          }),
        );
      }
    },
    createCommandEncoder(
      desc?: CommandEncoderDescriptor | undefined,
    ): Result<RhiCommandEncoder, RhiError> {
      const rawEnc =
        desc === undefined
          ? rawDevice.createCommandEncoder()
          : rawDevice.createCommandEncoder(
              mirror(desc, ENC_KEYS) as unknown as GPUCommandEncoderDescriptor,
            );
      return ok(new WebGpuCommandEncoder(rawEnc, accelerationStructures));
    },
    // fix-f3: synchronous createShaderModule placeholder removed; the
    // shader-compile-failed path lives in the top-level async factory
    // (see ../index.ts).
  };
  RAW_DEVICE_MAP.set(device, rawDevice);
  PIPELINE_LIBRARY_MAP.set(device, pipelineLibrary);
  return { device, raw: rawDevice };
}

// ============================================================================
// RhiCanvasContext shim (M3 / K-4 / w21)
// ============================================================================
//
// Spec anchor: W3C WebGPU §3.3 GPUCanvasContext / GPUCanvasConfiguration.
// 4 methods (research §3.1) + 7 fields (§3.2) + 4 method algorithms (§3.3).

/** Spec normative supported context formats (research §3.2 normative). */
const SUPPORTED_CONTEXT_FORMATS: ReadonlySet<string> = new Set([
  'bgra8unorm',
  'rgba8unorm',
  'rgba16float',
]);

const CANVAS_CONFIG_KEYS = [
  'device',
  'format',
  'usage',
  'viewFormats',
  'colorSpace',
  'toneMapping',
  'alphaMode',
] as const;

/** Stripped-down GPUCanvasContext shape the shim consumes. Real
 *  GPUCanvasContext satisfies this; the unit-test mock fixture only
 *  implements what is needed (charter proposition 1: progressive disclosure). */
export interface GpuCanvasContextLike {
  readonly supportedAlphaModes?: readonly GPUCanvasAlphaMode[] | undefined;
  configure(configuration: GPUCanvasConfiguration): void;
  unconfigure(): void;
  getConfiguration(): GPUCanvasConfiguration | null;
  getCurrentTexture(): GPUTexture;
}

/**
 * Build a RhiCanvasContext shim around a raw GPUCanvasContext (M3 / K-4 /
 * w21).
 *
 * Pre-configure validation (research §3.3 mapping):
 *   - format gate: format must be in SUPPORTED_CONTEXT_FORMATS; otherwise
 *     fast-path returns `'webgpu-runtime-error'` with the spec-aligned
 *     `.expected` literal `'one of bgra8unorm/rgba8unorm/rgba16float'`.
 *
 * Post-configure semantics:
 *   - getCurrentTexture forwards each call to the raw context (NO cross-frame
 *     caching, research §3.3 [[Expire the current texture]]); spec
 *     InvalidStateError catches map to `'webgpu-runtime-error'`.
 *   - getConfiguration projects the spec record verbatim; missing fields
 *     remain missing (feature-detection idiom, research §3.2 toneMapping
 *     NOTE).
 */
export function makeCanvasContext(rawContext: GpuCanvasContextLike): RhiCanvasContext {
  return {
    get supportedAlphaModes() {
      return rawContext.supportedAlphaModes;
    },
    configure(desc: CanvasConfiguration): Result<void, RhiError> {
      const fmt = desc.format as GPUTextureFormat | undefined;
      if (typeof fmt === 'string' && !SUPPORTED_CONTEXT_FORMATS.has(fmt)) {
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'one of bgra8unorm/rgba8unorm/rgba16float',
            hint: `got format='${fmt}'; canvas configuration cannot use srgb formats — use the non-srgb form (e.g. 'bgra8unorm') and put the srgb format in viewFormats, then createView with the srgb format`,
          }),
        );
      }
      try {
        const mirrored = mirror(
          desc as unknown as Record<string, unknown>,
          CANVAS_CONFIG_KEYS,
        ) as unknown as Record<string, unknown>;
        // CanvasConfiguration.device is a forgeax RhiDevice brand (D-S5);
        // the spec GPUCanvasContext.configure({ device }) slot needs the raw
        // GPUDevice. Translate via RAW_DEVICE_MAP so AI-user-facing code only
        // sees the forgeax abstraction while the underlying spec call still
        // receives a valid raw device (charter proposition 5 consistent
        // abstraction red line + feat-20260510-rhi-resource-creation M4
        // escape hatch tear-down: the translation is fully internal to
        // packages/rhi-webgpu/src and does not surface a reverse-lookup
        // entry across the package boundary).
        if ('device' in mirrored) {
          const forgeaxDevice = desc.device as RhiDevice;
          const rawDev = RAW_DEVICE_MAP.get(forgeaxDevice);
          if (rawDev === undefined) {
            return err(
              new RhiErrorClass({
                code: 'rhi-not-available',
                expected:
                  'CanvasConfiguration.device must be a RhiDevice produced by rhi.requestAdapter().requestDevice() (or the deprecated rhi.requestDevice factory)',
                hint: 'pass the device returned by the forgeax rhi.requestAdapter() / rhi.requestDevice() entries; passing a foreign RhiDevice or a raw GPUDevice is rejected because the canvas-context spec requires the same raw GPUDevice that the forgeax shim wraps',
              }),
            );
          }
          mirrored.device = rawDev;
        }
        rawContext.configure(mirrored as unknown as GPUCanvasConfiguration);
        return ok(undefined);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Spec maps invalid / lost device to InvalidStateError; we map the
        // catch-all to webgpu-runtime-error so AI users get a structured
        // failure (charter proposition 4 explicit failure).
        if (e instanceof Error && (e.name === 'InvalidStateError' || /lost|destroyed/i.test(msg))) {
          return err(
            new RhiErrorClass({
              code: 'rhi-not-available',
              expected: 'CanvasConfiguration.device must be valid (not lost / destroyed)',
              hint: `configure raised: ${msg}`,
            }),
          );
        }
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'underlying GPUCanvasContext.configure to succeed',
            hint: `configure raised: ${msg}`,
          }),
        );
      }
    },
    unconfigure(): void {
      rawContext.unconfigure();
    },
    getConfiguration(): CanvasConfiguration | undefined {
      // Offscreen hosts may provide a context without the query; absence of
      // the record is data, never a configured-state guess.
      if (typeof rawContext.getConfiguration !== 'function') return undefined;
      const conf = rawContext.getConfiguration();
      if (conf === null || conf === undefined) return undefined;
      // Project spec fields onto the forgeax record verbatim; missing fields
      // remain missing (feature-detection idiom).
      const out: Record<string, unknown> = {};
      for (const k of CANVAS_CONFIG_KEYS) {
        if (k in (conf as unknown as Record<string, unknown>)) {
          out[k] = (conf as unknown as Record<string, unknown>)[k];
        }
      }
      return out as unknown as CanvasConfiguration;
    },
    getCurrentTexture(): Result<Texture, RhiError> {
      try {
        const rawTex = rawContext.getCurrentTexture();
        return ok(rawTex as unknown as Texture);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Spec InvalidStateError on unconfigured context maps to
        // 'webgpu-runtime-error' (charter proposition 4).
        return err(
          new RhiErrorClass({
            code: 'webgpu-runtime-error',
            expected: 'GPUCanvasContext.getCurrentTexture to succeed (context configured)',
            hint: `getCurrentTexture raised: ${msg}`,
          }),
        );
      }
    },
  };
}

function rawTextureCopy(info: TexelCopyTextureInfo): GPUTexelCopyTextureInfo {
  const raw: GPUTexelCopyTextureInfo = { texture: info.texture as unknown as GPUTexture };
  if (info.mipLevel !== undefined) raw.mipLevel = info.mipLevel;
  if (info.origin !== undefined) raw.origin = info.origin;
  if (info.aspect !== undefined) raw.aspect = info.aspect;
  return raw;
}
