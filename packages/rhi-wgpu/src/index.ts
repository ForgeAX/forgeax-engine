import type { RhiCanvasTarget } from '@forgeax/engine-rhi';

// @forgeax/engine-rhi-wgpu — wgpu 30 wasm thin shim implementing @forgeax/engine-rhi.
//
// This package is the dual-impl partner of @forgeax/engine-rhi-webgpu (see AGENTS.md
// "## Packages" + "## RHI / WebGPU" sections). Both packages export an `rhi`
// singleton implementing the same @forgeax/engine-rhi surface — the @forgeax/engine-runtime
// createRenderer.ts auto-select facade (M3) picks one at runtime based on
// `navigator.gpu` availability (D-P4 dynamic import + R-05 Vite ?url).
//
// Shape rules (mirrors @forgeax/engine-rhi-webgpu, charter proposition 5 consistent
// abstraction across the dual-impl boundary):
//   - spec alignment — the 17 descriptor field names pass through verbatim.
//   - opaque handle — 14 RHI handles surface as brand-only opaque types
//     (research R-06 wasm-bindgen `extends` + `typescript_type` form).
//   - capability-gated — wgpu webgl backend hard-limits surface via
//     `RhiCaps.X = false` rather than runtime exceptions.
//   - math-free — wasm-bindgen boundary accepts `Float32Array` /
//     `Uint16Array` / `Uint32Array` (research R-06 `js_sys` ABI).
//
// Lazy-load contract (research F-4 / F-5 + R-04 + plan-strategy §6 M3):
//   - The wasm bundle is owned by `@forgeax/engine-wgpu-wasm` (the merged wgpu 30 +
//     naga 30 wasm-pack output). Source identity and measured size belong to
//     that package's provenance and bundle-size report.
//     rhi-wgpu itself is a TS-only thin shell after feat-20260511-naga-rhi-wgpu-merge
//     M3 / w9 (D-P1 / D-P4): no local pkg/ output, no Rust toolchain
//     dependency, no second wasm bundle on the wire.
//   - The bundle is NOT loaded at module-import time. `ensureReady()` is
//     the lazy-init entry; callers await it before consuming the `rhi`
//     singleton. Internally this forwards to `@forgeax/engine-wgpu-wasm.ensureReady`
//     so the same wasm namespace is shared with `@forgeax/engine-naga` (research
//     F-5 single ensureReady SSOT).
//   - On the navigator.gpu path, this package's dynamic `import('@forgeax/
//     rhi-wgpu')` does not evaluate at all (D-P4) — the engine facade picks
//     @forgeax/engine-rhi-webgpu and the wasm bundle stays out of the first-paint
//     bundle.
//   - The public no-arg form `await ensureReady()` is fully wired — the
//     default factory dynamic-imports `@forgeax/engine-wgpu-wasm` and forwards to
//     its `ensureReady` so callers do NOT need to supply an `initFn`
//     explicitly. AI users consume the rhi singleton through one read:
//
//       import { rhi, ensureReady } from '@forgeax/engine-rhi-wgpu';
//       await ensureReady();
//       const adapter = (await rhi.requestAdapter()).unwrap();
//
// SSOT signal — re-export the merged wasm namespace type from
// `@forgeax/engine-wgpu-wasm` so AI users + reviewer tooling can grep one line and
// see this package's wasm bundle owner. The value-level wiring lives in
// `internal/wasm-loader.ts`'s default factory which dynamic-imports
// `@forgeax/engine-wgpu-wasm` and forwards to its `ensureReady` (feat-20260511-naga-rhi-wgpu-merge
// M3 / w9 — research F-5 single ensureReady SSOT).
//
// Public entries (w16 baseline; w17-w19 expand the surface):
// - requestAdapter(opts?) — entry 1: spec-aligned strict two-step path;
//   returns Result<RhiAdapter, RhiError>.
// - acquireCanvasContext(canvas) — entry 2: wasm surface path (M3 / w14).
// - rhi — singleton entry (charter proposition 1: progressive disclosure +
//   plan-strategy §7.4 'import { rhi } from @forgeax/engine-rhi-wgpu' + Engine.create
//   escape hatch injection shape).
// - ensureReady — wasm lazy-load surface (w13).

/// <reference types="@webgpu/types" />

// SSOT marker — type-only re-export from @forgeax/engine-wgpu-wasm so the public
// surface advertises the merged wasm namespace owner at the source level
// (feat-20260511-naga-rhi-wgpu-merge M3 / w9). The runtime forwarding to
// `@forgeax/engine-wgpu-wasm.ensureReady` happens inside the default init factory
// in `internal/wasm-loader.ts`.
export type { WgpuWasm } from '@forgeax/engine-wgpu-wasm';

import {
  err,
  ok,
  RAY_QUERY_BACKEND_UNSUPPORTED,
  type RequestAdapterOptions,
  type Result,
  type RhiAdapter,
  type RhiCanvasContext,
  type RhiDevice,
  RhiError,
  type RhiInstance,
  type ShaderModule,
  validateRayQueryShader,
} from '@forgeax/engine-rhi';
import { type GpuCanvasContextLike, makeCanvasContext, makeRhiAdapter } from './adapter';
import { getRhiWgpuModule } from './internal/wasm-loader';
import { ownWasmSurface, type WasmSurface } from './internal/wasm-surface';

/**
 * Cached wasm instance from the last `requestAdapter()` call, so the `rhi`
 * singleton can pass it to `acquireCanvasContext` without the caller needing
 * to manage the instance lifecycle (plan-strategy D-3: the singleton
 * internally binds the instance; the runtime calls
 * `pack.rhi.acquireCanvasContext(canvas)` with one arg).
 */
let cachedWasmInstance: RhiWgpuInstanceLike | undefined;

/**
 * Minimal shape of a RhiWgpuInstance the shim consumes for surface creation.
 * `createSurface` is an instance method on the wasm RhiWgpuInstance class
 * (plan-strategy D-3); the caller must provide a live instance.
 */
interface RhiWgpuInstanceLike {
  createSurface(canvas: RhiCanvasTarget): unknown;
}

/**
 * RK-2 / bug-20260610 — pre-create a WebGL2 context on `canvas` so the wgpu
 * GL backend can later bind its `Instance::create_surface(...Canvas(...))`
 * to the existing EGL/wgl/... context. Without this, both
 * `requestAdapterWithCanvas` (adapter step) and `createSurface` (surface
 * step) fail on the GL backend — the adapter step surfaces as
 * `adapter-unavailable` to the engine fallback chain, and the surface step
 * surfaces as `rhi-not-available`.
 *
 * Idempotent: browsers return the same context for repeated
 * `getContext('webgl2')` calls on the same canvas (HTML spec — the second
 * call returns the existing context regardless of attributes), so calling
 * this from both `requestAdapter` (when `compatibleSurface` is supplied)
 * and `acquireCanvasContext` (wasm fallback path) is safe.
 *
 * Structural probe rather than `instanceof HTMLCanvasElement` so the helper
 * works in vitest-node where HTMLCanvasElement is not defined
 * (plan-strategy D-2). The created context is intentionally not retained —
 * the side effect (GL binding on the canvas) is what wgpu needs.
 */
function preCreateWebGL2ContextForWgpuGLBackend(
  canvas: RhiCanvasTarget,
): WebGL2RenderingContext | undefined {
  if (typeof canvas.getContext !== 'function') return undefined;
  try {
    return (
      (canvas.getContext('webgl2', {
        alpha: true,
        // wgpu owns the single-sample surface resolve; avoid WebGL's default
        // multisampled drawing buffer, which makes that blit invalid in WebKit.
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference: 'default',
      }) as WebGL2RenderingContext | null) ?? undefined
    );
  } catch {
    // The synchronous getContext call rarely throws; any throw means the
    // browser cannot provide a webgl2 context on this canvas (Edge with
    // WebGPU flag disabled, very old browsers, etc.). The wgpu wasm GL
    // adapter path will subsequently fail with adapter-unavailable, which
    // the engine surfaces through EngineEnvironmentError (graceful
    // degradation per charter proposition 9).
    return undefined;
  }
}

/**
 * Entry 1 — `requestAdapter` walks `navigator.gpu.requestAdapter(opts)` if
 * available, otherwise hands off to the lazy-loaded wgpu wasm Instance
 * (R-03 graceful fallback).
 *
 * Two-branch logic (bug-20260526 fix):
 * 1. Try `navigator.gpu` first (fast path, no wasm overhead) — if it works,
 *    return adapter.
 * 2. If `navigator.gpu` is undefined OR returns null adapter, fall back to
 *    wgpu-wasm's own adapter enumeration via the initialized module.
 *
 * Optional `compatibleSurface` parameter (M3 / w21): when provided and the
 * wasm fallback path is taken, the function calls the wasm module's
 * `requestAdapterWithCanvas(canvas)` instead of the basic `requestAdapter()`.
 * This is required by the wgpu GL backend which needs a compatible surface
 * to enumerate adapters (requirements-decisions D5).
 *
 * Pre-condition: caller must have called `ensureReady()` before invoking
 * this function when the wasm fallback path is needed (D-2 constraint).
 *
 * Strict two-step path mirrors the spec / wgpu (research 6) and the
 * @forgeax/engine-rhi-webgpu shim signature byte-for-byte (charter proposition 5
 * consistent abstraction across the dual-impl boundary).
 */
export async function requestAdapter(
  _opts?: RequestAdapterOptions | undefined,
  compatibleSurface?: RhiCanvasTarget | undefined,
): Promise<Result<RhiAdapter, RhiError>> {
  // bug-20260610: NO navigator.gpu fast path here. `@forgeax/engine-rhi-webgpu`
  // owns navigator.gpu — `@forgeax/engine-rhi-wgpu` is the wasm GL fallback
  // backend by definition (the engine `createRenderer` Channel 2/3 split
  // routes navigator.gpu cases to rhi-webgpu, falling back to rhi-wgpu only
  // when rhi-webgpu fails). Touching navigator.gpu here would re-do work
  // rhi-webgpu already did and re-surface the same null adapter / error
  // path; rhi-wgpu's job is the wasm GL fallback path exclusively.

  // Wasm fallback path: navigator.gpu absent or returned null adapter.
  // D-2 pre-condition: getRhiWgpuModule() must be defined (caller called ensureReady).
  const wasmModule = getRhiWgpuModule<{
    RhiWgpuInstance: {
      // forgeax-async-whitelist: wasm-bindgen — raw generated instance and adapter API
      create(): Promise<{
        requestAdapter(): Promise<unknown>;
        requestAdapterWithCanvas?(canvas: RhiCanvasTarget): Promise<unknown>;
        createSurface?(canvas: RhiCanvasTarget): unknown;
      }>;
    };
  }>();
  if (wasmModule === undefined) {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: '@forgeax/engine-rhi-wgpu wasm module initialized via ensureReady()',
        hint: 'call ensureReady() before requestAdapter() — the wasm module must be loaded before adapter enumeration',
      }),
    );
  }

  // D-1: Use RhiWgpuInstance.create() + instance.requestAdapter() (or
  // requestAdapterWithCanvas when compatibleSurface is provided).
  try {
    const instance = await wasmModule.RhiWgpuInstance.create();
    // D-3: cache the instance so the rhi singleton can pass it to
    // acquireCanvasContext internally.
    cachedWasmInstance = instance as unknown as RhiWgpuInstanceLike;
    // bug-20260610: when compatibleSurface (a canvas) is supplied, the wgpu GL
    // backend's `Instance::create_surface(SurfaceTarget::Canvas(canvas))` call
    // (which `requestAdapterWithCanvas` invokes internally for surface-aware
    // adapter enumeration) requires a pre-existing WebGL2 context on the
    // canvas. Otherwise the GL adapter cannot bind and `requestAdapterWithCanvas`
    // returns null, surfacing as `adapter-unavailable` to the engine fallback
    // chain. The same pre-create logic lives in `acquireCanvasContext` for the
    // surface step; without firing it here the adapter step fails first and
    // the surface step never runs.
    if (compatibleSurface !== undefined) {
      preCreateWebGL2ContextForWgpuGLBackend(compatibleSurface);
    }
    const wasmAdapter: unknown =
      compatibleSurface !== undefined && typeof instance.requestAdapterWithCanvas === 'function'
        ? await instance.requestAdapterWithCanvas(compatibleSurface)
        : await instance.requestAdapter();
    // bug-20260610: the wasm side returns a descriptive string (not just NULL)
    // on either failure point — wrap it as the hint so the AI user / debug log
    // sees whether create_surface or request_adapter is the failing step.
    if (typeof wasmAdapter === 'string') {
      return err(
        new RhiError({
          code: 'adapter-unavailable',
          expected: 'a GPU adapter from wgpu-wasm backend (with compatible_surface)',
          hint: `wgpu-wasm backend failed: ${wasmAdapter}`,
        }),
      );
    }
    // R-3: explicit null/undefined/falsy check on returned value.
    if (!wasmAdapter) {
      return err(
        new RhiError({
          code: 'adapter-unavailable',
          expected: 'a GPU adapter from wgpu-wasm backend',
          hint: 'browser WebGPU unavailable and wgpu-wasm backend also failed to enumerate adapters — no GPU hardware accessible; display an unsupported-environment message',
        }),
      );
    }
    // D-3: wrap through existing makeRhiAdapter for consistent abstraction (P4).
    return ok(makeRhiAdapter(wasmAdapter as Parameters<typeof makeRhiAdapter>[0]));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(
      new RhiError({
        code: 'adapter-unavailable',
        expected: 'wgpu-wasm RhiWgpuInstance.create() + requestAdapter() to succeed',
        hint: `browser WebGPU unavailable and wgpu-wasm backend also failed to enumerate adapters; cause: ${message}`,
      }),
    );
  }
}

/**
 * Entry 2 — `acquireCanvasContext` acquires a canvas rendering context
 * through the wgpu-wasm surface path (M3 / w14).
 *
 * The `instance` parameter is the RhiWgpuInstance handle returned from
 * `RhiWgpuInstance.create()` during `requestAdapter`. Compile-time arity
 * enforcement eliminates the temporal-coupling footgun: callers MUST have
 * a live instance before acquiring a surface (plan-strategy D-3; charter P3
 * explicit failure — the old (canvas)-only form is a compile error, not a
 * runtime error).
 *
 * Two-branch logic:
 * 1. If navigator.gpu is available (dawn-node CI or browser with WebGPU),
 *    use the standard getContext('webgpu') path.
 * 2. Otherwise, call `instance.createSurface(canvas)` to obtain a
 *    wgpu-wasm surface, then wrap it as RhiCanvasContext (K-4).
 *
 * The returned RhiCanvasContext carries a reference to the wasm-created
 * Surface handle; subsequent configure / getCurrentTexture calls
 * route through the wasm surface methods.
 */
export function acquireCanvasContext(
  instance: RhiWgpuInstanceLike,
  canvas: RhiCanvasTarget,
): Result<RhiCanvasContext, RhiError> {
  // When navigator.gpu is available (e.g. dawn-node CI, or browser with WebGPU),
  // use the standard getContext('webgpu') path — same as rhi-webgpu. The wasm
  // surface path is the fallback for environments without navigator.gpu.
  const nav: { gpu?: unknown } | undefined =
    typeof globalThis !== 'undefined'
      ? (globalThis as { navigator?: { gpu?: unknown } }).navigator
      : undefined;
  if (nav !== undefined && 'gpu' in nav && nav.gpu !== undefined && nav.gpu !== null) {
    let rawCtx: unknown;
    try {
      rawCtx = canvas.getContext('webgpu');
    } catch {
      rawCtx = null;
    }
    if (rawCtx !== null && rawCtx !== undefined) {
      return ok(makeCanvasContext(rawCtx as GpuCanvasContextLike, canvas));
    }
  }

  // Wasm surface fallback — no navigator.gpu or getContext('webgpu') returned null.
  // Use the instance's createSurface method; the caller must provide a live
  // RhiWgpuInstance handle (plan-strategy D-3).
  if (typeof instance.createSurface !== 'function') {
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected:
          'RhiWgpuInstance with a createSurface method — obtained from requestAdapter wasm fallback path',
        hint: 'call requestAdapter() first to obtain a wasm instance, then pass it to acquireCanvasContext()',
      }),
    );
  }

  // RK-2: wgpu GL backend requires a pre-existing WebGL2 context on the
  // canvas before create_surface() / requestAdapterWithCanvas() succeeds.
  // bug-20260610 hoist: the same pre-create runs in `requestAdapter` before
  // `requestAdapterWithCanvas` so the adapter step also crosses the GL-bind
  // gate; calling it again here is idempotent (browsers return the same GL2
  // context for repeat getContext('webgl2') calls on the same canvas).
  preCreateWebGL2ContextForWgpuGLBackend(canvas);

  try {
    const surface = ownWasmSurface(() => instance.createSurface(canvas) as WasmSurface);
    return ok(makeCanvasContext(surface, canvas));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'instance.createSurface(canvas) to succeed',
        hint: `wasm surface creation failed: ${message}`,
      }),
    );
  }
}

/**
 * Entry 3 — async `createShaderModule(device, desc)` mirrors the
 * @forgeax/engine-rhi-webgpu top-level factory (charter proposition 5 consistent
 * abstraction across the dual-impl boundary). The engine `createRenderer`
 * D-P4 auto-select facade reads this entry from the `RhiBackendPack` to
 * compile WGSL during the pipeline build step. Without it, the escape-hatch
 * channel falls back to `invokeDeviceCreateShaderModule` which structurally
 * probes `RhiDevice.createShaderModule` and fails with 'rhi-not-available'
 * for the rhi-wgpu instance (the forgeax RhiDevice interface does not
 * expose a sync createShaderModule placeholder; fix-f3 cleanup).
 *
 * M2 baseline implementation: the rhi-wgpu shim accepts a `RhiDevice` whose
 * internal raw handle is a navigator.gpu GPUDevice (dawn-node injection /
 * escape-hatch wiring); we structurally probe `device.createShaderModule`
 * (which the M4 `RhiWgpuDeviceImpl` does NOT carry, but the raw GPUDevice
 * does through the `raw` field) and route the spec WGSL compile through.
 * The wgpu wasm bundle path will satisfy the same `createShaderModule`
 * structural slot once the bindings land (R-06 5 pattern + wasm-bindgen
 * `js_name` rename).
 */
function createRawShaderModule(
  device: RhiDevice,
  desc: { label?: string | undefined; code: string },
): Result<ShaderModule, RhiError> {
  // Walk the forgeax RhiWgpuDeviceImpl wrapper to the raw device. The wrapper
  // keeps `raw` private; this shim-internal field avoids widening RhiDevice.
  const rawDevice = (
    device as unknown as {
      _internal_raw?: { createShaderModule?(desc: GPUShaderModuleDescriptor): unknown };
    }
  )._internal_raw;
  const candidateRawCSM = rawDevice?.createShaderModule;
  if (typeof candidateRawCSM !== 'function') {
    return err(
      new RhiError({
        code: 'shader-compile-failed',
        expected: 'rhi-wgpu RhiDevice carries an internal raw handle exposing createShaderModule',
        hint: 'unregistered RhiDevice instance — pass an RhiDevice produced by rhi.requestAdapter() → adapter.requestDevice()',
      }),
    );
  }
  const rayQueryGate = validateRayQueryShader(RAY_QUERY_BACKEND_UNSUPPORTED, desc.code);
  if (!rayQueryGate.ok) return rayQueryGate;
  // WebGL2 has no external textures; lower the WGSL type to the sampled 2D
  // texture that the lowered bind-group layout entry carries.
  const mirrored: { label?: string; code: string } = {
    code: desc.code.replace(/\btexture_external\b/g, 'texture_2d<f32>'),
  };
  if ('label' in desc && desc.label !== undefined) mirrored.label = desc.label;
  try {
    return ok(
      candidateRawCSM.call(rawDevice, mirrored as GPUShaderModuleDescriptor) as ShaderModule,
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return err(
      new RhiError({
        code: 'shader-compile-failed',
        expected:
          'rawDevice.createShaderModule(desc) succeeds (spec: synchronous part rarely throws)',
        hint: `rhi-wgpu shim caught: ${message}`,
      }),
    );
  }
}

export async function createShaderModule(
  device: RhiDevice,
  desc: { label?: string | undefined; code: string },
): Promise<Result<ShaderModule, RhiError>> {
  const result = createRawShaderModule(device, desc);
  if (!result.ok) return result;
  // The spec resolves shader compile errors asynchronously via
  // module.getCompilationInfo(); the rhi-webgpu shim mirrors this. The
  // M2 baseline returns the handle as-is and lets dawn / wgpu validation
  // surface errors through subsequent pipeline build; this matches the
  // wgpu wasm path's structural contract (R-06 + plan-strategy section 4.5).
  return result;
}

/**
 * Internal render-path shader creation. The wgpu wrapper reaches the raw
 * device synchronously, just like the browser WebGPU adapter. Build-time
 * cooking already validates published WGSL, so the render path can create
 * the module handle without waiting for compilation diagnostics; pipeline
 * creation remains the runtime validation point.
 */
export function createShaderModuleImmediate(
  device: RhiDevice,
  desc: { label?: string | undefined; code: string },
): Result<ShaderModule, RhiError> {
  return createRawShaderModule(device, desc);
}

/**
 * The `rhi` singleton entry — implements the @forgeax/engine-rhi `RhiInstance`
 * interface. AI users consume this via:
 *
 *   import { rhi, ensureReady } from '@forgeax/engine-rhi-wgpu';
 *   await ensureReady();
 *   const adapter = (await rhi.requestAdapter()).unwrap();
 *
 * The shim attaches `acquireCanvasContext` + `createShaderModule` (forgeax
 * extension entries) at the same level so AI users have a single import
 * path for adapter / device / canvas-context / shader-module flow
 * (charter proposition 1 progressive disclosure + proposition 5 consistent
 * abstraction parity with @forgeax/engine-rhi-webgpu).
 */
export const rhi: RhiInstance & {
  acquireCanvasContext: (canvas: RhiCanvasTarget) => Result<RhiCanvasContext, RhiError>;
  createShaderModule: typeof createShaderModule;
  createShaderModuleImmediate: typeof createShaderModuleImmediate;
} = {
  requestAdapter,
  // The singleton internally binds the cached wasm instance (from the last
  // requestAdapter call) as the first parameter to acquireCanvasContext.
  // AI users and the runtime call `pack.rhi.acquireCanvasContext(canvas)`
  // with a single parameter — the instance is passed implicitly
  // (plan-strategy D-3).
  acquireCanvasContext: (canvas: RhiCanvasTarget) => {
    // Pass cachedWasmInstance (may be undefined when the navigator.gpu fast
    // path was taken in requestAdapter). The real acquireCanvasContext handles
    // both branches: (a) navigator.gpu present -> canvas.getContext('webgpu'),
    // no wasm instance needed; (b) wasm fallback -> checks instance?.createSurface
    // and returns a structured RhiError if instance is unavailable.
    //
    // Use a sentinel empty object when cachedWasmInstance is undefined so the
    // typeof instance.createSurface check never throws on undefined.
    const instance: RhiWgpuInstanceLike =
      cachedWasmInstance ?? ({ createSurface: undefined } as unknown as RhiWgpuInstanceLike);
    return acquireCanvasContext(instance, canvas);
  },
  createShaderModule,
  createShaderModuleImmediate,
};

// Re-export public types from @forgeax/engine-rhi for single-import discoverability
// (charter proposition 1 progressive disclosure; mirrors @forgeax/engine-rhi-webgpu
// re-export shape).
export type {
  // 14 opaque handles
  BindGroup,
  // 17 descriptors (matches surface-mirror.test-d.ts assertions)
  BindGroupDescriptor,
  BindGroupLayout,
  BindGroupLayoutDescriptor,
  Buffer,
  BufferDescriptor,
  CanvasConfiguration,
  CommandBuffer,
  CommandEncoder,
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
  RequestDeviceOptions,
  Result,
  ResultErr,
  ResultOk,
  // 7 main interfaces
  RhiAdapter,
  RhiAssetNotRegisteredDetail,
  RhiCanvasContext,
  RhiCaps,
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
export { err, ok, RhiError as RhiErrorClass } from '@forgeax/engine-rhi';
export { disposeDevice } from './device';
// wasm-loader surface (w13): keep the root front door canonical; the loader
// implementation and its synchronous cache accessor remain internal.
export { ensureRhiWgpuReady as ensureReady } from './internal/wasm-loader';
