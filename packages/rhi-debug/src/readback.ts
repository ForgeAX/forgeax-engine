import { textureReadbackLayout } from '@forgeax/engine-rhi';
// @forgeax/engine-rhi-debug/src/readback — shared GPU texture→host readback utilities.
//
// Extracted from inspector.ts (round 1 fix-up 34be40d6, I-7) for reuse by
// replayer.readbackRt() (m5b-1) and e2e.dawn.test.ts (m5b-3).
//
// Related: plan-strategy §5.3.1; m5b-1 / m5b-3.

/// <reference types="@webgpu/types" />

import type {
  Buffer,
  MappedBuffer,
  RhiCommandEncoder,
  RhiDevice,
  Texture,
} from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugErrorFor } from './errors';
import type { TextureLayout } from './texel-layout';

// GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ = 8 | 1 = 9.
const COPY_DST_MAP_READ = 9;

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
    aspect?: GPUTextureAspect;
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

export interface ReadbackBatchCallbacks {
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
  callbacks: ReadbackBatchCallbacks = {},
): Promise<Result<ReadonlyMap<string, ArrayBuffer>, RhiDebugErrorFor<'readback-failed'>>> {
  return readbackBatch(device, { kind: 'buffer', requests }, callbacks);
}

/** A complete texture whose subresources are copied in one bounded batch. */
export interface TextureReadbackBatchRequest
  extends Pick<
    TextureLayout,
    'bytesPerBlock' | 'blockWidth' | 'blockHeight' | 'totalBytes' | 'slices'
  > {
  readonly aspect?: GPUTextureAspect;
  readonly handleId: string;
  readonly texture: unknown;
}

export async function readbackTexturePixelsBatch(
  device: RhiDevice,
  requests: readonly TextureReadbackBatchRequest[],
  callbacks: ReadbackBatchCallbacks = {},
): Promise<Result<ReadonlyMap<string, ArrayBuffer>, RhiDebugErrorFor<'readback-failed'>>> {
  return readbackBatch(device, { kind: 'texture', requests }, callbacks);
}

async function readbackBatch(
  device: RhiDevice,
  source:
    | { readonly kind: 'buffer'; readonly requests: readonly BufferReadbackBatchRequest[] }
    | { readonly kind: 'texture'; readonly requests: readonly TextureReadbackBatchRequest[] },
  callbacks: ReadbackBatchCallbacks,
): Promise<Result<ReadonlyMap<string, ArrayBuffer>, RhiDebugErrorFor<'readback-failed'>>> {
  const { requests } = source;
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
    readonly handleId: string;
    readonly buffer: Buffer;
    readonly textureSlice?: {
      readonly byteOffset: number;
      readonly rows: number;
      readonly rowBytes: number;
      readonly alignedRowBytes: number;
    };
  }> = [];
  const mapped = new Map<Buffer, MappedBuffer>();
  const cleaned = new Set<Buffer>();
  let closed = false;
  const cleanup = () => {
    closed = true;
    for (const mappedBuffer of mapped.values()) mappedBuffer.unmap();
    mapped.clear();
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
    if (source.kind === 'buffer') {
      for (const request of source.requests) {
        const stagingResult = device.createBuffer({ size: request.size, usage: COPY_DST_MAP_READ });
        if (!stagingResult.ok)
          return fail(
            request.handleId,
            'copy',
            `staging buffer creation failed: ${stagingResult.error.code}`,
          );
        const buffer = stagingResult.value;
        staging.push({ handleId: request.handleId, buffer });
        try {
          encoder.copyBufferToBuffer(request.buffer as Buffer, 0, buffer, 0, request.size);
        } catch (error) {
          return fail(request.handleId, 'copy', `copyBufferToBuffer failed: ${String(error)}`);
        }
      }
    } else {
      for (const request of source.requests) {
        for (const slice of request.slices) {
          const {
            rowBytes,
            rowsPerImage: rows,
            bytesPerRow: alignedRowBytes,
            byteLength,
          } = textureReadbackLayout(slice.width, slice.height, request);
          const stagingResult = device.createBuffer({
            size: byteLength,
            usage: COPY_DST_MAP_READ,
          });
          if (!stagingResult.ok)
            return fail(
              request.handleId,
              'copy',
              `staging buffer creation failed: ${stagingResult.error.code}`,
            );
          const buffer = stagingResult.value;
          staging.push({
            handleId: request.handleId,
            buffer,
            textureSlice: { byteOffset: slice.byteOffset, rows, rowBytes, alignedRowBytes },
          });
          try {
            encoder.copyTextureToBuffer(
              {
                texture: request.texture as Texture,
                ...(request.aspect === undefined ? {} : { aspect: request.aspect }),
                mipLevel: slice.mip,
                origin: { x: 0, y: 0, z: slice.layer },
              },
              {
                buffer,
                offset: 0,
                bytesPerRow: alignedRowBytes,
                rowsPerImage: rows,
              },
              {
                width: (rowBytes / request.bytesPerBlock) * request.blockWidth,
                height: rows * request.blockHeight,
                depthOrArrayLayers: 1,
              },
            );
          } catch (error) {
            return fail(request.handleId, 'copy', `copyTextureToBuffer failed: ${String(error)}`);
          }
        }
      }
    }
    const finishResult = encoder.finish();
    if (!finishResult.ok) {
      return fail(
        firstRequest.handleId,
        'copy',
        `encoder.finish failed: ${finishResult.error.code}`,
      );
    }
    const submitted = device.queue.submit([finishResult.value]);
    if (!submitted.ok) {
      return fail(
        firstRequest.handleId,
        'copy',
        `queue.submit failed: ${submitted.error.code}: ${submitted.error.hint}`,
      );
    }
    const drain = await raceCancellation(device.queue.onSubmittedWorkDone(), callbacks.isCancelled);
    if (drain.cancelled) {
      return fail(
        firstRequest.handleId,
        'map',
        `${source.kind} batch readback cancelled after the snapshot generation was invalidated`,
      );
    }

    // Start every mapAsync together. The GPU work has already been submitted
    // and drained; awaiting each map before starting the next one recreates a
    // per-resource synchronization wall even after batching the copies.
    if (source.kind === 'texture')
      for (const request of requests) callbacks.onResourceStart?.(request.handleId);
    const mapResultsPromise = Promise.all(
      staging.map(async (item) => {
        if (source.kind === 'buffer') callbacks.onResourceStart?.(item.handleId);
        try {
          const result = await item.buffer.mapAsync(0x1);
          if (result.ok) {
            if (closed || callbacks.isCancelled?.()) result.value.unmap();
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
      return fail(
        firstRequest.handleId,
        'map',
        `${source.kind} batch readback cancelled after the snapshot generation was invalidated`,
      );
    }
    const result = new Map<string, ArrayBuffer>();
    if (source.kind === 'texture')
      for (const request of source.requests)
        result.set(request.handleId, new ArrayBuffer(request.totalBytes));
    for (const mappedResult of mapResults.value) {
      if ('error' in mappedResult) {
        return fail(
          mappedResult.item.handleId,
          'map',
          `mapAsync(READ) failed: ${String(mappedResult.error)}`,
        );
      }
      if (!mappedResult.result.ok) {
        return fail(
          mappedResult.item.handleId,
          'map',
          `mapAsync(READ) failed: ${mappedResult.result.error.code}`,
        );
      }
      const mappedBuffer = mappedResult.result.value;
      const item = mappedResult.item;
      const rangeResult = mappedBuffer.getMappedRange();
      if (!rangeResult.ok) {
        return fail(item.handleId, 'map', `getMappedRange failed: ${rangeResult.error.code}`);
      }
      if (item.textureSlice === undefined) {
        result.set(item.handleId, new Uint8Array(rangeResult.value).slice().buffer as ArrayBuffer);
      } else {
        const outputBuffer = result.get(item.handleId);
        if (outputBuffer === undefined)
          return fail(item.handleId, 'map', 'texture batch returned an unknown handle');
        const output = new Uint8Array(outputBuffer);
        const fullBytes = new Uint8Array(rangeResult.value);
        const { byteOffset, rows, rowBytes, alignedRowBytes } = item.textureSlice;
        for (let y = 0; y < rows; y++) {
          const srcOffset = y * alignedRowBytes;
          const dstOffset = byteOffset + y * rowBytes;
          for (let x = 0; x < rowBytes; x++) output[dstOffset + x] = fullBytes[srcOffset + x] ?? 0;
        }
      }
      mappedBuffer.unmap();
      mapped.delete(item.buffer);
      device.destroyBuffer(item.buffer);
      cleaned.add(item.buffer);
      if (source.kind === 'buffer') callbacks.onResourceComplete?.(item.handleId);
    }
    if (source.kind === 'texture')
      for (const request of requests) callbacks.onResourceComplete?.(request.handleId);
    return ok(result);
  } catch (error) {
    return fail(
      firstRequest.handleId,
      'map',
      `${source.kind} batch readback failed: ${String(error)}`,
    );
  } finally {
    cleanup();
  }
}
