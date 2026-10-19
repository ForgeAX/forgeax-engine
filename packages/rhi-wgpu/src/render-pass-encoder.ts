// Render pass and immutable bundle adapters over native wgpu/WASM handles.
// Shared draw, binding and debug commands use one forwarding surface.
// Native failures retain the RHI structured error boundary.

/// <reference types="@webgpu/types" />

import {
  type BindGroup,
  type Buffer,
  commandEncoderFinished,
  err,
  ok,
  type RenderBundle,
  type RenderPipeline,
  type Result,
  type RhiError,
  type RhiRenderBundleEncoder,
  type RhiRenderCommands,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { unwrapBuffer } from './buffer';
import { webgpuRuntimeError } from './errors';

/** Required draw/binding commands shared by a WASM render pass and bundle. */
export interface RawRenderCommandsLike {
  setPipeline(pipeline: unknown): void;
  // Native u64 arguments are bigint; the RHI facade accepts numbers.
  setVertexBuffer(slot: number, buffer: unknown, offset: bigint, size?: bigint): void;
  setIndexBuffer(buffer: unknown, format: string, offset?: bigint, size?: bigint): void;
  setBindGroup(...args: unknown[]): void;
  draw(
    vertexCount: number,
    instanceCount: number | undefined,
    firstVertex: number,
    firstInstance: number,
  ): void;
  drawIndexed(
    indexCount: number,
    instanceCount: number | undefined,
    firstIndex: number,
    baseVertex: number,
    firstInstance: number,
  ): void;
  // bug-20260610: u64 indirectOffset coerces to BigInt for the wasm class
  // signature.
  drawIndirect(indirectBuffer: unknown, indirectOffset: bigint): void;
  drawIndexedIndirect(indirectBuffer: unknown, indirectOffset: bigint): void;
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
  insertDebugMarker(label: string): void;
}

/** Pass-only state and submission commands are not part of render bundles. */
export interface RawRenderPassLike extends RawRenderCommandsLike {
  end(): void;
  setViewport(x: number, y: number, w: number, h: number, minDepth: number, maxDepth: number): void;
  setScissorRect(x: number, y: number, w: number, h: number): void;
  setBlendConstant(color: unknown): void;
  setStencilReference(reference: number): void;
  executeBundles(bundles: Iterable<unknown>): void;
  beginOcclusionQuery(queryIndex: number): void;
  endOcclusionQuery(): void;
}

export interface RawRenderBundleLike extends RawRenderCommandsLike {
  finish(desc?: unknown): unknown;
}

class RhiWgpuRenderCommands implements RhiRenderCommands {
  protected readonly raw: RawRenderCommandsLike;
  constructor(raw: RawRenderCommandsLike) {
    this.raw = raw;
  }

  setPipeline(pipeline: RenderPipeline): void {
    this.raw.setPipeline.call(this.raw, pipeline);
  }

  setVertexBuffer(
    slot: number,
    buffer: Buffer,
    offset?: number | undefined,
    size?: number | undefined,
  ): void {
    // Resolve forgeax Buffer brand → raw GPUBuffer (M4 w25 integration; the
    // wrapped Buffer is rejected by dawn-node validation with
    // "object is not of the correct interface type").
    // bug-20260610: u64 args coerce to BigInt for the wasm class signature.
    // Safari WebGL2 fallback throws "Invalid argument type in ToBigInt"
    // without this. The 0 default mirrors the WebGPU spec.
    this.raw.setVertexBuffer.call(
      this.raw,
      slot,
      unwrapBuffer(buffer),
      offset !== undefined ? BigInt(offset) : BigInt(0),
      size !== undefined ? BigInt(size) : undefined,
    );
  }

  setIndexBuffer(
    buffer: Buffer,
    format: 'uint16' | 'uint32',
    offset?: number | undefined,
    size?: number | undefined,
  ): void {
    // bug-20260610: u64 → BigInt coerce (see setVertexBuffer above).
    this.raw.setIndexBuffer.call(
      this.raw,
      unwrapBuffer(buffer),
      format,
      offset !== undefined ? BigInt(offset) : BigInt(0),
      size !== undefined ? BigInt(size) : undefined,
    );
  }

  setBindGroup(
    index: number,
    bindGroup: BindGroup,
    dynamicOffsetsData?: readonly number[] | Uint32Array | undefined,
    dynamicOffsetsDataStart?: number | undefined,
    dynamicOffsetsDataLength?: number | undefined,
  ): void {
    if (dynamicOffsetsDataLength !== undefined) {
      this.raw.setBindGroup.call(
        this.raw,
        index,
        bindGroup,
        dynamicOffsetsData,
        dynamicOffsetsDataStart ?? 0,
        dynamicOffsetsDataLength,
      );
    } else if (dynamicOffsetsData !== undefined) {
      this.raw.setBindGroup.call(this.raw, index, bindGroup, dynamicOffsetsData);
    } else {
      this.raw.setBindGroup.call(this.raw, index, bindGroup);
    }
  }

  draw(
    vertexCount: number,
    instanceCount?: number | undefined,
    firstVertex?: number | undefined,
    firstInstance?: number | undefined,
  ): void {
    this.raw.draw.call(this.raw, vertexCount, instanceCount, firstVertex ?? 0, firstInstance ?? 0);
  }

  drawIndexed(
    indexCount: number,
    instanceCount?: number | undefined,
    firstIndex?: number | undefined,
    baseVertex?: number | undefined,
    firstInstance?: number | undefined,
  ): void {
    this.raw.drawIndexed.call(
      this.raw,
      indexCount,
      instanceCount,
      firstIndex ?? 0,
      baseVertex ?? 0,
      firstInstance ?? 0,
    );
  }

  drawIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    // bug-20260610: u64 → BigInt coerce.
    this.raw.drawIndirect.call(this.raw, unwrapBuffer(indirectBuffer), BigInt(indirectOffset));
  }

  drawIndexedIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    // bug-20260610: u64 → BigInt coerce.
    this.raw.drawIndexedIndirect.call(
      this.raw,
      unwrapBuffer(indirectBuffer),
      BigInt(indirectOffset),
    );
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
}

/** wgpu serde accepts the dictionary form of the WebGPU color union. */
export function colorForWasm(color: GPUColor): GPUColorDict {
  if (!Array.isArray(color)) return color as GPUColorDict;
  return { r: color[0] ?? 0, g: color[1] ?? 0, b: color[2] ?? 0, a: color[3] ?? 0 };
}

class RhiWgpuRenderPassEncoderImpl extends RhiWgpuRenderCommands implements RhiRenderPassEncoder {
  protected declare readonly raw: RawRenderPassLike;

  // biome-ignore lint/complexity/noUselessConstructor: narrow the inherited constructor to the pass-only contract
  constructor(raw: RawRenderPassLike) {
    super(raw);
  }

  end(): void {
    this.raw.end.call(this.raw);
  }

  setViewport(
    x: number,
    y: number,
    w: number,
    h: number,
    minDepth: number,
    maxDepth: number,
  ): void {
    this.raw.setViewport.call(this.raw, x, y, w, h, minDepth, maxDepth);
  }

  setScissorRect(x: number, y: number, w: number, h: number): void {
    this.raw.setScissorRect.call(this.raw, x, y, w, h);
  }

  setBlendConstant(color: GPUColor): void {
    this.raw.setBlendConstant.call(this.raw, colorForWasm(color));
  }

  setStencilReference(reference: number): void {
    this.raw.setStencilReference.call(this.raw, reference);
  }

  executeBundles(bundles: Iterable<RenderBundle>): Result<void, RhiError> {
    try {
      this.raw.executeBundles.call(this.raw, Array.from(bundles));
      return ok(undefined);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  beginOcclusionQuery(queryIndex: number): Result<void, RhiError> {
    try {
      this.raw.beginOcclusionQuery.call(this.raw, queryIndex);
      return ok(undefined);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  endOcclusionQuery(): Result<void, RhiError> {
    try {
      this.raw.endOcclusionQuery.call(this.raw);
      return ok(undefined);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }
}

export function makeRhiRenderBundleEncoder(raw: RawRenderBundleLike): RhiRenderBundleEncoder {
  const commands = new RhiWgpuRenderCommands(raw);
  let finished = false;
  return Object.assign(commands, {
    finish(desc?: import('@forgeax/engine-rhi').RenderBundleDescriptor) {
      if (finished) return err(commandEncoderFinished('render bundle'));
      finished = true;
      try {
        return ok(raw.finish(desc) as RenderBundle);
      } catch (cause) {
        return webgpuRuntimeError(cause);
      }
    },
  });
}

export function makeRhiRenderPassEncoder(raw: RawRenderPassLike): RhiRenderPassEncoder {
  return new RhiWgpuRenderPassEncoderImpl(raw);
}
