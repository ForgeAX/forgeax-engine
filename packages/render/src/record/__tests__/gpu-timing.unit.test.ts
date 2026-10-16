import type { Buffer, QuerySet, RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { assert, describe, expect, it, vi } from 'vitest';
import { GPU_BUFFER_USAGE_MAP_READ } from '../../gpu-usage';
import { GpuTimingCapture } from '../gpu-timing';

function timestampDevice(readbackBytes: ArrayBuffer): {
  readonly device: RhiDevice;
  readonly encoder: RhiCommandEncoder;
  readonly resolveQuerySet: ReturnType<typeof vi.fn>;
  readonly readbackBuffer: Buffer;
  readonly getMappedRange: ReturnType<typeof vi.fn>;
  readonly destroyBuffer: ReturnType<typeof vi.fn>;
  readonly destroyQuerySet: ReturnType<typeof vi.fn>;
} {
  const querySet = {} as QuerySet;
  const resolveBuffer = {} as Buffer;
  const getMappedRange = vi.fn(() => ok(readbackBytes));
  const unmap = vi.fn();
  const readbackBuffer = {
    mapAsync: vi.fn(async (mode: number) => {
      expect(mode).toBe(GPU_BUFFER_USAGE_MAP_READ);
      return ok({
        getMappedRange,
        unmap,
      } as never);
    }),
  } as unknown as Buffer;
  let bufferIndex = 0;
  const resolveQuerySet = vi.fn(() => ok(undefined));
  const destroyBuffer = vi.fn(() => ok(undefined));
  const destroyQuerySet = vi.fn(() => ok(undefined));
  const encoder = {
    resolveQuerySet,
    copyBufferToBuffer: vi.fn(),
  } as unknown as RhiCommandEncoder;
  const device = {
    caps: {
      backendKind: 'webgpu',
      compute: true,
      storageBuffer: true,
      storageTexture: true,
      timestampQuery: true,
      timestampPeriodNanoseconds: 1,
      indirectDrawing: true,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: true,
      rgba16floatRenderable: true,
      rg11b10ufloatRenderable: true,
      float32Filterable: true,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
    },
    createQuerySet: vi.fn(() => ok(querySet)),
    createBuffer: vi.fn(() => {
      bufferIndex += 1;
      return ok(bufferIndex === 1 ? resolveBuffer : readbackBuffer);
    }),
    destroyQuerySet,
    destroyBuffer,
    queue: { onSubmittedWorkDone: vi.fn(async () => undefined) },
  } as unknown as RhiDevice;
  return {
    device,
    encoder,
    resolveQuerySet,
    readbackBuffer,
    getMappedRange,
    destroyBuffer,
    destroyQuerySet,
  };
}

function writeTimestampPair(bytes: ArrayBuffer, index: number, begin: bigint, end: bigint): void {
  const view = new DataView(bytes);
  view.setBigUint64(index * 16, begin, true);
  view.setBigUint64(index * 16 + 8, end, true);
}

describe('GpuTimingCapture pass descriptor contract', () => {
  it('derives the envelope from extrema when a later pass finishes inside an earlier interval', async () => {
    const bytes = new ArrayBuffer(64 * 8);
    writeTimestampPair(bytes, 0, 100n, 450n);
    writeTimestampPair(bytes, 1, 200n, 300n);
    const { device, encoder } = timestampDevice(bytes);
    const capture = GpuTimingCapture.create(device).unwrap();
    assert(capture);
    capture.beginPass('volume-inject', 'compute', 0);
    capture.beginPass('volume-integrate', 'compute', 1);
    capture.resolve(encoder).unwrap();
    capture.markSubmitted();
    expect(await capture.observation()).toMatchObject({
      status: 'ready',
      frameMs: 0.00035,
      totalMs: 0.00035,
    });
  });

  it('resolves real pass pairs without calling command-encoder writeTimestamp', async () => {
    const bytes = new ArrayBuffer(64 * 8);
    writeTimestampPair(bytes, 0, 100n, 200n);
    writeTimestampPair(bytes, 1, 210n, 450n);
    const { device, encoder, resolveQuerySet } = timestampDevice(bytes);
    const created = GpuTimingCapture.create(device);
    expect(created.ok).toBe(true);
    if (!created.ok || created.value === undefined) return;

    const first = created.value.beginPass('volume-inject', 'compute', 3);
    const second = created.value.beginPass('volume-integrate', 'raster', 9);
    expect(first).toMatchObject({ beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    expect(second).toMatchObject({ beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 });
    expect((encoder as unknown as { writeTimestamp?: unknown }).writeTimestamp).toBeUndefined();

    expect(created.value.resolve(encoder).ok).toBe(true);
    expect(resolveQuerySet).toHaveBeenCalledWith(expect.anything(), 0, 4, expect.anything(), 0);
    created.value.markSubmitted();
    await expect(created.value.observation()).resolves.toEqual({
      status: 'ready',
      unit: 'ms',
      frameMs: 0.00035,
      totalMs: 0.00035,
      passes: [
        { name: 'volume-inject', milliseconds: 0.0001 },
        { name: 'volume-integrate', milliseconds: 0.00024 },
      ],
    });
  });

  it('fails closed when a producer already owns the pass timestamp pair', async () => {
    const { device, encoder } = timestampDevice(new ArrayBuffer(64 * 8));
    const created = GpuTimingCapture.create(device);
    expect(created.ok).toBe(true);
    if (!created.ok || created.value === undefined) return;
    expect(created.value.beginPass('volume-inject', 'compute', 0)).toBeDefined();
    created.value.markOwnerConflict('volume-inject');
    expect(created.value.resolve(encoder).ok).toBe(true);
    created.value.markSubmitted();
    await expect(created.value.observation()).resolves.toEqual({
      status: 'unavailable',
      reason: "timestamp pass 'volume-inject' already has producer-owned timestampWrites",
    });
  });

  it('disposes query and buffer resources when readback mapping fails', async () => {
    const { device, encoder, readbackBuffer, destroyBuffer, destroyQuerySet } = timestampDevice(
      new ArrayBuffer(64 * 8),
    );
    const mapAsync = readbackBuffer.mapAsync as unknown as ReturnType<typeof vi.fn>;
    mapAsync.mockResolvedValue({
      ok: false,
      error: { code: 'webgpu-runtime-error' },
    });
    const created = GpuTimingCapture.create(device);
    expect(created.ok).toBe(true);
    if (!created.ok || created.value === undefined) return;

    expect(created.value.beginPass('volume-inject', 'compute', 0)).toBeDefined();
    expect(created.value.resolve(encoder).ok).toBe(true);
    created.value.markSubmitted();
    await expect(created.value.observation()).resolves.toEqual({
      status: 'unavailable',
      reason: 'timestamp readback failed: webgpu-runtime-error',
    });
    expect(destroyBuffer).toHaveBeenCalledTimes(2);
    expect(destroyQuerySet).toHaveBeenCalledTimes(1);
  });

  it('disposes query and buffer resources when mapped range access fails', async () => {
    const { device, encoder, getMappedRange, destroyBuffer, destroyQuerySet } = timestampDevice(
      new ArrayBuffer(64 * 8),
    );
    getMappedRange.mockReturnValue({
      ok: false,
      error: { code: 'webgpu-runtime-error' },
    });
    const created = GpuTimingCapture.create(device);
    expect(created.ok).toBe(true);
    if (!created.ok || created.value === undefined) return;

    expect(created.value.beginPass('volume-inject', 'compute', 0)).toBeDefined();
    expect(created.value.resolve(encoder).ok).toBe(true);
    created.value.markSubmitted();
    await expect(created.value.observation()).resolves.toEqual({
      status: 'unavailable',
      reason: 'timestamp mapping failed: webgpu-runtime-error',
    });
    expect(destroyBuffer).toHaveBeenCalledTimes(2);
    expect(destroyQuerySet).toHaveBeenCalledTimes(1);
  });
});
