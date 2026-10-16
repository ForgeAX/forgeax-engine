// @forgeax/engine-runtime / gpu-resource
//
// feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M2 / w7 + w8.
//
// Runtime-side wrappers around RHI Buffer / Texture opaque handles that
// expose an explicit `.destroy()` lifecycle and an `isDestroyed` flag.
//
// Design rationale (charter + plan-strategy + architecture-principles):
//
//   - SSOT (architecture-principles §1): the lifecycle bookkeeping (the
//     "is this handle destroyed yet?" fact) lives once in the RHI shim
//     layer (rhi-webgpu device.ts: BUFFER_META_MAP / TEXTURE_META_MAP;
//     rhi-wgpu device.ts: same shape over the wgpu wasm boundary). The
//     runtime wrapper does NOT keep its own destroyed: Set; it forwards
//     to `device.destroyBuffer(handle)` / `device.destroyTexture(handle)`
//     and lets the RHI shim be the authority. The local `destroyed`
//     boolean is a derived view (architecture-principles §2 Derive,
//     Don't Duplicate) for the synchronous `isDestroyed` getter --
//     flipped on the success branch of the forward, never on the err
//     branch (so a second destroy preserves the prior `true`).
//
//   - Concept compression (charter F1 / AGENTS.md design axiom): a
//     single union `type GpuResource = GpuBuffer | GpuTexture` covers
//     both buffer and texture lifecycles so AI-user-facing code that
//     just wants "a GPU resource I need to dispose" reaches one
//     symbol. Parallel classes (not a runtime-tagged generic
//     `GpuResource<'buffer' | 'texture'>`) so the shape mirrors the
//     RHI opaque-handle taxonomy verbatim and TS narrowing on
//     instanceof / `'data' in r` keeps each branch typed end-to-end
//     (plan-strategy D-2).
//
//   - v1 single-owner immortal (requirements §Constraints 8): no refcount,
//     no shared ownership, no move semantics. The wrapper holds the
//     handle once; whoever constructed it disposes it. A future
//     refcount layer (if needed) wraps GpuResource externally without
//     re-entering this file.
//
//   - Plain boolean isDestroyed (plan-strategy D-5): no typed-state
//     narrowing (i.e. no `Live<GpuBuffer>` / `Destroyed<GpuBuffer>`
//     compile-time partition). The check happens at runtime via the
//     getter; the RHI fail-fast on second destroy is the structural
//     guard. Keeps the public type surface flat (charter F1: one
//     symbol, not three states).
//
//   - RHI stays spec-aligned and opaque-handle-only (requirements
//     §Constraints 3): GpuResource is a runtime concept; the RHI package
//     exports no wrapper class.
//
// Failure paths (forwarded verbatim from RhiDevice):
//   - second `.destroy()` on the same wrapper -> `Result.err({ code:
//     'destroy-after-destroy', ... })` (RHI errors.ts §RhiErrorCode;
//     introduced in feat-20260612 M1 / w1).

import type { Buffer, Result, RhiDevice, RhiError, Texture } from '@forgeax/engine-rhi';
import type { DeviceScope } from './device/device-scope';

/**
 * Runtime wrapper around an RHI `Buffer` opaque handle that exposes
 * an explicit `.destroy()` lifecycle.
 *
 * Holds the device by reference (no clone); the device's own lifetime
 * outlives the buffer. After `.destroy()` returns ok, `isDestroyed`
 * flips to true; a second `.destroy()` returns err code
 * `'destroy-after-destroy'` forwarded from `device.destroyBuffer(...)`.
 *
 * @example
 *   import { GpuBuffer } from './gpu-resource';
 *   const created = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE });
 *   if (!created.ok) return;
 *   const gpuBuf = new GpuBuffer(device, created.value);
 *   // ... use gpuBuf.handle in RHI calls ...
 *   const r = gpuBuf.destroy();
 *   if (!r.ok) {
 *     // r.error.code is one of the RhiErrorCode union members,
 *     // typically 'destroy-after-destroy' on a stale handle.
 *   }
 */
export class GpuBuffer {
  readonly device: RhiDevice;
  readonly handle: Buffer;
  // SSOT note: the canonical destroyed: boolean lives on the RHI shim's
  // BUFFER_META_MAP. This local flag is a derived view written only on
  // the success branch of `device.destroyBuffer(...)`; charter §F1.
  private destroyed = false;
  private releaseScope: (() => void) | undefined;

  constructor(device: RhiDevice, handle: Buffer, scope?: DeviceScope) {
    this.device = device;
    this.handle = handle;
    if (scope !== undefined) {
      const ref = scope._adopt('buffer', this, (value) => {
        if (!value.isDestroyed) value.destroy();
      });
      this.releaseScope = () => scope._release(ref);
    }
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Destroy the underlying GPU buffer. Forwards to
   * `device.destroyBuffer(handle)`; on ok flips `isDestroyed` to true,
   * on err leaves the flag unchanged so a downstream second destroy
   * still surfaces the underlying RHI fail-fast.
   */
  destroy(): Result<void, RhiError> {
    const r = this.device.destroyBuffer(this.handle);
    if (r.ok) {
      this.destroyed = true;
      this.releaseScope?.();
      this.releaseScope = undefined;
    }
    return r;
  }
}

/**
 * Runtime wrapper around an RHI `Texture` opaque handle that exposes
 * an explicit `.destroy()` lifecycle. Mirrors `GpuBuffer` exactly --
 * the only difference is the underlying RHI surface
 * (`device.destroyTexture` instead of `device.destroyBuffer`) and the
 * handle brand. Same SSOT rationale: the destroyed bookkeeping lives
 * on the RHI shim's TEXTURE_META_MAP; the local flag is a derived view.
 *
 * @example
 *   import { GpuTexture } from './gpu-resource';
 *   const r = device.createTexture({ size: [w, h, 1], format: 'rgba8unorm', usage: ... });
 *   if (!r.ok) return;
 *   const gpuTex = new GpuTexture(device, r.value);
 *   // ... use gpuTex.handle in RHI calls ...
 *   gpuTex.destroy();
 */
export class GpuTexture {
  readonly device: RhiDevice;
  readonly handle: Texture;
  private destroyed = false;
  private releaseScope: (() => void) | undefined;

  constructor(device: RhiDevice, handle: Texture, scope?: DeviceScope) {
    this.device = device;
    this.handle = handle;
    if (scope !== undefined) {
      const ref = scope._adopt('texture', this, (value) => {
        if (!value.isDestroyed) value.destroy();
      });
      this.releaseScope = () => scope._release(ref);
    }
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Destroy the underlying GPU texture. Forwards to
   * `device.destroyTexture(handle)`; ok branch sets `isDestroyed=true`.
   */
  destroy(): Result<void, RhiError> {
    const r = this.device.destroyTexture(this.handle);
    if (r.ok) {
      this.destroyed = true;
      this.releaseScope?.();
      this.releaseScope = undefined;
    }
    return r;
  }
}

/**
 * Union of runtime-managed GPU resources requiring explicit
 * `.destroy()`. AI-user-facing code that needs to dispose "a GPU
 * resource" types its parameter as `GpuResource` and lets TS narrow
 * via `instanceof GpuBuffer / GpuTexture` if branch-specific access
 * is required. Charter F1 single-entry indexability.
 */
export type GpuResource = GpuBuffer | GpuTexture;
