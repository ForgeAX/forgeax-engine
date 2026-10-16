import type { RhiCanvasTarget } from '@forgeax/engine-rhi';
// packages/rhi-wgpu/src/adapter.ts — RhiAdapter / RhiCanvasContext shim
// (w16 of feat-20260511-rhi-wgpu-impl).
//
// The TS shim layer wraps the wasm-bindgen handles (`RhiWgpuAdapter` etc.,
// exported from `packages/rhi-wgpu/crate/src/lib.rs`) into the forgeax RHI
// interface shape. M2 baseline lands the structural shim — every method
// returns a Result-wrapped placeholder that mirrors the @forgeax/engine-rhi-webgpu
// behaviour. M3 / M4 (w22-w27) wires the real wasm bindings through the
// `ensureReady` + internal wasm-module accessor lazy-load contract (w13).
//
// w16 scope:
//   - makeRhiAdapter(rawAdapter): RhiAdapter
//   - makeCanvasContext(rawContext): RhiCanvasContext (1-arg form, K-4)
//   - makeRhiDevice + makeRhiQueue + makeRhiCommandEncoder lives in
//     device.ts / queue.ts / command-encoder.ts (w17 / w18).
//
// The shim functions consume an "any-shaped raw handle" parameter typed as
// `unknown` — the caller (`index.ts` / future wgpu wasm consumers) feeds
// either a navigator.gpu raw handle (when the TS shim is exercised against
// a navigator.gpu fixture) or a `RhiWgpuAdapter` JsValue handle from the
// wasm bundle. Both shapes funnel through the same Result wrapper.
//
// Anchors: plan-strategy §6 M2 + §2 D-P3 TS shim layered structure + K-4
//          canvas context + K-5 / K-6 strict two-step path; charter
//          proposition 5 consistent abstraction.

/// <reference types="@webgpu/types" />

import {
  type CanvasConfiguration,
  type RequestDeviceOptions as ForgeaXRequestDeviceOptions,
  ok,
  type Result,
  type RhiAdapter,
  type RhiCanvasContext,
  type RhiCanvasSurfacePresentationProof,
  type RhiDevice,
  type RhiError,
  type Texture,
} from '@forgeax/engine-rhi';
import { makeRhiDevice, type RawDeviceLike } from './device';
import { adapterUnavailable, webgpuRuntimeError } from './errors';

/**
 * Minimal shape of a wgpu-wasm or navigator.gpu adapter that the TS shim
 * touches. The shim only reads `features` + `limits` + calls
 * `requestDevice`; this loose typing accommodates both:
 *
 * 1. navigator.gpu `GPUAdapter` (when the dual-impl auto-select facade
 *    picks the WebGPU path but injects through the rhi-wgpu shim as an
 *    escape hatch, D-R5).
 * 2. The `RhiWgpuAdapter` wasm-bindgen handle (when the lazy-loaded wgpu
 *    wasm bundle drives the device request path).
 */
export interface RawAdapterLike {
  readonly features?: ReadonlySet<string> | { has(name: string): boolean } | undefined;
  readonly limits?: Readonly<Record<string, number>> | undefined;
  // forgeax-async-whitelist: wasm-bindgen — wgpu-wasm `Adapter.requestDevice()` raw entry
  requestDevice(opts?: unknown): Promise<RawDeviceLike>;
}

/**
 * Build a `RhiAdapter` over a raw wgpu-wasm or navigator.gpu adapter handle.
 *
 * Field projection (mirrors @forgeax/engine-rhi-webgpu/src/index.ts makeRhiAdapter):
 *   - `features` projects to `ReadonlySet<GPUFeatureName>`.
 *   - `limits`   projects to `Readonly<Record<string, number>>`.
 *   - `requestDevice` forwards to the raw handle, wraps the resulting raw
 *     device via `makeRhiDevice` and routes errors through structured
 *     RhiError factories (charter proposition 4 explicit failure).
 */
export function makeRhiAdapter(rawAdapter: RawAdapterLike): RhiAdapter {
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
      try {
        const rawDevice = await rawAdapter.requestDevice(opts);
        const { device } = makeRhiDevice(rawDevice);
        return ok(device);
      } catch (e) {
        // Spec / wgpu both signal feature / limit problems as a thrown
        // OperationError; we route them through webgpuRuntimeError as a
        // safe baseline at M2. The M4 dawn-node integration (w24) narrows
        // the dispatch into feature-not-enabled / limit-exceeded by
        // keyword (mirrors rhi-webgpu's classifyRequestDeviceError).
        return webgpuRuntimeError(e);
      }
    },
  };
}

/**
 * Minimal canvas-context shape the shim consumes. The configure surface
 * only reads `device`/`format`/`usage`/`viewFormats`/`colorSpace`/
 * `toneMapping`/`alphaMode` (the 7 GPUCanvasConfiguration fields) and
 * forwards them to the raw context's `configure` method.
 */
export type GpuCanvasContextLike = {
  configure(desc: GPUCanvasConfiguration): void;
  unconfigure(): void;
  getConfiguration?(): GPUCanvasConfiguration | null;
  getCurrentTexture(): unknown;
};

type SurfaceProofContext = GpuCanvasContextLike & {
  readonly probeSurfacePresentation?: () => RhiCanvasSurfacePresentationProof;
};

type MutableCanvasContext = Omit<RhiCanvasContext, 'presentationProof'> & {
  presentationProof?: RhiCanvasSurfacePresentationProof;
};

/**
 * Build a `RhiCanvasContext` over a raw GPUCanvasContext. The forgeax form
 * (K-4) keeps the spec method names but routes failures through `Result`:
 *
 *   - `configure` returns `Result<void, RhiError>` (spec returns void;
 *     forgeax surfaces 'webgpu-runtime-error' for spec validation failures).
 *   - `unconfigure` returns void (spec literal alignment).
 *   - `getConfiguration` returns `CanvasConfiguration | undefined` (spec
 *     returns `GPUCanvasConfiguration?`; forgeax uses `undefined`).
 *   - `getCurrentTexture` returns `Result<Texture, RhiError>` (K-4: Texture
 *     brand, NOT TextureView; AI users go two-step
 *     `device.createTextureView(canvasContext.getCurrentTexture().unwrap(),{})`).
 */
export function makeCanvasContext(
  rawContext: SurfaceProofContext,
  // bug-20260610 v19: optional canvas reference. The WebGPU spec form does
  // not include width/height in `GPUCanvasConfiguration` — the canvas's own
  // `.width / .height` attributes are the surface size. The wgpu-wasm shim
  // (which wraps a wgpu::Surface) cannot reach the canvas after construction,
  // so the JS shim must inject the size into the descriptor mirror. Without
  // this the RhiWgpuSurface configure deserialiser falls back to the serde
  // default of 1×1 → the GLES backbuffer is 1×1 stretched over the CSS
  // viewport (uniform-coloured rectangle, all draws collapse to single pixel).
  canvas?: RhiCanvasTarget,
): RhiCanvasContext {
  // Per-context ownership of the acquired SurfaceTexture wrapper. A microtask
  // presents after the synchronous record/submit stack. Every getCurrentTexture
  // in that stack returns the same image, as GPUCanvasContext requires.
  let pendingSurfaceTexture: { raw: { present: () => void }; texture: Texture } | null = null;
  let pendingPresentationError: unknown;
  let surfaceDescriptor: {
    format?: unknown;
    usage?: unknown;
    width?: unknown;
    height?: unknown;
  } = {};
  let configuredWithoutGetter: CanvasConfiguration | undefined;
  let presentationProof: RhiCanvasSurfacePresentationProof | undefined;

  function copyConfiguration(value: CanvasConfiguration): CanvasConfiguration {
    return {
      ...value,
      ...(value.viewFormats === undefined ? {} : { viewFormats: [...value.viewFormats] }),
    };
  }

  function presentPendingSurfaceTexture(): void {
    const previousError = pendingPresentationError;
    pendingPresentationError = undefined;
    if (previousError !== undefined) throw previousError;
    const pending = pendingSurfaceTexture;
    pendingSurfaceTexture = null;
    if (pending === null) return;
    try {
      pending.raw.present();
    } catch (error) {
      // Preserve the concrete wasm/device cause for the next owner boundary;
      // silently dropping it turns a present failure into a later acquire panic.
      pendingPresentationError = error;
    }
  }

  function scheduleSurfaceTexturePresent(
    surfaceTexture: NonNullable<typeof pendingSurfaceTexture>,
  ): void {
    globalThis.queueMicrotask(() => {
      if (pendingSurfaceTexture !== surfaceTexture) return;
      pendingSurfaceTexture = null;
      try {
        surfaceTexture.raw.present();
      } catch (error) {
        // Surface presentation is asynchronous on this backend. Keep its
        // structured cause until the next synchronous RHI boundary observes it.
        pendingPresentationError = error;
      }
    });
  }

  // wasm-bindgen texture handles are intentionally opaque, so their browser
  // runtime properties (width/height/format/usage) are not readable by the
  // RHI-debug recorder. Preserve the facts already known at the surface seam
  // as non-enumerable metadata without wrapping the handle (wrapping would
  // break wasm-bindgen class checks in createTextureView).
  function annotateSurfaceTexture(texture: unknown): void {
    if (texture === null || typeof texture !== 'object') return;
    const target = texture as Record<string, unknown>;
    const metadata: Record<string, unknown> = {
      width: surfaceDescriptor.width,
      height: surfaceDescriptor.height,
      depthOrArrayLayers: 1,
      format: surfaceDescriptor.format,
      usage: surfaceDescriptor.usage,
    };
    for (const [key, value] of Object.entries(metadata)) {
      if (value === undefined) continue;
      try {
        if (target[key] === undefined) {
          Object.defineProperty(target, key, {
            configurable: true,
            enumerable: false,
            value,
          });
        }
      } catch {
        // Some wasm-bindgen versions expose non-extensible handles. Keep the
        // handle usable; recorder diagnostics remain fail-fast in that case.
      }
    }
  }

  const context: MutableCanvasContext = {
    configure(desc: CanvasConfiguration): Result<void, RhiError> {
      try {
        // Reconfiguration invalidates the old surface image. Release it
        // before handing the surface back to wgpu.
        presentPendingSurfaceTexture();
        // M4 w25 integration: the forgeax CanvasConfiguration has
        // `device: RhiDevice` (D-S5); the raw context expects
        // `device: GPUDevice`. Walk the rhi-wgpu device wrapper's
        // shim-internal `_internal_raw` field (mirrors rhi-webgpu's
        // RAW_DEVICE_MAP reverse lookup pattern — the wrap form is an
        // instance field rather than a WeakMap, but the lookup intent is
        // identical, charter proposition 5 consistent abstraction).
        // Mirror only the spec-allowed CanvasConfiguration fields onto the
        // raw object so missing fields stay missing
        // (`'x' in src` feature-detection idiom).
        const mirrored: Record<string, unknown> = {};
        for (const key in desc as unknown as Record<string, unknown>) {
          mirrored[key] = (desc as unknown as Record<string, unknown>)[key];
        }
        // wgpu surfaces expose no presentation color space or tone mapping:
        // the surface is always sRGB-interpreted. Never forward the request;
        // getConfiguration omits both fields so callers detect the absence.
        delete mirrored.colorSpace;
        delete mirrored.toneMapping;
        if ('device' in mirrored) {
          const forgeaxDevice = desc.device as unknown as {
            _internal_raw?: unknown;
          };
          const rawDev = forgeaxDevice._internal_raw;
          if (rawDev !== undefined && rawDev !== null) {
            mirrored.device = rawDev;
          }
        }
        // Canvas dimensions own the drawing buffer; GPUCanvasConfiguration
        // has no independent extent. The native Surface needs those dimensions
        // explicitly, including when reacquisition follows a canvas resize.
        if (canvas !== undefined) {
          mirrored.width = canvas.width;
          mirrored.height = canvas.height;
        }
        rawContext.configure(mirrored as unknown as GPUCanvasConfiguration);
        surfaceDescriptor = {
          format: mirrored.format,
          usage: mirrored.usage,
          width: mirrored.width,
          height: mirrored.height,
        };
        presentationProof = rawContext.probeSurfacePresentation?.();
        if (presentationProof === undefined) {
          delete context.presentationProof;
        } else {
          context.presentationProof = presentationProof;
        }
        // Without a raw getter, successful configuration is the only accepted
        // fact. Otherwise the raw owner remains the configuration authority.
        const { colorSpace: _colorSpace, toneMapping: _toneMapping, ...supported } = desc;
        configuredWithoutGetter =
          rawContext.getConfiguration === undefined ? copyConfiguration(supported) : undefined;
        return ok(undefined);
      } catch (e) {
        // A fallible configure/probe must not leave a stale adopted projection.
        context.unconfigure();
        return webgpuRuntimeError(e);
      }
    },
    unconfigure(): void {
      // The final frame has no subsequent getCurrentTexture() call to drive
      // the normal auto-present path. Release it before wgpu destroys the
      // surface, or wasm-bindgen can drop a SurfaceTexture against a dead
      // Surface during renderer/page teardown. A failed present must not keep
      // the raw surface configured: teardown still owns the unconfigure call
      // and must run it even when the first cleanup step reports a cause.
      try {
        presentPendingSurfaceTexture();
      } catch {
        // Spec-aligned silent return — unconfigure is idempotent. The surface
        // is terminal from this owner's perspective, so the present cause is
        // not replayed into a replacement configuration.
      }
      try {
        rawContext.unconfigure();
      } catch {
        // Spec-aligned silent return — unconfigure is idempotent.
      }
      configuredWithoutGetter = undefined;
      surfaceDescriptor = {};
      delete context.presentationProof;
    },
    getConfiguration(): CanvasConfiguration | undefined {
      if (rawContext.getConfiguration === undefined)
        return configuredWithoutGetter === undefined
          ? undefined
          : copyConfiguration(configuredWithoutGetter);
      const c = rawContext.getConfiguration();
      if (c === null || c === undefined) return undefined;
      const {
        colorSpace: _colorSpace,
        toneMapping: _toneMapping,
        ...supported
      } = c as unknown as Record<string, unknown>;
      return copyConfiguration(supported as unknown as CanvasConfiguration);
    },
    getCurrentTexture(): Result<Texture, RhiError> {
      try {
        // bug-20260610: wgpu-wasm exposes the SurfaceTexture wrapper from
        // `getCurrentTexture()`; the spec-shaped GPUTexture lives one level
        // down at `.getTexture()`. Without this unwrap the engine passes a
        // `RhiWgpuSurfaceTexture` to `device.createTextureView` /
        // `commandEncoder.beginRenderPass` etc., and wasm-bindgen's
        // `_assertClass(texture, RhiWgpuTexture)` rejects.
        //
        // wgpu-wasm requires explicit `surfaceTexture.present()` while
        // browser-native WebGPU presents automatically after the submitted
        // frame. The renderer records and submits synchronously, so a microtask
        // presents after that stack without depending on rAF callback ordering.
        // Scene recording and UI composition may both acquire in this stack.
        // Presenting on the second read destroys the first pass's attachment
        // before queue.submit; retain the single acquired lease until the task ends.
        if (pendingPresentationError !== undefined) {
          const cause = pendingPresentationError;
          pendingPresentationError = undefined;
          throw cause;
        }
        if (
          canvas !== undefined &&
          (canvas.width !== surfaceDescriptor.width || canvas.height !== surfaceDescriptor.height)
        ) {
          const configuration = context.getConfiguration();
          if (configuration !== undefined) {
            const resized = context.configure(configuration);
            if (!resized.ok) return resized;
          }
        }
        if (pendingSurfaceTexture !== null) return ok(pendingSurfaceTexture.texture);
        const raw = rawContext.getCurrentTexture() as
          | { getTexture?: () => unknown; present?: () => void }
          | undefined;
        if (raw !== undefined && raw !== null && typeof raw.getTexture === 'function') {
          const texture = raw.getTexture() as unknown as Texture;
          if (typeof raw.present === 'function') {
            pendingSurfaceTexture = { raw: raw as { present: () => void }, texture };
            scheduleSurfaceTexturePresent(pendingSurfaceTexture);
          }
          annotateSurfaceTexture(texture);
          return ok(texture);
        }
        annotateSurfaceTexture(raw);
        return ok(raw as unknown as Texture);
      } catch (e) {
        return webgpuRuntimeError(e);
      }
    },
  };
  return context;
}

// Re-export so index.ts re-export chain stays linear.
export { adapterUnavailable };
