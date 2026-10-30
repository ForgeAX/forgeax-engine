// packages/rhi-wgpu/src/queue.ts — RhiQueue implementation (w18).
//
// The class form `RhiWgpuQueueImpl implements RhiQueue` wraps a raw queue
// handle (navigator.gpu GPUQueue or wgpu wasm RhiWgpuQueue) and exposes the
// forgeax RhiQueue surface through Result-wrapped methods (charter
// proposition 4 explicit failure).
//
// Surface (mirrors @forgeax/engine-rhi/src/index.ts RhiQueue):
//   - submit(commandBuffers)
//   - writeBuffer(buffer, bufferOffset, data, dataOffset?, size?)
//   - writeTexture(destination, data, dataLayout, size)
//   - copyExternalImageToTexture(source, destination, copySize)
//   - onSubmittedWorkDone()
//
// M2 baseline routes each call through try/catch into structured Result;
// the M4 dawn-node integration tests (w24) exercise the real wgpu plumbing.
//
// Anchors: plan-strategy §6 M2 + AC-08 byte-for-byte mirror; charter
// proposition 5 consistent abstraction.

/// <reference types="@webgpu/types" />

import {
  type Buffer,
  type CommandBuffer,
  createQueueCompletionHold,
  type ExternalImageTextureDestination,
  err,
  ok,
  queueSubmitFailed,
  type Result,
  type RhiError,
  type RhiQueue,
  type TexelCopyTextureInfo,
  textureCopyOrigin,
} from '@forgeax/engine-rhi';
import { unwrapBuffer } from './buffer';
import { webgpuRuntimeError } from './errors';
import { driveNativeCompletion, type NativeCompletionDriver } from './internal/native-completion';

// bug-20260622 R5 WS2: the wgpu-wasm submit() (rhi.rs) now returns Result and,
// when a submit-period validation error landed in the on_uncaptured_error
// slot, throws a JsValue string prefixed `[rhi-code:<code>]`. The Rust side is
// the single classification SSOT (classify_uncaptured_error, M3); the shim only
// reads the prefix to route into the matching RhiError factory. Errors without
// the marker (navigator.gpu GPUQueue throws, wasm traps) fall through to the
// webgpu-runtime-error catch-all so no failure is ever swallowed.
const RHI_CODE_PREFIX = '[rhi-code:';

/**
 * Route a caught submit() error into the correct RhiError factory. A wgpu-wasm
 * submit-period validation failure arrives as `[rhi-code:queue-submit-failed]
 * <message>`; anything else (including navigator.gpu exceptions and wasm traps)
 * maps to webgpu-runtime-error. The queue instance survives either way (AC-06).
 */
function classifySubmitError(cause: unknown): ReturnType<typeof webgpuRuntimeError> {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.startsWith(RHI_CODE_PREFIX)) {
    const close = message.indexOf(']');
    const code = message.slice(RHI_CODE_PREFIX.length, close);
    const detail = message.slice(close + 1).trim();
    if (code === 'queue-submit-failed') {
      return err(queueSubmitFailed(detail));
    }
  }
  return webgpuRuntimeError(cause);
}

/**
 * bug-20260610 helper: pack the spec aspect string into the u8 the wasm
 * side reads (0 = all, 1 = stencil-only, 2 = depth-only). Matches
 * `packages/wgpu-wasm/src/rhi.rs::aspect_from_u8`.
 */
export function aspectToU8(aspect: GPUTextureAspect | undefined): number {
  if (aspect === 'stencil-only') return 1;
  if (aspect === 'depth-only') return 2;
  return 0;
}

/**
 * bug-20260610 helper: normalise spec `GPUExtent3DStrict` (which can be a
 * dict, an iterable, or a 1/2/3-element array) into a `{width, height,
 * depthOrArrayLayers}` triple with sensible defaults.
 */
export function normalizeExtent(size: GPUExtent3DStrict): {
  width: number;
  height: number;
  depthOrArrayLayers: number;
} {
  if (Array.isArray(size)) {
    const w = (size[0] as number | undefined) ?? 1;
    const h = (size[1] as number | undefined) ?? 1;
    const d = (size[2] as number | undefined) ?? 1;
    return { width: w, height: h, depthOrArrayLayers: d };
  }
  const dict = size as GPUExtent3DDict;
  return {
    width: dict.width,
    height: dict.height ?? 1,
    depthOrArrayLayers: dict.depthOrArrayLayers ?? 1,
  };
}

/**
 * Minimal shape of a wgpu-wasm or navigator.gpu queue handle the TS shim
 * consumes. Methods optional so the M2 baseline accepts the navigator.gpu
 * GPUQueue (concrete class) and the M3 wgpu wasm `RhiWgpuQueue` handle
 * interchangeably (charter proposition 5 consistent abstraction).
 */
export interface RawQueueLike {
  submit?(buffers: readonly unknown[]): void;
  // bug-20260610: u64 args accepted as number | bigint; the wasm-bindgen
  // class signature requires bigint, the navigator.gpu spec signature accepts
  // number. The shim coerces to BigInt at the call site.
  writeBuffer?(
    buffer: unknown,
    offset: number | bigint,
    data: unknown,
    dataOffset?: number | bigint,
    size?: number | bigint,
  ): void;
  // bug-20260610 Gap 9: the wgpu-wasm class signature is the flat 13-arg form
  // `(texture, mipLevel, originX, originY, originZ, aspect, data, layoutOffset,
  // bytesPerRow, rowsPerImage, sizeWidth, sizeHeight, sizeDepth)`. The
  // navigator.gpu spec form `(destination, data, dataLayout, size)` is no
  // longer covered here because rhi-wgpu only ever wraps the wasm queue;
  // navigator.gpu integration lives in @forgeax/engine-rhi-webgpu.
  writeTexture?(...args: unknown[]): void;
  // Flat 15-arg form `(source, sourceOriginX, sourceOriginY, flipY, texture,
  // mipLevel, originX, originY, originZ, aspect, displayP3, premultipliedAlpha,
  // sizeWidth, sizeHeight, sizeDepth)`; the texture is borrowed as in writeTexture.
  copyExternalImageToTexture?(...args: unknown[]): void;
  // forgeax-async-whitelist: wasm-bindgen — wgpu-wasm `Queue.onSubmittedWorkDone()` raw entry
  onSubmittedWorkDone?(driver: NativeCompletionDriver): Promise<undefined>;
}

class RhiWgpuQueueImpl implements RhiQueue {
  private readonly raw: RawQueueLike;
  private readonly completions = createQueueCompletionHold();
  constructor(raw: RawQueueLike) {
    this.raw = raw;
  }

  submit(commandBuffers: readonly CommandBuffer[]): Result<void, RhiError> {
    if (this.raw.submit === undefined) {
      return webgpuRuntimeError(new Error('underlying queue handle does not expose submit'));
    }
    try {
      this.raw.submit.call(this.raw, commandBuffers);
      return ok(undefined);
    } catch (e) {
      return classifySubmitError(e);
    }
  }

  writeBuffer(
    buffer: Buffer,
    bufferOffset: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number | undefined,
    size?: number | undefined,
  ): Result<void, RhiError> {
    if (this.raw.writeBuffer === undefined) {
      return webgpuRuntimeError(new Error('underlying queue handle does not expose writeBuffer'));
    }
    try {
      // Resolve forgeax Buffer brand → raw GPUBuffer (charter proposition 5
      // consistent abstraction). The dawn-node real-GPU path validates the
      // first argument against `GPUBuffer` interface and rejects the
      // forgeax wrapper class with "object is not of the correct interface
      // type"; the unwrap closes that boundary (M4 w25 integration plumbing).
      const rawBuffer = unwrapBuffer(buffer);
      // bug-20260610: the wgpu-wasm class signature takes u64 args as JS
      // BigInt (wasm-bindgen u64 ABI). Forgeax callers always pass Number
      // (the spec-aligned WebGPU JS shape); coerce at the boundary so the
      // wasm class accepts. Safari WebGL2 fallback throws
      // "Invalid argument type in ToBigInt operation" without this coerce.
      // bug-20260610: wasm-bindgen `&[u8]` expects a Uint8Array; coerce any
      // ArrayBuffer / strided typed-array view at the boundary (same shape
      // logic as writeTexture above).
      const bytes =
        data instanceof Uint8Array
          ? data
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data as ArrayBuffer);
      this.raw.writeBuffer.call(
        this.raw,
        rawBuffer,
        BigInt(bufferOffset),
        bytes,
        dataOffset !== undefined ? BigInt(dataOffset) : undefined,
        size !== undefined ? BigInt(size) : undefined,
      );
      return ok(undefined);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  writeTexture(
    destination: TexelCopyTextureInfo,
    data: ArrayBufferView | ArrayBuffer,
    dataLayout: GPUTexelCopyBufferLayout,
    size: GPUExtent3DStrict,
  ): Result<void, RhiError> {
    if (this.raw.writeTexture === undefined) {
      return webgpuRuntimeError(new Error('underlying queue handle does not expose writeTexture'));
    }
    try {
      // bug-20260610: wasm-bindgen `&[u8]` expects a Uint8Array specifically;
      // raw ArrayBuffer or strided typed-array views need normalization to a
      // Uint8Array view over the same bytes.
      const bytes =
        data instanceof Uint8Array
          ? data
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data as ArrayBuffer);
      // bug-20260610 Gap 9: flatten the spec descriptors to the wgpu-wasm
      // 13-arg form. The earlier "JsValue descriptor" form caused
      // `try_from_js_value(destination.texture)` on the wasm side to
      // CONSUME the JS-side `__wbg_ptr` (zero it), so the very next call
      // that took the same texture saw a null pointer. Passing the texture
      // as a `&RhiWgpuTexture` borrows instead.
      const origin = textureCopyOrigin(destination.origin);
      const ext = normalizeExtent(size);
      this.raw.writeTexture.call(
        this.raw,
        destination.texture,
        destination.mipLevel ?? 0,
        origin.x,
        origin.y,
        origin.z,
        aspectToU8(destination.aspect),
        bytes,
        BigInt(dataLayout.offset ?? 0),
        dataLayout.bytesPerRow,
        dataLayout.rowsPerImage,
        ext.width,
        ext.height,
        ext.depthOrArrayLayers,
      );
      return ok(undefined);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  copyExternalImageToTexture(
    source: GPUCopyExternalImageSourceInfo,
    destination: ExternalImageTextureDestination,
    copySize: GPUExtent3DStrict,
  ): Result<void, RhiError> {
    if (this.raw.copyExternalImageToTexture === undefined) {
      return webgpuRuntimeError(
        new Error('underlying queue handle does not expose copyExternalImageToTexture'),
      );
    }
    try {
      const sourceOrigin = textureCopyOrigin(source.origin);
      const origin = textureCopyOrigin(destination.origin);
      const ext = normalizeExtent(copySize);
      this.raw.copyExternalImageToTexture.call(
        this.raw,
        source.source,
        sourceOrigin.x,
        sourceOrigin.y,
        source.flipY ?? false,
        destination.texture,
        destination.mipLevel ?? 0,
        origin.x,
        origin.y,
        origin.z,
        aspectToU8(destination.aspect),
        destination.colorSpace === 'display-p3',
        destination.premultipliedAlpha ?? false,
        ext.width,
        ext.height,
        ext.depthOrArrayLayers,
      );
      return ok(undefined);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  // forgeax-async-whitelist: wasm-bindgen — wgpu-wasm `Queue.onSubmittedWorkDone()` Promise passthrough
  onSubmittedWorkDone(): Promise<undefined> {
    return this.completions.deliver(this.nativeCompletion());
  }

  holdCompletions(): () => void {
    return this.completions.hold();
  }

  onSubmittedWorkDoneUnheld(): Promise<undefined> {
    return this.nativeCompletion();
  }

  // forgeax-async-whitelist: wasm-bindgen — actual native completion registration
  private nativeCompletion(): Promise<undefined> {
    if (this.raw.onSubmittedWorkDone === undefined) {
      return Promise.resolve().then(() =>
        webgpuRuntimeError(new Error('queue has no native GPU completion primitive')).unwrap(),
      );
    }
    try {
      return this.raw.onSubmittedWorkDone.call(this.raw, driveNativeCompletion);
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

export function makeRhiQueue(raw: RawQueueLike): RhiQueue {
  return new RhiWgpuQueueImpl(raw);
}
