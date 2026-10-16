// packages/rhi-wgpu/src/buffer.ts — Buffer mapping 4-state lifecycle (w19).
//
// The `RhiWgpuBufferImpl` class implements the forgeax `Buffer` interface
// (`@forgeax/engine-rhi/src/index.ts` lines 56-125). It wraps a raw GPUBuffer /
// RhiWgpuBuffer handle and surfaces the 4-state mapping lifecycle via
// Result-wrapped methods (charter proposition 4 explicit failure):
//
//   - mapAsync(mode, offset?, size?) → Promise<Result<void, RhiError>>
//   - getMappedRange(offset?, size?) → Result<ArrayBuffer, RhiError>
//   - unmap()                         → void (spec literal alignment)
//   - mapState getter                 → 'unmapped' | 'pending' | 'mapped'
//
// The 4th Buffer-mapping surface item (`mappedAtCreation`) lives on
// BufferDescriptor (the wgpu / WebGPU side reads the field at create-time);
// the forgeax form keeps the field name verbatim (Pick<GPUBufferDescriptor,
// ...> mirror, AC-08 byte-for-byte gate). The `mappedAtCreation` flag flows
// through `RhiDevice.createBuffer(desc)` → raw createBuffer descriptor; no
// separate API surface on the Buffer brand.
//
// Failure paths surface 'webgpu-runtime-error' via webgpuRuntimeError; the
// M4 dawn-node integration (w24) narrows the dispatch to the 8 spec
// validation steps documented inline (mapState !== 'unmapped' / offset
// alignment / size alignment / overflow / mode bits / mode value /
// mode-usage mismatch). The M2 baseline keeps the single
// 'webgpu-runtime-error' code so AI users exhaustive switch stays complete.
//
// Anchors: plan-strategy §6 M2 + AC-08 surface gate + AGENTS.md break-point
//          list 2026-05-10 #2 buffer mapping full set; research §4 mapState
//          4-state lifecycle + §4.2 mapAsync 8-item validation + §4.4
//          unmap detach semantics.

/// <reference types="@webgpu/types" />

import {
  type Buffer,
  err,
  type MappedBuffer,
  ok,
  type Result,
  type RhiError,
  RhiError as RhiErrorClass,
} from '@forgeax/engine-rhi';
import { webgpuRuntimeError } from './errors';

/**
 * Factory for the `'destroy-after-destroy'` fail-fast error (feat-20260612
 * D-7); shared between `RhiWgpuBufferImpl.destroy` and
 * `RhiWgpuDeviceImpl.destroyTexture`. The hint copy mirrors
 * `@forgeax/engine-rhi-webgpu` (cross-shim parity: AI users see the same
 * hint regardless of backend).
 */
function doubleDestroy(expected: string): Result<never, RhiError> {
  return err(
    new RhiErrorClass({
      code: 'destroy-after-destroy',
      expected,
      hint: 'object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy',
    }),
  );
}

export { doubleDestroy };

/**
 * Minimal shape of a raw buffer handle the shim consumes. Methods optional
 * so the M2 baseline accepts both navigator.gpu GPUBuffer and wgpu wasm
 * RhiWgpuBuffer interchangeably.
 *
 * mappedAtCreation is read by the device's createBuffer descriptor at
 * create-time (not on the Buffer brand); it appears here only as the
 * read-back of the create-time decision through the mapState getter
 * (research §4.1 mapState 3-state enum transitions).
 */
export interface RawBufferLike {
  // forgeax-async-whitelist: wasm-bindgen — wgpu-wasm `Buffer.mapAsync()` raw entry
  // bug-20260610: u64 args accepted as number | bigint; the wasm-bindgen
  // class signature requires bigint, the navigator.gpu spec signature accepts
  // number. The shim coerces to BigInt at the call site.
  mapAsync?(mode: number, offset?: number | bigint, size?: number | bigint): Promise<void>;
  getMappedRange?(offset?: number | bigint, size?: number | bigint): ArrayBuffer;
  unmap?(): void;
  /**
   * wgpu wasm `RhiWgpuBuffer::destroy` (research §F-1; idempotent void on
   * the wasm side); navigator.gpu `GPUBuffer.destroy` (W3C §4 / idempotent
   * void per spec). The shim's `RhiWgpuBufferImpl.destroy()` calls this
   * exactly once per handle and bookkeeps the rest in TS (D-6).
   */
  destroy?(): void;
  readonly mapState?: 'unmapped' | 'pending' | 'mapped';
}

/**
 * Class form `RhiWgpuBufferImpl` — w19 acceptanceCheck grep anchor for the
 * Buffer mapping 4-state lifecycle. The class wraps a RawBufferLike handle
 * and routes mapAsync / getMappedRange / unmap / mapState through Result-
 * wrapped methods.
 *
 * The class is kept private to this module; consumers go through
 * `makeRhiBuffer(raw)` which casts through `Buffer` to apply the forgeax
 * Buffer brand. The brand is declared inside `@forgeax/engine-rhi` as a
 * unique-symbol property; the class shape carries the rest of the surface
 * (mapAsync / getMappedRange / unmap / mapState) and the cast at the
 * factory boundary is the canonical way to apply the brand (mirrors the
 * pattern used in @forgeax/engine-rhi-webgpu/src/device.ts; charter proposition 5
 * consistent abstraction: opaque brand stays opaque across the factory).
 *
 * feat-20260612 M1 / w5 — `destroy()` is the lifecycle-fail-fast entry
 * paired with `RhiDevice.destroyBuffer`. The class tracks a private
 * `destroyed: boolean`; the first call delegates to the wasm shim's
 * idempotent void `destroy()` and flips the flag; the second call returns
 * `Result.err({ code: 'destroy-after-destroy' })`. Charter proposition 4
 * explicit failure + plan-strategy D-7 (research §F-1: wgpu wasm
 * `js_name = destroy` is exposed and idempotent void; the bookkeeping
 * lives entirely on the TS shim layer per D-6).
 */
class RhiWgpuBufferImpl {
  private readonly raw: RawBufferLike;
  private destroyed: boolean = false;

  constructor(raw: RawBufferLike) {
    this.raw = raw;
  }

  /**
   * Destroy the underlying buffer. First call returns `Result.ok(undefined)`
   * after delegating to the wasm shim; second call on the same instance
   * returns `Result.err({ code: 'destroy-after-destroy' })` (D-7).
   *
   * Spec anchor: W3C WebGPU §gpubuffer-destroy + wgpu wasm
   * `RhiWgpuBuffer::destroy` (research §F-1; both surfaces are idempotent
   * void at the underlying GPU). The forgeax form prefers fail-fast
   * because double destroy is almost always a lifecycle bug.
   */
  destroy(): Result<void, RhiError> {
    if (this.destroyed) {
      return doubleDestroy('GPU buffer handle has not been destroyed yet');
    }
    try {
      if (typeof this.raw.destroy === 'function') {
        this.raw.destroy();
      }
    } catch (e) {
      return webgpuRuntimeError(e);
    }
    this.destroyed = true;
    return ok(undefined);
  }

  /**
   * Spec anchor: W3C WebGPU §gpubuffer-mapasync. M2 baseline routes the
   * raw handle's mapAsync into a Result-wrapped Promise. M4 dawn-node
   * integration (w24) narrows the dispatch by inspecting the thrown error
   * message into the 8 validation paths documented in @forgeax/engine-rhi Buffer.
   */
  async mapAsync(
    mode: GPUMapModeFlags,
    offset?: number | undefined,
    size?: number | undefined,
  ): Promise<Result<MappedBuffer, RhiError>> {
    if (this.raw.mapAsync === undefined) {
      return webgpuRuntimeError(new Error('underlying buffer handle does not expose mapAsync'));
    }
    try {
      // bug-20260610: u64 args coerce to BigInt for the wasm class signature.
      await this.raw.mapAsync.call(
        this.raw,
        mode,
        offset !== undefined ? BigInt(offset) : undefined,
        size !== undefined ? BigInt(size) : undefined,
      );
      // w29 — D-P2 #6 MappedBuffer brand cast (structural; same wrapper
      // object carries both Buffer surface + MappedBuffer methods because
      // the class shape has getMappedRange / unmap methods on the same
      // instance; the brand cast lets AI users hold a typed reference on
      // the success branch).
      return ok(this as unknown as MappedBuffer);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  /**
   * Spec anchor: W3C WebGPU §gpubuffer-getmappedrange. Returns the
   * ArrayBuffer view of the currently-mapped region; the forgeax Result
   * wrapper surfaces mapState !== 'mapped' / detach-guard failures via
   * webgpuRuntimeError.
   */
  getMappedRange(
    offset?: number | undefined,
    size?: number | undefined,
  ): Result<ArrayBuffer, RhiError> {
    if (this.raw.getMappedRange === undefined) {
      return webgpuRuntimeError(
        new Error('underlying buffer handle does not expose getMappedRange'),
      );
    }
    try {
      // bug-20260610: u64 args coerce to BigInt for the wasm class signature.
      const buf = this.raw.getMappedRange.call(
        this.raw,
        offset !== undefined ? BigInt(offset) : undefined,
        size !== undefined ? BigInt(size) : undefined,
      );
      return ok(buf);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  /**
   * Spec anchor: W3C WebGPU §gpubuffer-unmap. The forgeax form keeps the
   * spec void return — unmap is the single Result-shape exception in the
   * Buffer surface (research §4.4: unmap is a silent no-op when already
   * unmapped, so there is no error surface for AI users to consume).
   */
  unmap(): void {
    if (this.raw.unmap === undefined) return;
    this.raw.unmap.call(this.raw);
  }

  /**
   * mapState getter (research §4.1 3-state enum). Mirrors the spec
   * GPUBufferMapState transitions:
   *   - createBuffer({mappedAtCreation:true}) sets 'mapped'.
   *   - mapAsync moves 'unmapped' → 'pending' → 'mapped'.
   *   - unmap moves 'mapped' → 'unmapped'.
   *
   * Defaults to 'unmapped' when the raw handle does not expose the field
   * (charter proposition 4 explicit-failure baseline — no throw).
   */
  get mapState(): 'unmapped' | 'pending' | 'mapped' {
    return this.raw.mapState ?? 'unmapped';
  }
}

/**
 * Reverse-lookup map: forgeax `Buffer` brand → raw GPUBuffer / wgpu wasm
 * RhiWgpuBuffer handle (mirrors @forgeax/engine-rhi-webgpu BUFFER_RAW_MAP). The
 * map is the canonical bridge for any path that must hand the raw handle
 * back to the underlying GPU (e.g. encoder.copyBufferToBuffer / queue.
 * submit / writeBuffer): the forgeax method accepts `Buffer` brand but the
 * raw call needs the raw handle. Charter proposition 5 consistent
 * abstraction: AI users never touch the raw handle directly; the shim
 * resolves it internally via this map (M4 w24 integration plumbing).
 */
export const BUFFER_RAW_MAP: WeakMap<Buffer, RawBufferLike> = new WeakMap();

/**
 * Public factory — wraps a raw buffer handle in the forgeax Buffer brand.
 *
 * The factory is the single legal way for shim consumers to obtain a forgeax
 * Buffer; holding the class private behind the factory keeps the forgeax
 * Buffer brand opaqueness intact (charter proposition 5 consistent
 * abstraction red line). The reverse map registration lets command-encoder /
 * queue paths recover the raw handle without exposing it through the forgeax
 * surface.
 */
export function makeRhiBuffer(raw: RawBufferLike): Buffer {
  const wrapper = new RhiWgpuBufferImpl(raw) as unknown as Buffer;
  BUFFER_RAW_MAP.set(wrapper, raw);
  return wrapper;
}

/**
 * Resolve a forgeax Buffer brand back to the raw handle for downstream raw-
 * call sites (encoder copy / queue write). Falls through to the brand value
 * itself when the brand is not registered (test fixtures that bypass the
 * factory still work, charter proposition 4 explicit-failure baseline — no
 * throw on miss).
 */
export function unwrapBuffer(buffer: Buffer): unknown {
  return BUFFER_RAW_MAP.get(buffer) ?? buffer;
}
