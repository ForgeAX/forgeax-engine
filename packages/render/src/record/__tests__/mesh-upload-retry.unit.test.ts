import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { flushMeshDrawUploads, prepareMeshDraw, uploadMeshSsboBatch } from '../mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../render-context';

it('retries an unchanged mesh after its preceding upload was rejected', () => {
  const row = { ...receiptRow(), meshSlot: 0 };
  const buffer = {} as Buffer;
  const failure = new Error('queue rejected the write');
  const writeBuffer = vi.fn().mockReturnValueOnce(err(failure)).mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  expect(() => uploadMeshSsboBatch(queue, { buffer }, [row], null)).toThrow(failure);
  expect(uploadMeshSsboBatch(queue, { buffer }, [row], null)).toBe(1);
  expect(writeBuffer).toHaveBeenCalledTimes(2);
  expect(uploadMeshSsboBatch(queue, { buffer }, [row], null)).toBe(0);
});

it('retries all overlapping physical pages after a partial write failed', () => {
  const row = { ...receiptRow(), meshSlot: 1 };
  const pages = { byteStride: 256, byteSize: 512, buffers: [{} as Buffer, {} as Buffer] };
  const storage = { buffer: null, pages };
  const failure = new Error('second page rejected');
  const writeBuffer = vi
    .fn()
    .mockReturnValueOnce(ok(undefined))
    .mockReturnValueOnce(err(failure))
    .mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  expect(() => uploadMeshSsboBatch(queue, storage, [row], null)).toThrow(failure);
  expect(uploadMeshSsboBatch(queue, storage, [row], null)).toBe(1);
  expect(writeBuffer.mock.calls.map((call) => call[0])).toEqual([
    pages.buffers[0],
    pages.buffers[1],
    pages.buffers[0],
    pages.buffers[1],
  ]);
});

it('records the fixed material version after the shared resource advances', () => {
  const row = { ...receiptRow(), meshSlot: 0 };
  const resource = row.source.material;
  resource.adopt({ ...resource.snapshot, transparent: true });
  const current = vi.spyOn(resource, 'snapshot', 'get').mockImplementation(() => {
    throw new Error('record read a live material');
  });
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  try {
    uploadMeshSsboBatch(queue, { buffer: {} as Buffer }, [row], null);
    const call = writeBuffer.mock.calls[0];
    const bytes = call?.[2] as Uint8Array;
    expect(new Float32Array(bytes.buffer, bytes.byteOffset)[32]).toBe(0);
  } finally {
    current.mockRestore();
  }
});

it('does no Mesh packing or upload for a shared material edit across 10000 actual draws', () => {
  const source = receiptRow().source;
  const matrix = source.transform.world;
  const readMatrix = vi.fn(() => matrix);
  const transform = {
    get world() {
      return readMatrix();
    },
  };
  const spriteRegion = [0.125, 0.25, 0.5, 0.75] as const;
  const rows = Array.from({ length: 10000 }, (_, meshSlot) => ({
    meshSlot,
    source: { ...source, transform, spriteRegion, entityKey: meshSlot },
  }));
  const buffer = {} as Buffer;
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  const c = {
    runtime: { device: { queue, caps: { storageBuffer: true } } },
    pipelineState: { meshStorageBuffer: { buffer } },
  } as _InternalRenderPipelineContext;
  for (const row of rows) prepareMeshDraw(c, row);
  expect(flushMeshDrawUploads(queue, { buffer })).toBe(1);
  expect(readMatrix).toHaveBeenCalledTimes(10000);
  const resource = source.material;
  resource.adopt({
    ...resource.snapshot,
    transparent: true,
    paramSnapshot: { flipX: 1, flipY: 1 },
  });
  const live = vi.spyOn(resource, 'snapshot', 'get').mockImplementation(() => {
    throw new Error('draw reopened material root');
  });
  readMatrix.mockClear();
  writeBuffer.mockClear();
  try {
    for (const row of rows) prepareMeshDraw(c, row);
    expect(flushMeshDrawUploads(queue, { buffer })).toBe(0);
    expect(readMatrix).not.toHaveBeenCalled();
    expect(writeBuffer).not.toHaveBeenCalled();
    // Actual source replacement is the falsifier: its changed transform still uploads.
    const changed = new Float32Array(matrix);
    changed[12] = 3;
    prepareMeshDraw(c, {
      meshSlot: 0,
      source: { ...source, transform: { world: changed }, spriteRegion },
    });
    expect(flushMeshDrawUploads(queue, { buffer })).toBe(1);
    const bytes = writeBuffer.mock.calls[0]?.[2] as Uint8Array;
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset);
    expect(floats[12]).toBe(3);
    expect(Array.from(floats.subarray(40, 44))).toEqual(spriteRegion);
  } finally {
    live.mockRestore();
  }
});

it.each([
  true,
  false,
])('keeps Sprite overrides in their actual Mesh ABI (storage=%s)', (storageBuffer) => {
  const source = receiptRow().source;
  const spriteRegion = [0.125, 0.25, 0.5, 0.75] as const;
  const row = { meshSlot: 0, source: { ...source, spriteRegion } };
  const writeBuffer = vi.fn().mockReturnValue(ok(undefined));
  const queue = { writeBuffer } as unknown as RhiQueue;
  uploadMeshSsboBatch(queue, { buffer: {} as Buffer }, [row], null, [], undefined, storageBuffer);
  const bytes = writeBuffer.mock.calls[0]?.[2] as Uint8Array;
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset);
  const bits = new Uint32Array(bytes.buffer, bytes.byteOffset);
  const surface = storageBuffer ? 36 : 16;
  expect(Array.from(bits.subarray(surface, surface + 4))).toEqual([0, 0, 0xffffffff, 1]);
  expect(Array.from(floats.subarray(surface + 4, surface + 8))).toEqual(spriteRegion);
});
