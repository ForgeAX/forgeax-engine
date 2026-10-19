// Command and compute recording over the pinned WASM command surface.

/// <reference types="@webgpu/types" />

import {
  type Buffer,
  type CommandBuffer,
  type ComputePassDescriptor,
  commandEncoderFinished,
  err,
  ok,
  type QuerySet,
  RAY_QUERY_BACKEND_UNSUPPORTED,
  type RenderPassDescriptor,
  type Result,
  type RhiCommandEncoder,
  type RhiComputePassEncoder,
  type RhiError,
  type RhiRenderPassEncoder,
  rayQueryUnsupported,
  type TexelCopyBufferInfo,
  type TexelCopyTextureInfo,
  textureCopyOrigin,
} from '@forgeax/engine-rhi';
import { unwrapBuffer } from './buffer';
import { webgpuRuntimeError } from './errors';
import { aspectToU8, normalizeExtent } from './queue';
import {
  colorForWasm,
  makeRhiRenderPassEncoder,
  type RawRenderPassLike,
} from './render-pass-encoder';

/** Required command surface of the pinned wgpu WASM artifact. */
export interface RawCommandEncoderLike {
  beginRenderPass(desc: unknown): RawRenderPassLike;
  beginComputePass(desc?: unknown): RawComputePassLike;
  // Native u64 arguments are bigint; the RHI facade accepts numbers.
  // bug-20260610 Gap 12: copy* signatures match the wgpu-wasm flat-args form
  // (handles by reference + flat numeric args). The earlier JsValue desc
  // form caused `try_from_js_value` to consume `__wbg_ptr`, breaking
  // any caller that reused the same handle next. See queue.ts writeTexture.
  copyBufferToBuffer(...args: unknown[]): void;
  copyBufferToTexture(...args: unknown[]): void;
  copyTextureToBuffer(...args: unknown[]): void;
  copyTextureToTexture(...args: unknown[]): void;
  clearBuffer(buffer: unknown, offset?: bigint, size?: bigint): void;
  resolveQuerySet(
    querySet: unknown,
    firstQuery: number,
    queryCount: number,
    destination: unknown,
    destinationOffset: number,
  ): void;
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
  insertDebugMarker(label: string): void;
  finish(): unknown;
}

export interface RawComputePassLike {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, bindGroup: unknown, dynamicOffsets?: readonly number[]): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  dispatchWorkgroupsIndirect(buffer: unknown, offset: bigint): void;
  end(): void;
}

function makeRhiComputePassEncoder(raw: RawComputePassLike): RhiComputePassEncoder {
  return {
    setPipeline(pipeline) {
      raw.setPipeline.call(raw, pipeline);
    },
    setBindGroup(index, bindGroup, dynamicOffsets) {
      raw.setBindGroup.call(raw, index, bindGroup, dynamicOffsets);
    },
    dispatchWorkgroups(x, y, z) {
      raw.dispatchWorkgroups.call(raw, x, y, z);
    },
    dispatchWorkgroupsIndirect(indirectBuffer, indirectOffset) {
      raw.dispatchWorkgroupsIndirect.call(
        raw,
        unwrapBuffer(indirectBuffer),
        BigInt(indirectOffset),
      );
    },
    end() {
      raw.end.call(raw);
    },
  };
}

// bug-20260610 Gap 12: the earlier `unwrapBufferField` helper (which spread
// the descriptor object and replaced `.buffer` with the raw handle) is
// removed because the copy* methods now pass flat numeric args + bare
// buffer/texture handles to the wgpu-wasm class signature. See queue.ts
// `aspectToU8` / `normalizeExtent`.

class RhiWgpuCommandEncoderImpl implements RhiCommandEncoder {
  private readonly raw: RawCommandEncoderLike;
  private finished = false;
  constructor(raw: RawCommandEncoderLike) {
    this.raw = raw;
  }

  beginRenderPass(desc: RenderPassDescriptor): RhiRenderPassEncoder {
    const raw = this.raw.beginRenderPass.call(this.raw, {
      ...desc,
      colorAttachments: Array.from(desc.colorAttachments ?? [], (attachment) =>
        attachment?.clearValue === undefined
          ? attachment
          : {
              ...attachment,
              clearValue: colorForWasm(attachment.clearValue),
            },
      ),
    });
    return makeRhiRenderPassEncoder(raw);
  }

  beginComputePass(desc?: ComputePassDescriptor | undefined): RhiComputePassEncoder {
    const raw = this.raw.beginComputePass.call(this.raw, desc);
    return makeRhiComputePassEncoder(raw);
  }

  encodeEmptyComputePass(desc: ComputePassDescriptor): void {
    const raw = this.raw.beginComputePass.call(this.raw, desc);
    raw.end.call(raw);
  }

  copyBufferToBuffer(...args: unknown[]): void {
    // Resolve forgeax Buffer brand back to the raw GPUBuffer for the raw call
    // (charter proposition 5 consistent abstraction across the boundary; the
    // M4 w24 integration test exercises this path end-to-end on dawn-node).
    // The spec signature is
    // `(srcBuf, srcOffset?, dstBuf, dstOffset?, size?)` — args[0] / args[2]
    // are the buffer brands that need unwrapping; everything else passes
    // through untouched.
    // bug-20260610: u64 args (args[1] = sourceOffset, args[3] = destOffset,
    // args[4] = size) coerce to BigInt for the wasm class signature. Safari
    // WebGL2 fallback throws "Invalid argument type in ToBigInt" without this.
    const unwrapped = args.map((v, i) => {
      if (i === 0 || i === 2) return unwrapBuffer(v as Buffer);
      if (i === 1 || i === 3 || i === 4) {
        if (v === undefined) return v;
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number') return BigInt(v);
      }
      return v;
    });
    this.raw.copyBufferToBuffer.call(this.raw, ...unwrapped);
  }

  copyBufferToTexture(
    source: TexelCopyBufferInfo,
    destination: TexelCopyTextureInfo,
    size: GPUExtent3DStrict,
  ): void {
    // bug-20260610 Gap 12: flatten the spec descriptors to the wgpu-wasm
    // 13-arg form. Texture / buffer handles must be passed by reference
    // (not pulled out of a JsValue with try_from_js_value, which consumes
    // __wbg_ptr).
    const src = source;
    const dst = destination;
    const dstOrigin = textureCopyOrigin(dst.origin);
    const ext = normalizeExtent(size as GPUExtent3DStrict);
    this.raw.copyBufferToTexture.call(
      this.raw,
      unwrapBuffer(src.buffer as unknown as Buffer),
      BigInt(src.offset ?? 0),
      src.bytesPerRow,
      src.rowsPerImage,
      dst.texture,
      dst.mipLevel ?? 0,
      dstOrigin.x,
      dstOrigin.y,
      dstOrigin.z,
      aspectToU8(dst.aspect),
      ext.width,
      ext.height,
      ext.depthOrArrayLayers,
    );
  }

  copyTextureToBuffer(
    source: TexelCopyTextureInfo,
    destination: TexelCopyBufferInfo,
    size: GPUExtent3DStrict,
  ): void {
    // bug-20260610 Gap 12: flatten to the wgpu-wasm 13-arg form.
    const src = source;
    const dst = destination;
    const srcOrigin = textureCopyOrigin(src.origin);
    const ext = normalizeExtent(size as GPUExtent3DStrict);
    this.raw.copyTextureToBuffer.call(
      this.raw,
      src.texture,
      src.mipLevel ?? 0,
      srcOrigin.x,
      srcOrigin.y,
      srcOrigin.z,
      aspectToU8(src.aspect),
      unwrapBuffer(dst.buffer as unknown as Buffer),
      BigInt(dst.offset ?? 0),
      dst.bytesPerRow,
      dst.rowsPerImage,
      ext.width,
      ext.height,
      ext.depthOrArrayLayers,
    );
  }

  copyTextureToTexture(
    source: TexelCopyTextureInfo,
    destination: TexelCopyTextureInfo,
    size: GPUExtent3DStrict,
  ): void {
    // bug-20260610 Gap 12: flatten to the wgpu-wasm 15-arg form.
    const src = source;
    const dst = destination;
    const srcOrigin = textureCopyOrigin(src.origin);
    const dstOrigin = textureCopyOrigin(dst.origin);
    const ext = normalizeExtent(size as GPUExtent3DStrict);
    this.raw.copyTextureToTexture.call(
      this.raw,
      src.texture,
      src.mipLevel ?? 0,
      srcOrigin.x,
      srcOrigin.y,
      srcOrigin.z,
      aspectToU8(src.aspect),
      dst.texture,
      dst.mipLevel ?? 0,
      dstOrigin.x,
      dstOrigin.y,
      dstOrigin.z,
      aspectToU8(dst.aspect),
      ext.width,
      ext.height,
      ext.depthOrArrayLayers,
    );
  }

  clearBuffer(buffer: Buffer, offset?: number | undefined, size?: number | undefined): void {
    // bug-20260610: u64 args coerce to BigInt for the wasm class signature.
    this.raw.clearBuffer.call(
      this.raw,
      unwrapBuffer(buffer),
      offset !== undefined ? BigInt(offset) : undefined,
      size !== undefined ? BigInt(size) : undefined,
    );
  }

  resolveQuerySet(
    querySet: QuerySet,
    firstQuery: number,
    queryCount: number,
    destination: Buffer,
    destinationOffset: number,
  ): Result<void, RhiError> {
    try {
      this.raw.resolveQuerySet.call(
        this.raw,
        querySet,
        firstQuery,
        queryCount,
        unwrapBuffer(destination),
        destinationOffset,
      );
      return ok(undefined);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  pushDebugGroup(groupLabel: string): void {
    this.raw.pushDebugGroup.call(this.raw, groupLabel);
  }

  popDebugGroup(): void {
    this.raw.popDebugGroup.call(this.raw);
  }

  insertDebugMarker(markerLabel: string): void {
    this.raw.insertDebugMarker.call(this.raw, markerLabel);
  }

  buildAccelerationStructures(): Result<void, RhiError> {
    return rayQueryUnsupported('buildAccelerationStructures', RAY_QUERY_BACKEND_UNSUPPORTED);
  }

  finish(): Result<CommandBuffer, RhiError> {
    if (this.finished) return err(commandEncoderFinished());
    try {
      const buf = this.raw.finish.call(this.raw);
      this.finished = true;
      return ok(buf as CommandBuffer);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }
}

export function makeRhiCommandEncoder(raw: RawCommandEncoderLike): RhiCommandEncoder {
  return new RhiWgpuCommandEncoderImpl(raw);
}
