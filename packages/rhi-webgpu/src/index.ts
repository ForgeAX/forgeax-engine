import type { RhiCanvasTarget } from '@forgeax/engine-rhi';
// @forgeax/engine-rhi-webgpu — thin WebGPU shim implementing the @forgeax/engine-rhi interface shape.
//
// Shape rules (shared between README + AGENTS.md '## RHI / WebGPU' section):
// - spec alignment — the 5 descriptor field names pass through verbatim to
//   GPUDevice.createX.
// - `?: T | undefined` + `'x' in src` guard (decision S-7 / research §F-3).
// - opaque handle — `RhiDevice.createX` returns `Result.ok(handle)`; the handle
//   internally references the GPU resource object but exposes only a brand-only
//   opaque shape externally (research §R5).
// - capability-gated — caps / features / limits are exposed as three independent
//   readonly layers (charter proposition 5).
// - device.lost dual-track — the spec Promise passes through (research §F-4 / R2
//   countermeasure); the engine layer does the fan-out, this package does not
//   introduce a secondary cache.
//
// Public entries (charter proposition 1: progressive disclosure / single entry that
// surfaces the full surface area at once):
// - requestAdapter(opts?)       — entry 1: spec-aligned strict two-step
//                                 path (M3 break-point #2 + M6 fix-up
//                                 [w51]); returns Result<RhiAdapter, RhiError>.
// - createShaderModule(d, desc) — entry 2: async, returns
//                                 Result<ShaderModule, RhiError>; the
//                                 shader-compile-failed path includes
//                                 detail.compilerMessages.
// - acquireCanvasContext(canvas) — entry 3: calls canvas.getContext('webgpu')
//                                  + wraps as branded RhiCanvasContext (M3 / w15).
// - rhi                          — singleton entry (plan-strategy §7.4
//                                 'import { rhi } from @forgeax/engine-rhi-webgpu' +
//                                 Engine.create({ rhi, canvas })).
//
// The legacy single-step `rhi.requestDevice(opts)` factory was retired in
// M6 fix-up [w51] (AGENTS.md break-point list 2026-05-10 #2). Callers go
// through `(await rhi.requestAdapter()).value.requestDevice(opts)`.
//
// Anchors: requirements §AC AC-05 + AC-10 + MVP-1.1 / MVP-1.2 / MVP-1.7 + edge cases
//          + §hard constraint 10; plan-strategy §1 architecture + §2 S-7 + §6 M2 +
//          §7.3 error-message strategy table + §7.4 discoverability;
//          research §F-1 / §F-3 / §F-4 / §F-5 / §F-6.

/// <reference types="@webgpu/types" />

import type {
  RequestDeviceOptions as ForgeaXRequestDeviceOptions,
  RequestAdapterOptions,
  Result,
  RhiAdapter,
  RhiCanvasContext,
  RhiDevice,
  RhiError,
  RhiInstance,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError as RhiErrorClass, validateRayQueryShader } from '@forgeax/engine-rhi';
import { _internal_getRawDevice, makeCanvasContext, makeRhiDevice } from './device';
import {
  adapterUnavailable,
  featureNotEnabled,
  limitExceeded,
  requestAdapterFailed,
  shaderCompileFailed,
} from './errors';

/**
 * The `GPU` subset accepted at the provider seam (research §F-6 webgpu-utils +
 * CTS consensus).
 *
 * The shim only calls the two entries `gpu.requestAdapter()` →
 * `adapter.requestDevice()`; accepting a structural subset rather than requiring
 * a full GPU interface implementation lets the mock fixture
 * (src/__tests__/__mocks__/gpu-device.ts) skip implementing
 * `wgslLanguageFeatures` / `getPreferredCanvasFormat` and other fields this loop
 * does not consume (charter proposition 1: progressive disclosure).
 */
export interface GpuLike {
  // forgeax-async-whitelist: dom-native — spec `GPU.requestAdapter()` raw entry
  requestAdapter(options?: GPURequestAdapterOptions | undefined): Promise<GpuAdapterLike | null>;
}

/** The `GPUAdapter` subset accepted at the provider seam — capability limits plus `requestDevice`. */
export interface GpuAdapterLike {
  readonly limits?: GPUSupportedLimits | undefined;
  // forgeax-async-whitelist: dom-native — spec `GPUAdapter.requestDevice()` raw entry
  requestDevice(descriptor?: GPUDeviceDescriptor | undefined): Promise<GpuDeviceLike>;
}

const DYNAMIC_DEVICE_LIMIT_KEYS = [
  'maxDynamicUniformBuffersPerPipelineLayout',
  'maxDynamicStorageBuffersPerPipelineLayout',
] as const;
const SYNTHETIC_DAWN_DYNAMIC_LIMIT_DEFAULT = 1_000_000;

/**
 * Keep browser-native Dawn from synthesizing the 1,000,000 dynamic-buffer
 * defaults or clamping Dawn's synthetic 1,000,000 request. The adapter's
 * reported values are the only safe values for omitted/defaulted limits: they
 * are finite, supported by this adapter, and do not mutate the caller's
 * descriptor.
 */
function normalizeDeviceDescriptor(
  adapter: { readonly limits?: GPUSupportedLimits | undefined },
  descriptor?: GPUDeviceDescriptor | undefined,
): GPUDeviceDescriptor | undefined {
  const adapterLimits = adapter.limits;
  if (adapterLimits === undefined || adapterLimits === null) return descriptor;

  const requiredLimits = { ...(descriptor?.requiredLimits ?? {}) };
  let changed = false;
  for (const key of DYNAMIC_DEVICE_LIMIT_KEYS) {
    const value = adapterLimits[key];
    if (!Number.isFinite(value) || value < 1) continue;
    const requested = requiredLimits[key];
    if (
      requested !== undefined &&
      (requested <= value || requested !== SYNTHETIC_DAWN_DYNAMIC_LIMIT_DEFAULT)
    ) {
      continue;
    }
    requiredLimits[key] = value;
    changed = true;
  }
  return changed ? { ...(descriptor ?? {}), requiredLimits } : descriptor;
}

/**
 * The `GPUDevice` subset accepted at the provider seam — exactly the fields the
 * shim actually touches (the 5 descriptor `createX` calls + features / limits /
 * lost + a `queue` placeholder).
 *
 * Differences from the full GPUDevice spec:
 * - `onuncapturederror` / `pushErrorScope` / `createCommandEncoder` not required
 *   (only needed at M3).
 * - `wgslLanguageFeatures` / `getPreferredCanvasFormat` not required (charter
 *   proposition 1: progressive disclosure).
 *
 * The coverage of `cast as GPUDevice` inside `makeRhiDevice` matches this
 * interface exactly; both the mock and the real GPUDevice only need to satisfy
 * this structural subset.
 */
export interface GpuDeviceLike {
  readonly features: GPUSupportedFeatures;
  readonly limits: GPUSupportedLimits;
  // forgeax-async-whitelist: dom-native — spec `GPUDevice.lost` Promise passthrough
  readonly lost: Promise<GPUDeviceLostInfo>;
  readonly queue: unknown;
  createBuffer(descriptor: GPUBufferDescriptor): unknown;
  createTexture(descriptor: GPUTextureDescriptor): unknown;
  createSampler(descriptor?: GPUSamplerDescriptor | undefined): unknown;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): unknown;
  createBindGroup(descriptor: GPUBindGroupDescriptor): unknown;
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): unknown;
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): unknown;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): unknown;
}

/**
 * Options for the `requestDevice` entry.
 *
 * `gpu?: GpuLike` is the provider seam (research §F-6 webgpu-utils + CTS
 * consensus):
 * - omitted → falls back to `globalThis.navigator.gpu` (real-device path).
 * - explicitly provided → uses the caller-injected mock / real GPU object (mock
 *   unit-test path).
 *
 * `adapterOptions` / `deviceDescriptor` pass through to the corresponding spec
 * entries.
 */
export interface RequestDeviceOptions {
  gpu?: GpuLike | undefined;
  adapterOptions?: GPURequestAdapterOptions | undefined;
  deviceDescriptor?: GPUDeviceDescriptor | undefined;
}

/**
 * Maps an OperationError that may occur during `requestDevice` back into a
 * RhiError.
 *
 * Spec behavior (research §F-5 / W3C CR §"Adapter Selection"):
 * - `requiredFeatures` exceeds the adapter → reject with `OperationError`.
 * - `requiredLimits` exceeds the adapter → reject with `OperationError`.
 *
 * This package distinguishes feature vs limit by message keyword; the message
 * format is not interoperable between the mock and real GPU implementations
 * (research §F-4: ecosystem-wide message-field inconsistency), but the keywords
 * 'feature' / 'limit' work as a heuristic on both sides. Detailed
 * classification (including limit-name / feature-name extraction) is left to a
 * follow-up loop (plan-strategy §3 R2 fallback).
 */
function classifyRequestDeviceError(e: unknown): Result<never, RhiError> {
  const msg = e instanceof Error ? e.message : String(e);
  if (/feature/i.test(msg)) return featureNotEnabled();
  if (/limit/i.test(msg)) return limitExceeded();
  // Fallback: an unrecognized message keyword is classified as feature-not-enabled
  // (charter proposition 4: explicit failure + structured errors over hidden
  // branches). Subsequent loops can extend the classification.
  return featureNotEnabled();
}

/**
 * Internal `requestDevice` — single-step factory accepting an injected
 * `gpu` mock provider. **Not part of the public RHI surface**: AI users go
 * through the spec-aligned two-step path
 * `rhi.requestAdapter() -> adapter.requestDevice()` (M3 break-point #2 + M6
 * fix-up [w51]; AGENTS.md break-point list 2026-05-10 #2). This entry is
 * retained as the unit-test seam (`packages/rhi-webgpu/src/__tests__/*`)
 * for `gpu` mock injection; it is **not** re-exported through the `rhi`
 * singleton and is **not** referenced by engine / apps / dawn paths
 * (charter proposition 5 consistent abstraction red line + grep gate
 * `m6-e: rhi.requestDevice( 0 hit`).
 *
 * Generates 3 of the 4 error paths here (research §F-5):
 * - adapter null     → `Result.err(RhiError { code: 'adapter-unavailable' })`
 * - feature not enabled → `Result.err(RhiError { code: 'feature-not-enabled' })`
 * - limit exceeded   → `Result.err(RhiError { code: 'limit-exceeded' })`
 *
 * The 4th path (shader-compile-failed) is generated by the
 * `createShaderModule` entry.
 */
export async function requestDevice(
  opts: RequestDeviceOptions = {},
): Promise<Result<RhiDevice, RhiError>> {
  const injected: GpuLike | undefined = opts.gpu;
  const ambient: GPU | undefined =
    typeof globalThis !== 'undefined'
      ? (globalThis as { navigator?: Navigator }).navigator?.gpu
      : undefined;
  const gpu: GpuLike | undefined = injected ?? ambient;
  if (gpu === undefined || gpu === null) {
    return adapterUnavailable();
  }

  const adapter = await gpu.requestAdapter(opts.adapterOptions);
  if (adapter === null) {
    return adapterUnavailable();
  }

  let rawDevice: GpuDeviceLike;
  try {
    rawDevice = await adapter.requestDevice(
      normalizeDeviceDescriptor(adapter, opts.deviceDescriptor),
    );
  } catch (e) {
    return classifyRequestDeviceError(e);
  }

  const { device } = makeRhiDevice(rawDevice as unknown as GPUDevice);
  return ok(device);
}

function createRawShaderModule(
  device: RhiDevice,
  desc: { label?: string | undefined; code: string },
): Result<GPUShaderModule, RhiError> {
  // In-package reverse lookup of the underlying GPUDevice. The raw handle is
  // intentionally kept behind this package boundary; render assembly may use
  // this synchronous step, while public callers use the diagnostic-rich async
  // entry below.
  const rawDevice = _internal_getRawDevice(device);
  if (rawDevice === undefined) {
    return shaderCompileFailed([
      {
        type: 'error',
        message: 'rhi-webgpu: createShaderModule called with unregistered RhiDevice',
        lineNum: 0,
        linePos: 0,
        offset: 0,
        length: 0,
      } as GPUCompilationMessage,
    ]);
  }
  const rayQueryGate = validateRayQueryShader(device.caps.rayQuery, desc.code);
  if (!rayQueryGate.ok) return rayQueryGate;
  const mirrored: { label?: string; code: string } = { code: desc.code };
  if ('label' in desc && desc.label !== undefined) mirrored.label = desc.label;
  try {
    return ok(rawDevice.createShaderModule(mirrored as GPUShaderModuleDescriptor));
  } catch (e) {
    // The synchronous part of a real-device createShaderModule rarely throws
    // (spec: errors are surfaced asynchronously through getCompilationInfo);
    // a few mock shapes might throw — preserve the public structured error.
    const message = e instanceof Error ? e.message : String(e);
    return shaderCompileFailed([
      {
        type: 'error',
        message,
        lineNum: 0,
        linePos: 0,
        offset: 0,
        length: 0,
      } as GPUCompilationMessage,
    ]);
  }
}

/**
 * Entry 2 - async `createShaderModule`. The shader-compile-failed path
 * forwards every 6 fields of `GPUCompilationMessage` to
 * `RhiError.detail.compilerMessages` (OQ-P2 / F-3 finding).
 *
 * Implementation (post fix-f3):
 *   1) Look up the underlying `GPUDevice` via the in-package
 *      `_internal_getRawDevice` (RAW_DEVICE_MAP reverse lookup; same module).
 *   2) `rawDevice.createShaderModule(desc)` calls the spec entry to obtain
 *      a `GPUShaderModule`.
 *   3) `await module.getCompilationInfo()` retrieves compilation info.
 *   4) If any message has `type === 'error'`, return
 *      `Result.err(RhiError { code: 'shader-compile-failed',
 *      detail: { compilerMessages } })`.
 *   5) Otherwise return `Result.ok(module as ShaderModule)`.
 *
 * Note: this entry accepts a shim-wrapped RhiDevice (not a raw GPUDevice)
 * to keep the public API single-source; the in-package
 * `_internal_getRawDevice` is the only sanctioned reverse lookup.
 *
 * fix-f3: the synchronous `RhiDevice.createShaderModule` placeholder is
 * removed; the shader-compile-failed path closes inside this async entry
 * (charter proposition 5 consistent abstraction + proposition 4 explicit
 * failure).
 */
export async function createShaderModule(
  device: RhiDevice,
  desc: { label?: string | undefined; code: string },
): Promise<Result<ShaderModule, RhiError>> {
  const rawResult = createRawShaderModule(device, desc);
  if (!rawResult.ok) return rawResult;
  const handle = rawResult.value;
  const handleWithInfo = handle as GPUShaderModule & {
    // forgeax-async-whitelist: dom-native — spec `GPUShaderModule.getCompilationInfo()`
    getCompilationInfo?: () => Promise<GPUCompilationInfo>;
  };
  if (typeof handleWithInfo.getCompilationInfo !== 'function') {
    // A real GPUShaderModule always has getCompilationInfo (spec-mandated);
    // its absence implies the shim path drifted from the spec — the degraded
    // path returns ok (does not block the engine layer; charter
    // proposition 9: graceful degradation).
    return ok(handle as unknown as ShaderModule);
  }
  let info: GPUCompilationInfo;
  try {
    info = await handleWithInfo.getCompilationInfo();
  } catch {
    // getCompilationInfo() rejects when the underlying GPU instance is dropped
    // mid-await — the device was destroyed (or the page is tearing down) while
    // the async compilation-info query was in flight. The module handle was
    // already created synchronously above, so there is nothing left to report;
    // returning ok keeps an unobserved teardown rejection from escaping as an
    // unhandled rejection (charter proposition 9: graceful degradation, same
    // degraded path as the missing-getCompilationInfo branch above).
    return ok(handle as unknown as ShaderModule);
  }
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) {
    // Keep the public six-field GPUCompilationMessage shape intact while
    // making browser failures attributable to the shader producer. Dawn's
    // aggregate output is otherwise indistinguishable when several modules
    // are created during renderer bootstrap.
    const sourcePrefix =
      desc.label === undefined ? '' : ` source=${JSON.stringify(desc.code.slice(0, 24))}`;
    const labeledMessages = info.messages.map((message) => ({
      message:
        desc.label === undefined
          ? message.message
          : `[${desc.label}]${sourcePrefix} ${message.message}`,
      type: message.type,
      lineNum: message.lineNum,
      linePos: message.linePos,
      offset: message.offset,
      length: message.length,
    })) as GPUCompilationMessage[];
    return shaderCompileFailed(labeledMessages);
  }
  return ok(handle as unknown as ShaderModule);
}

/**
 * Internal render-path shader creation. WebGPU returns a module handle
 * synchronously; compiler diagnostics remain owned by the public async
 * `createShaderModule` entry. Render pipeline creation is the validation point
 * for this path, so software adapters do not serialize their first frame on
 * `getCompilationInfo()` for every material.
 */
export function createShaderModuleImmediate(
  device: RhiDevice,
  desc: { label?: string | undefined; code: string },
): Result<ShaderModule, RhiError> {
  const result = createRawShaderModule(device, desc);
  return result.ok ? ok(result.value as unknown as ShaderModule) : result;
}

/**
 * Build a RhiAdapter shim around a raw GPUAdapter (M3 / break-point #2 / K-5 +
 * K-6).
 *
 * Field projection:
 *   - `features` <- `new Set([...adapter.features])` (Round 3 fix-up F-P1-2:
 *     surfaces a `ReadonlySet<GPUFeatureName>` aligned with
 *     `RhiDevice.features`, so AI users use `.has(name)` uniformly across
 *     both abstraction layers; previously projected to `ReadonlyArray<string>`
 *     which split the cross-tier idiom).
 *   - `limits` <- structural copy of `adapter.limits` numeric fields. Spec
 *     `GPUSupportedLimits` is a typed object whose enumerable own-keys are
 *     exactly the limit fields (research §6.3 + spec normative); the shim
 *     surfaces them via `Readonly<Record<string, number>>` for ergonomic AI-
 *     user lookups (`adapter.limits.maxTextureDimension2D`).
 *   - `requestDevice` forwards to `adapter.requestDevice(opts)` and wraps the
 *     resulting `GPUDevice` via `makeRhiDevice` (research §F-5 error paths).
 */
function makeRhiAdapter(rawAdapter: {
  readonly features?: GPUSupportedFeatures | undefined;
  readonly limits?: GPUSupportedLimits | undefined;
  // forgeax-async-whitelist: dom-native — spec `GPUAdapter.requestDevice()` raw forward
  requestDevice(descriptor?: GPUDeviceDescriptor | undefined): Promise<unknown>;
}): RhiAdapter {
  // Defensive against minimal mock adapters that omit features / limits
  // (the spec mandates them on real adapters, but unit-test mocks
  // historically expose only `requestDevice`). Defaults to empty
  // projections; real adapters always supply both fields.
  const rawFeatures = rawAdapter.features as unknown as ReadonlySet<GPUFeatureName> | undefined;
  const features: ReadonlySet<GPUFeatureName> =
    rawFeatures !== undefined && rawFeatures !== null
      ? new Set(rawFeatures)
      : new Set<GPUFeatureName>();
  const limitsRaw = (rawAdapter.limits as unknown as Record<string, unknown> | undefined) ?? {};
  const limits: Record<string, number> = {};
  for (const key in limitsRaw) {
    const v = limitsRaw[key];
    if (typeof v === 'number') {
      limits[key] = v;
    }
  }
  return {
    features,
    limits: limits as Readonly<Record<string, number>>,
    async requestDevice(
      opts?: ForgeaXRequestDeviceOptions | undefined,
    ): Promise<Result<RhiDevice, RhiError>> {
      let rawDevice: GpuDeviceLike;
      try {
        rawDevice = (await rawAdapter.requestDevice(
          normalizeDeviceDescriptor(rawAdapter, opts as GPUDeviceDescriptor | undefined),
        )) as GpuDeviceLike;
      } catch (e) {
        return classifyRequestDeviceError(e);
      }
      const { device } = makeRhiDevice(rawDevice as unknown as GPUDevice);
      return ok(device);
    },
  };
}

/**
 * Entry — `requestAdapter` walks `navigator.gpu.requestAdapter(opts)` and
 * wraps the result as a forgeax `RhiAdapter` (M3 break-point #2; K-5 + K-6).
 *
 * Strict two-step path mirrors wgpu / Dawn (research §6); the legacy
 * `requestDevice(opts)` factory below is the deprecated single-step shortcut
 * kept for backward compatibility while existing callers migrate.
 *
 * Optional `gpu` provider seam at the `RequestAdapterOptions`-side: this
 * factory takes only the forgeax-spec `RequestAdapterOptions` (powerPreference
 * / forceFallbackAdapter); when callers need the mock-injection seam they go
 * through the legacy `requestDevice({ gpu })` form.
 *
 * @param opts — W3C-spec request adapter options.
 * @param _compatibleSurface — accepted for dual-impl symmetry
 *   (plan-strategy D-5; AGENTS.md "Dual-impl ship-together" rule).
 *   The browser WebGPU backend does not use this parameter; it is
 *   ignored. rhi-wgpu routes it to `requestAdapterWithCanvas`.
 */
export async function requestAdapter(
  opts?: RequestAdapterOptions | undefined,
  _compatibleSurface?: RhiCanvasTarget | undefined,
): Promise<Result<RhiAdapter, RhiError>> {
  const ambient: GPU | undefined =
    typeof globalThis !== 'undefined'
      ? (globalThis as { navigator?: Navigator }).navigator?.gpu
      : undefined;
  return requestAdapterFrom(ambient, opts);
}

/**
 * `requestAdapter` over an explicit WebGPU-shaped `GPU` instead of
 * `navigator.gpu`. A non-browser provider (the native wgpu GPU of
 * `@forgeax/engine-rhi-wgpu-native`) builds its `rhi` instance on this seam,
 * so one shim serves every WebGPU-shaped implementation.
 */
export async function requestAdapterFrom(
  gpu: GpuLike | undefined | null,
  opts?: RequestAdapterOptions | undefined,
): Promise<Result<RhiAdapter, RhiError>> {
  const ambient = gpu;
  if (ambient === undefined || ambient === null) {
    return adapterUnavailable();
  }
  // `null` is the spec adapter-absence channel. A rejection is a different
  // failure (permission policy, insecure context, browser/runtime fault, etc.)
  // and must retain its cause instead of being rewritten as unsupported WebGPU.
  // Both outcomes remain structured, so Runtime can still try its wgpu/WebGL2
  // fallback without erasing the browser-native channel diagnosis.
  let adapter: unknown;
  try {
    adapter = await ambient.requestAdapter(opts as GPURequestAdapterOptions | undefined);
  } catch (cause) {
    return requestAdapterFailed(cause);
  }
  if (adapter === null) {
    return adapterUnavailable();
  }
  return ok(
    makeRhiAdapter(
      adapter as unknown as {
        readonly features?: GPUSupportedFeatures | undefined;
        readonly limits?: GPUSupportedLimits | undefined;
        // forgeax-async-whitelist: dom-native — spec `GPUAdapter.requestDevice()` cast
        requestDevice(descriptor?: GPUDeviceDescriptor | undefined): Promise<unknown>;
      },
    ),
  );
}

/**
 * Acquire a canvas rendering context from an HTMLCanvasElement (M3 / w15).
 *
 * Spec anchor: W3C WebGPU §3.3 GPUCanvasContext.
 *
 * Internally calls `canvas.getContext('webgpu')` and wraps the result as a
 * branded RhiCanvasContext. Returns `Result<RhiCanvasContext, RhiError>` —
 * canvas does not support WebGPU returns `RhiError { code: 'rhi-not-available' }`
 * with a precise `.hint` so AI users can display a degradation banner (charter
 * proposition 4 explicit failure).
 *
 * This replaces the legacy `createCanvasContext(rawCtx)` — AGENTS.md §Change stance
 * authorizes the breaking rename (acquireCanvasContext, optimal > compatible).
 *
 * @example
 *   const ctxResult = acquireCanvasContext(canvas);
 *   if (!ctxResult.ok) {
 *     // canvas does not support WebGPU
 *     return;
 *   }
 *   const canvasContext = ctxResult.value;
 *   canvasContext.configure({ device, format: 'bgra8unorm', usage: 0x10 });
 */
export function acquireCanvasContext(canvas: RhiCanvasTarget): Result<RhiCanvasContext, RhiError> {
  let rawContext: GPUCanvasContext | null;
  try {
    rawContext = canvas.getContext('webgpu') as GPUCanvasContext | null;
  } catch {
    rawContext = null;
  }
  if (rawContext === null) {
    return err(
      new RhiErrorClass({
        code: 'rhi-not-available',
        expected: 'canvas.getContext("webgpu") to return a non-null GPUCanvasContext',
        hint: 'canvas does not support WebGPU — pass a same-realm display target whose getContext("webgpu") returns a valid GPUCanvasContext',
      }),
    );
  }
  return ok(makeCanvasContext(rawContext));
}

/**
 * The `rhi` singleton entry (charter proposition 1: progressive disclosure +
 * plan-strategy §7.4 discoverability:
 * 'import { rhi } from @forgeax/engine-rhi-webgpu' + 'Engine.create({ rhi, canvas })'
 * injection shape).
 *
 * Strict two-step path (M3 break-point #2 + M6 fix-up [w51]; K-5 + K-6):
 *   `rhi.requestAdapter(opts) -> adapter.requestDevice(opts)`
 *
 * The legacy single-step `rhi.requestDevice(opts)` factory was retired here
 * (AGENTS.md break-point list 2026-05-10 #2). AI users follow the spec
 * idiom (charter proposition 5 consistent abstraction red line):
 *   const adapter = (await rhi.requestAdapter()).unwrap();
 *   const device  = (await adapter.requestDevice(opts)).unwrap();
 */
export const rhi: RhiInstance & {
  createShaderModule: typeof createShaderModule;
  createShaderModuleImmediate: typeof createShaderModuleImmediate;
  acquireCanvasContext: typeof acquireCanvasContext;
} = {
  requestAdapter,
  createShaderModule,
  createShaderModuleImmediate,
  acquireCanvasContext,
};

// Re-export public types so callers consume them through a single entry
// (charter proposition 1: progressive disclosure / single import surfaces
// the full RHI consumption chain). Round 3 fix-up F-P2-1: extended from
// 3 to the full set so AI users do not need a transitive
// `import { RhiAdapter, ... } from '@forgeax/engine-rhi'` alongside the
// rhi-webgpu singleton.
export type {
  // 14 opaque handles (charter proposition 5 consistent abstraction:
  // brand-only surface; AI users hold these for cross-call resource flow).
  BindGroup,
  // 14 descriptors (Pick<GPU*Descriptor, ...> mirrors; AI users compose
  // these inline before calling device.createX).
  BindGroupDescriptor,
  BindGroupLayout,
  BindGroupLayoutDescriptor,
  Buffer,
  BufferDescriptor,
  CanvasConfiguration,
  CommandBuffer,
  CommandEncoderDescriptor,
  ComputePassDescriptor,
  ComputePassTimestampWrites,
  ComputePipeline,
  ComputePipelineDescriptor,
  Fence,
  PipelineLayout,
  PipelineLayoutDescriptor,
  QuerySet,
  QuerySetDescriptor,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  RenderPassDescriptor,
  RenderPipeline,
  RenderPipelineDescriptor,
  RequestAdapterOptions,
  RequestDeviceOptions as RhiRequestDeviceOptions,
  // Result + error model (RhiError class is exported as a value below).
  Result,
  ResultErr,
  ResultOk,
  // Adapter / Device / Instance / surface (M2-M3 main interfaces).
  RhiAdapter,
  RhiAssetNotRegisteredDetail,
  RhiCanvasContext,
  RhiCaps,
  // Command / pass encoder interfaces (M3-M4).
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiError,
  RhiErrorCode,
  RhiErrorDetail,
  RhiFeatures,
  RhiInstance,
  RhiLimits,
  RhiQueue,
  RhiRenderPassEncoder,
  RhiShaderCompileDetail,
  RhiSurface,
  RhiWebgpuRuntimeDetail,
  Sampler,
  SamplerDescriptor,
  ShaderModule,
  Texture,
  TextureDescriptor,
  TextureView,
  TextureViewDescriptor,
} from '@forgeax/engine-rhi';

// Re-export Result factories + RhiError class as values (the rhi-webgpu
// top-level surface stays single-import for both type-only and runtime
// consumption).
export { err, ok, RhiError as RhiErrorClass } from '@forgeax/engine-rhi';
// feat-20260511-rhi-spec-realign-aggressive D-VD2 (Round 2) — re-export the
// `_internal_getRawDevice` reverse lookup. Re-introduces the M4-removed escape
// hatch for the sole engine consumer that needs to register the spec
// `onuncapturederror` listener on the raw GPUDevice:
// `packages/engine/src/createRenderer.ts`. The listener registration is the
// only browser-WebGPU path through which `Renderer.onError(err =>
// switch err.code { case 'oom' | 'internal-error' | 'shader-compile-failed':
// ... })` can fire (AGENTS.md break-point #4 promise; spec GPUDevice extends
// EventTarget and exposes `onuncapturederror` as a settable property).
//
// AC-08 grep gate (`apps/hello/triangle/scripts/ac-08-grep-gate.mjs`) allows
// engine-internal usage of `_internal_getRawDevice` through the existing
// `\bgetRawDevice\b` word-boundary allowlist; consumers outside the engine
// layer remain forbidden (charter proposition 5 consistent abstraction red
// line: the RHI surface stays brand-only for AI-user-facing code; the reverse
// lookup is the named single-point escape hatch the engine uses to satisfy
// spec event-target requirements).
export { _internal_getRawDevice, disposeDevice } from './device';
// feat-20260511-rhi-spec-realign-aggressive D-VD2 wire-up: re-export the
// async-dispatch event translator at the top level so the engine layer
// (packages/engine/src/createRenderer.ts) can register the spec
// `device.onuncapturederror` listener + the dual-channel `device.lost`
// fan-out without reaching into `internal/`. AGENTS.md break-point #4 dispatch
// path promise: rhi-webgpu/src/internal/error-translation.ts translates
// GPUUncapturedErrorEvent / GPUDeviceLostInfo to the 17-member RhiErrorCode
// union; engine.onError captures the dispatch (charter proposition 4
// explicit failure + proposition 5 consistent abstraction across both
// browser-direct and rhi-wgpu wasm dual paths).
export { translateErrorEventToRhiError } from './internal/error-translation';
