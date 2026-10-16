// @forgeax/engine-rhi-debug/src/readback — shared GPU texture→host readback utilities.
//
// Extracted from inspector.ts (round 1 fix-up 34be40d6, I-7) for reuse by
// replayer.readbackRt() (m5b-1) and e2e.dawn.test.ts (m5b-3).
//
// Related: plan-strategy §5.3.1; m5b-1 / m5b-3.

/// <reference types="@webgpu/types" />

import type { Buffer, MappedBuffer, RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugErrorFor } from './errors';
import type { SubresourceSlice } from './texel-layout';
import type { RhiCallEvent } from './types';

// GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ = 8 | 1 = 9.
const COPY_DST_MAP_READ = 9;
const TEXTURE_READBACK_USAGE = COPY_DST_MAP_READ;

// ============================================================================
// resolveTextureDescriptor — tape handle -> source texture descriptor (SSOT)
// ============================================================================

/** Resolved descriptor for a texture (or texture-view) handle from the tape. */
export interface ResolvedTextureDescriptor {
  /** The source GPUTexture handleId (copyTextureToBuffer needs a texture, not a view). */
  readonly handleId: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  /** The view's dimension ('2d' | 'cube' | '2d-array' | '3d' | ...); '2d' when no view event. */
  readonly dimension: string;
  /** The source texture's depthOrArrayLayers (slice count); 1 for a plain 2D texture. */
  readonly arrayLayers: number;
}

/**
 * Walk the tape events to resolve a view-or-texture handleId to its source
 * GPUTexture descriptor (handleId, real dimensions, format, view dimension).
 *
 * The single source of truth for "tape handle -> texture descriptor": both the
 * color-attachment RT path (resolveAttachmentSize / readbackDrawRt) and the
 * viewer's depth + bound-texture preview paths resolve handles this way —
 * createTextureView.resultHandleId -> sourceHandleId -> createTexture, falling
 * back to the id itself when it is a direct texture handle (no view event).
 *
 * Size is read from the raw createTexture event. Returns null when no
 * createTexture event declares the resolved handle.
 */
export function resolveTextureDescriptor(
  events: readonly RhiCallEvent[],
  viewOrTextureHandleId: string,
): ResolvedTextureDescriptor | null {
  // Step 1: resolve texture view -> source texture handleId + capture view dimension.
  let sourceTextureHandleId: string | undefined;
  let viewDimension: string | undefined;
  for (const ev of events) {
    if (ev.kind === 'createTextureView' && ev.resultHandleId === viewOrTextureHandleId) {
      sourceTextureHandleId = ev.sourceHandleId;
      viewDimension = ev.desc.dimension;
      break;
    }
  }
  // Some handles are texture handles directly (no view event).
  const targetHandleId = sourceTextureHandleId ?? viewOrTextureHandleId;

  // Step 2: find the createTexture event for the resolved texture handleId.
  for (const ev of events) {
    if (ev.kind === 'createTexture' && ev.handleId === targetHandleId) {
      const sz = ev.desc.size;
      let width: number;
      let height: number;
      let arrayLayers: number;
      // GPUExtent3DStrict: { width, height?, depthOrArrayLayers? } or [w, h?, d?]
      if (Array.isArray(sz)) {
        width = typeof sz[0] === 'number' ? sz[0] : 512;
        height = typeof sz[1] === 'number' ? sz[1] : width;
        arrayLayers = typeof sz[2] === 'number' ? sz[2] : 1;
      } else {
        const obj = sz as { width: number; height?: number; depthOrArrayLayers?: number };
        width = typeof obj.width === 'number' ? obj.width : 512;
        height = typeof obj.height === 'number' ? obj.height : width;
        arrayLayers = typeof obj.depthOrArrayLayers === 'number' ? obj.depthOrArrayLayers : 1;
      }
      return {
        handleId: targetHandleId,
        width,
        height,
        format: ev.desc.format,
        // View dimension wins; else the texture's own dimension; else '2d'.
        dimension: viewDimension ?? ev.desc.dimension ?? '2d',
        arrayLayers,
      };
    }
  }

  return null;
}

// ============================================================================
// resolveAttachmentSize — walk tape events to find texture dimensions
// ============================================================================

/**
 * Walk the tape events to find the real texture dimensions for a given
 * color attachment view/target handleId. Avoids hard-coding 512×512.
 *
 * Thin wrapper over {@link resolveTextureDescriptor}; returns
 * { width: 512, height: 512 } as a conservative fallback when no createTexture
 * event is found (should not happen for a real frame).
 */
export function resolveAttachmentSize(
  events: readonly RhiCallEvent[],
  attachmentViewHandleId: string,
): { readonly width: number; readonly height: number } {
  const desc = resolveTextureDescriptor(events, attachmentViewHandleId);
  if (desc === null) return { width: 512, height: 512 };
  return { width: desc.width, height: desc.height };
}

// ============================================================================
// readbackTexturePixels — copyTextureToBuffer + mapAsync + getMappedRange
// ============================================================================

/**
 * Read back raw RGBA8 pixels from a GPU texture into a host-side Uint8Array.
 *
 * Uses the batch readback lifecycle for one subresource. Rows are returned
 * tightly packed; staging alignment is stripped. Compressed formats use blocks.
 * Failures reject after batch-owned staging cleanup.
 *
 * @param device - The RHI device that owns the texture.
 * @param texture - The texture to read back (opaque branded handle at the boundary).
 * @param texWidth - Texture width in pixels.
 * @param texHeight - Texture height in pixels.
 */
export async function readbackTexturePixels(
  device: RhiDevice,
  texture: unknown,
  texWidth: number,
  texHeight: number,
  opts?: {
    /** Bytes in one uncompressed texel; retained for depth/color callers. */
    bytesPerTexel?: number;
    /** Compressed-format footprint; defaults to bytesPerTexel with a 1x1 block. */
    bytesPerBlock?: number;
    blockWidth?: number;
    blockHeight?: number;
    mipLevel?: number;
    baseArrayLayer?: number;
    aspect?: 'all' | 'depth-only' | 'stencil-only';
  },
): Promise<Uint8Array> {
  const bytesPerBlock = opts?.bytesPerBlock ?? opts?.bytesPerTexel ?? 4;
  const blockWidth = opts?.blockWidth ?? 1;
  const blockHeight = opts?.blockHeight ?? 1;
  const totalBytes =
    Math.ceil(texWidth / blockWidth) * Math.ceil(texHeight / blockHeight) * bytesPerBlock;
  const result = await readbackTexturePixelsBatch(device, [
    {
      handleId: 'texture',
      texture,
      bytesPerBlock,
      blockWidth,
      blockHeight,
      totalBytes,
      ...(opts?.aspect === undefined ? {} : { aspect: opts.aspect }),
      slices: [
        {
          layer: opts?.baseArrayLayer ?? 0,
          mip: opts?.mipLevel ?? 0,
          width: texWidth,
          height: texHeight,
          byteOffset: 0,
          byteLength: totalBytes,
        },
      ],
    },
  ]);
  if (!result.ok) throw new Error(result.error.detail.cause);
  // A successful batch returns exactly one result per request.
  const bytes = result.value.get('texture');
  if (bytes === undefined) throw new Error('texture readback returned no bytes');
  return new Uint8Array(bytes);
}

// ============================================================================
// readbackBufferBytes — copyBufferToBuffer + mapAsync + getMappedRange (D-7)
// ============================================================================

/**
 * Read back the raw bytes of a GPU buffer into a host-side ArrayBuffer.
 *
 * Uses the batch readback lifecycle for one buffer and returns an independent
 * byte copy or a structured readback-failed error. The batch owns staging,
 * submission, mapping and cleanup, including rejected queue/map promises.
 *
 * @param device - The RHI device that owns the buffer.
 * @param buffer - The source buffer (opaque branded handle) to read back.
 * @param size - Number of bytes to read back (the buffer's recorded size).
 */
export async function readbackBufferBytes(
  device: RhiDevice,
  buffer: unknown,
  size: number,
): Promise<Result<ArrayBuffer, RhiDebugErrorFor<'readback-failed'>>> {
  const result = await readbackBufferBytesBatch(device, [{ handleId: 'buffer', buffer, size }]);
  if (!result.ok) return result;
  // A successful batch returns exactly one result per request.
  const bytes = result.value.get('buffer');
  if (bytes === undefined)
    return err(
      createRhiDebugError('readback-failed', {
        stage: 'readback',
        phase: 'map',
        cause: 'buffer readback returned no bytes',
      }),
    );
  return ok(bytes);
}

/** A load-time buffer that can be read back as part of one GPU submission. */
export interface BufferReadbackBatchRequest {
  readonly handleId: string;
  readonly buffer: unknown;
  readonly size: number;
}

export interface BufferReadbackBatchCallbacks {
  readonly onResourceStart?: (handleId: string) => void;
  readonly onResourceComplete?: (handleId: string) => void;
  /** Return true when the owning snapshot generation has been invalidated. */
  readonly isCancelled?: () => boolean;
}

async function raceCancellation<T>(
  work: Promise<T>,
  isCancelled: (() => boolean) | undefined,
): Promise<{ readonly cancelled: true } | { readonly cancelled: false; readonly value: T }> {
  if (isCancelled === undefined) return { cancelled: false, value: await work };
  if (isCancelled()) return { cancelled: true };

  let timer: ReturnType<typeof setInterval> | undefined;
  const cancelled = new Promise<{ readonly cancelled: true }>((resolve) => {
    timer = setInterval(() => {
      if (isCancelled()) resolve({ cancelled: true });
    }, 1);
  });
  try {
    return await Promise.race([
      work.then((value) => ({ cancelled: false as const, value })),
      cancelled,
    ]);
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

/**
 * Read back multiple buffers with one command submission and one queue drain.
 *
 * Prism City exposed the cost of the old one-buffer helper: every resource
 * submitted and awaited independently, so thousands of small buffers spent
 * most of capture time in synchronization rather than byte transfer. The
 * batch keeps each staging buffer isolated but submits all copies together;
 * mapping remains per-resource so a timeout can still identify the current
 * handle and the caller can preserve the original initialData event order.
 */
export async function readbackBufferBytesBatch(
  device: RhiDevice,
  requests: readonly BufferReadbackBatchRequest[],
  callbacks: BufferReadbackBatchCallbacks = {},
): Promise<Result<ReadonlyMap<string, ArrayBuffer>, RhiDebugErrorFor<'readback-failed'>>> {
  if (requests.length === 0) return ok(new Map());
  const firstRequest = requests[0];
  if (firstRequest === undefined) return ok(new Map());

  const fail = (handleId: string, phase: 'copy' | 'map', cause: string) =>
    err(
      createRhiDebugError('readback-failed', {
        stage: 'readback',
        phase,
        cause: `${handleId}: ${cause}`,
      }),
    );
  const staging: Array<{ readonly request: BufferReadbackBatchRequest; readonly buffer: Buffer }> =
    [];
  const mapped = new Map<Buffer, MappedBuffer>();
  const cleaned = new Set<Buffer>();
  const cleanup = () => {
    for (const mappedBuffer of mapped.values()) mappedBuffer.unmap();
    for (const item of staging) {
      if (!cleaned.has(item.buffer)) {
        device.destroyBuffer(item.buffer);
        cleaned.add(item.buffer);
      }
    }
  };

  let encoder: RhiCommandEncoder;
  try {
    const encoderResult = device.createCommandEncoder({});
    if (!encoderResult.ok)
      return fail(
        firstRequest.handleId,
        'copy',
        `command encoder creation failed: ${encoderResult.error.code}`,
      );
    encoder = encoderResult.value;
    for (const request of requests) {
      const stagingResult = device.createBuffer({ size: request.size, usage: COPY_DST_MAP_READ });
      if (!stagingResult.ok) {
        cleanup();
        return fail(
          request.handleId,
          'copy',
          `staging buffer creation failed: ${stagingResult.error.code}`,
        );
      }
      const stagingBuffer = stagingResult.value;
      staging.push({ request, buffer: stagingBuffer });
      try {
        encoder.copyBufferToBuffer(request.buffer as Buffer, 0, stagingBuffer, 0, request.size);
      } catch (error) {
        cleanup();
        return fail(request.handleId, 'copy', `copyBufferToBuffer failed: ${String(error)}`);
      }
    }
    const finishResult = encoder.finish();
    if (!finishResult.ok) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'copy',
        `encoder.finish failed: ${finishResult.error.code}`,
      );
    }
    device.queue.submit([finishResult.value as unknown as never] as unknown as readonly never[]);
    const drain = await raceCancellation(device.queue.onSubmittedWorkDone(), callbacks.isCancelled);
    if (drain.cancelled) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'map',
        'buffer batch readback cancelled after the snapshot generation was invalidated',
      );
    }

    // Start every mapAsync together. The GPU work has already been submitted
    // and drained; awaiting each map before starting the next one recreates a
    // per-resource synchronization wall even after batching the copies.
    const mapResultsPromise = Promise.all(
      staging.map(async (item) => {
        callbacks.onResourceStart?.(item.request.handleId);
        try {
          const result = await item.buffer.mapAsync(0x1);
          if (result.ok) {
            if (callbacks.isCancelled?.()) result.value.unmap();
            else mapped.set(item.buffer, result.value);
          }
          return { item, result };
        } catch (error) {
          return { item, error };
        }
      }),
    );
    const mapResults = await raceCancellation(mapResultsPromise, callbacks.isCancelled);
    if (mapResults.cancelled) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'map',
        'buffer batch readback cancelled after the snapshot generation was invalidated',
      );
    }
    const result = new Map<string, ArrayBuffer>();
    for (const mappedResult of mapResults.value) {
      if ('error' in mappedResult) {
        cleanup();
        return fail(
          mappedResult.item.request.handleId,
          'map',
          `mapAsync(READ) failed: ${String(mappedResult.error)}`,
        );
      }
      if (!mappedResult.result.ok) {
        cleanup();
        return fail(
          mappedResult.item.request.handleId,
          'map',
          `mapAsync(READ) failed: ${mappedResult.result.error.code}`,
        );
      }
      const mappedBuffer = mappedResult.result.value;
      const item = mappedResult.item;
      const rangeResult = mappedBuffer.getMappedRange();
      if (!rangeResult.ok) {
        cleanup();
        return fail(
          item.request.handleId,
          'map',
          `getMappedRange failed: ${rangeResult.error.code}`,
        );
      }
      result.set(
        item.request.handleId,
        new Uint8Array(rangeResult.value).slice().buffer as ArrayBuffer,
      );
      mappedBuffer.unmap();
      mapped.delete(item.buffer);
      device.destroyBuffer(item.buffer);
      cleaned.add(item.buffer);
      callbacks.onResourceComplete?.(item.request.handleId);
    }
    return ok(result);
  } catch (error) {
    cleanup();
    return fail(firstRequest.handleId, 'map', `buffer batch readback failed: ${String(error)}`);
  }
}

/** A complete texture whose subresources are copied in one bounded batch. */
export interface TextureReadbackBatchRequest {
  readonly aspect?: 'all' | 'depth-only' | 'stencil-only';
  readonly handleId: string;
  readonly texture: unknown;
  readonly bytesPerBlock: number;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly totalBytes: number;
  readonly slices: readonly SubresourceSlice[];
}

export interface TextureReadbackBatchCallbacks {
  readonly onResourceStart?: (handleId: string) => void;
  readonly onResourceComplete?: (handleId: string) => void;
  /** Return true when the owning snapshot generation has been invalidated. */
  readonly isCancelled?: () => boolean;
}

/**
 * Read complete texture snapshots with one submission and drain per bounded
 * resource batch. Each subresource retains its own staging buffer, so mip and
 * array-layer bytes are copied without padding or ordering loss.
 */
export async function readbackTexturePixelsBatch(
  device: RhiDevice,
  requests: readonly TextureReadbackBatchRequest[],
  callbacks: TextureReadbackBatchCallbacks = {},
): Promise<Result<ReadonlyMap<string, ArrayBuffer>, RhiDebugErrorFor<'readback-failed'>>> {
  if (requests.length === 0) return ok(new Map());
  const firstRequest = requests[0];
  if (firstRequest === undefined) return ok(new Map());

  const fail = (handleId: string, phase: 'copy' | 'map', cause: string) =>
    err(
      createRhiDebugError('readback-failed', {
        stage: 'readback',
        phase,
        cause: `${handleId}: ${cause}`,
      }),
    );
  const staging: Array<{
    readonly request: TextureReadbackBatchRequest;
    readonly slice: SubresourceSlice;
    readonly buffer: Buffer;
    readonly bytesPerBlock: number;
    readonly blockWidth: number;
    readonly blockHeight: number;
  }> = [];
  const mapped = new Map<Buffer, MappedBuffer>();
  const cleaned = new Set<Buffer>();
  const cleanup = () => {
    for (const mappedBuffer of mapped.values()) mappedBuffer.unmap();
    for (const item of staging) {
      if (!cleaned.has(item.buffer)) {
        device.destroyBuffer(item.buffer);
        cleaned.add(item.buffer);
      }
    }
  };

  let encoder: RhiCommandEncoder;
  try {
    const encoderResult = device.createCommandEncoder({});
    if (!encoderResult.ok)
      return fail(
        firstRequest.handleId,
        'copy',
        `command encoder creation failed: ${encoderResult.error.code}`,
      );
    encoder = encoderResult.value;
    for (const request of requests) {
      for (const slice of request.slices) {
        const blockCountX = Math.ceil(slice.width / request.blockWidth);
        const blockCountY = Math.ceil(slice.height / request.blockHeight);
        const rowBytes = blockCountX * request.bytesPerBlock;
        const alignedRowBytes = Math.ceil(rowBytes / 256) * 256;
        const stagingResult = device.createBuffer({
          size: alignedRowBytes * blockCountY,
          usage: TEXTURE_READBACK_USAGE,
        });
        if (!stagingResult.ok) {
          cleanup();
          return fail(
            request.handleId,
            'copy',
            `staging buffer creation failed: ${stagingResult.error.code}`,
          );
        }
        const stagingBuffer = stagingResult.value;
        staging.push({
          request,
          slice,
          buffer: stagingBuffer,
          bytesPerBlock: request.bytesPerBlock,
          blockWidth: request.blockWidth,
          blockHeight: request.blockHeight,
        });
        try {
          encoder.copyTextureToBuffer(
            {
              texture: request.texture,
              ...(request.aspect === undefined ? {} : { aspect: request.aspect }),
              mipLevel: slice.mip,
              origin: { x: 0, y: 0, z: slice.layer },
            } as unknown as never,
            {
              buffer: stagingBuffer,
              offset: 0,
              bytesPerRow: alignedRowBytes,
              rowsPerImage: blockCountY,
            } as unknown as never,
            {
              width: blockCountX * request.blockWidth,
              height: blockCountY * request.blockHeight,
              depthOrArrayLayers: 1,
            },
          );
        } catch (error) {
          cleanup();
          return fail(request.handleId, 'copy', `copyTextureToBuffer failed: ${String(error)}`);
        }
      }
    }
    const finishResult = encoder.finish();
    if (!finishResult.ok) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'copy',
        `encoder.finish failed: ${finishResult.error.code}`,
      );
    }
    device.queue.submit([finishResult.value as unknown as never] as unknown as readonly never[]);
    const drain = raceCancellation(device.queue.onSubmittedWorkDone(), callbacks.isCancelled);
    const drainResult = await drain;
    if (drainResult.cancelled) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'map',
        'texture batch readback cancelled after the snapshot generation was invalidated',
      );
    }

    for (const request of requests) callbacks.onResourceStart?.(request.handleId);
    const mapResultsPromise = Promise.all(
      staging.map(async (item) => {
        try {
          const result = await item.buffer.mapAsync(0x1);
          if (result.ok) {
            if (callbacks.isCancelled?.()) result.value.unmap();
            else mapped.set(item.buffer, result.value);
          }
          return { item, result };
        } catch (error) {
          return { item, error };
        }
      }),
    );
    const mapResults = await raceCancellation(mapResultsPromise, callbacks.isCancelled);
    if (mapResults.cancelled) {
      cleanup();
      return fail(
        firstRequest.handleId,
        'map',
        'texture batch readback cancelled after the snapshot generation was invalidated',
      );
    }

    const bytesByHandle = new Map<string, Uint8Array>();
    for (const request of requests)
      bytesByHandle.set(request.handleId, new Uint8Array(request.totalBytes));
    for (const mappedResult of mapResults.value) {
      if ('error' in mappedResult) {
        cleanup();
        return fail(
          mappedResult.item.request.handleId,
          'map',
          `mapAsync(READ) failed: ${String(mappedResult.error)}`,
        );
      }
      if (!mappedResult.result.ok) {
        cleanup();
        return fail(
          mappedResult.item.request.handleId,
          'map',
          `mapAsync(READ) failed: ${mappedResult.result.error.code}`,
        );
      }
      const item = mappedResult.item;
      const mappedBuffer = mappedResult.result.value;
      const rangeResult = mappedBuffer.getMappedRange();
      if (!rangeResult.ok) {
        cleanup();
        return fail(
          item.request.handleId,
          'map',
          `getMappedRange failed: ${rangeResult.error.code}`,
        );
      }
      const fullBytes = new Uint8Array(rangeResult.value);
      const blockCountX = Math.ceil(item.slice.width / item.blockWidth);
      const blockCountY = Math.ceil(item.slice.height / item.blockHeight);
      const rowBytes = blockCountX * item.bytesPerBlock;
      const alignedRowBytes = Math.ceil(rowBytes / 256) * 256;
      const output = bytesByHandle.get(item.request.handleId);
      if (output === undefined) {
        cleanup();
        return fail(item.request.handleId, 'map', 'texture batch returned an unknown handle');
      }
      for (let y = 0; y < blockCountY; y++) {
        const srcOffset = y * alignedRowBytes;
        const dstOffset = item.slice.byteOffset + y * rowBytes;
        for (let x = 0; x < rowBytes; x++) output[dstOffset + x] = fullBytes[srcOffset + x] ?? 0;
      }
      mappedBuffer.unmap();
      mapped.delete(item.buffer);
      device.destroyBuffer(item.buffer);
      cleaned.add(item.buffer);
    }
    const result = new Map<string, ArrayBuffer>();
    for (const request of requests) {
      const bytes = bytesByHandle.get(request.handleId);
      if (bytes === undefined) {
        cleanup();
        return fail(request.handleId, 'map', 'texture batch returned no bytes for a live texture');
      }
      result.set(request.handleId, bytes.buffer as ArrayBuffer);
      callbacks.onResourceComplete?.(request.handleId);
    }
    return ok(result);
  } catch (error) {
    cleanup();
    return fail(firstRequest.handleId, 'map', `texture batch readback failed: ${String(error)}`);
  }
}
