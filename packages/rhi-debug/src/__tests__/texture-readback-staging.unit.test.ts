import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { readbackTexturePixelsBatch } from '../readback';
import { computeTextureLayout } from '../texel-layout';

it.each([
  { format: 'rgba16float', maxBufferSize: 256 * 1024 * 1024, allocations: 1 },
  { format: 'bc3-rgba-unorm', maxBufferSize: 256 * 1024 * 1024, allocations: 1 },
  { format: 'rgba16float', maxBufferSize: 2048, allocations: 4 },
  { format: 'bc3-rgba-unorm', maxBufferSize: 2048, allocations: 2 },
] as const)('preserves every layer/mip of $format in $allocations staging allocations under maxBufferSize=$maxBufferSize', async ({
  format,
  maxBufferSize,
  allocations,
}) => {
  const layout = computeTextureLayout(
    format,
    format === 'bc3-rgba-unorm' ? 12 : 9,
    format === 'bc3-rgba-unorm' ? 8 : 5,
    3,
    4,
  );
  if (layout === undefined) throw new Error('missing test texture layout');
  const storage = new Map<Buffer, Uint8Array>();
  const maps = vi.fn();
  const unmap = vi.fn();
  const create = vi.fn(({ size }: { size: number }) => {
    if (size > maxBufferSize) throw new Error('staging allocation exceeds device limit');
    const bytes = new Uint8Array(size).fill(0xcd);
    const buffer = {
      mapAsync: async () => {
        maps();
        return ok({ getMappedRange: () => ok(bytes.buffer), unmap });
      },
    } as unknown as Buffer;
    storage.set(buffer, bytes);
    return ok(buffer);
  });
  const pattern = (layer: number, mip: number, row: number, byte: number) =>
    (layer * 67 + mip * 29 + row * 13 + byte * 3) & 255;
  const copy = vi.fn(
    (
      source: { mipLevel: number; origin: { z: number } },
      destination: { buffer: Buffer; offset: number; bytesPerRow: number },
      extent: { width: number; height: number },
    ) => {
      const bytes = storage.get(destination.buffer);
      if (bytes === undefined) throw new Error('copy targets unknown staging');
      const rowBytes = (extent.width / layout.blockWidth) * layout.bytesPerBlock;
      const rows = extent.height / layout.blockHeight;
      for (let row = 0; row < rows; row++)
        for (let byte = 0; byte < rowBytes; byte++)
          bytes[destination.offset + row * destination.bytesPerRow + byte] = pattern(
            source.origin.z,
            source.mipLevel,
            row,
            byte,
          );
    },
  );
  const submit = vi.fn(() => ok(undefined));
  const destroy = vi.fn();
  const starts = vi.fn();
  const completes = vi.fn();
  const device = {
    limits: { maxBufferSize },
    createBuffer: create,
    createCommandEncoder: () => ok({ copyTextureToBuffer: copy, finish: () => ok({}) }),
    queue: { submit, onSubmittedWorkDone: async () => {} },
    destroyBuffer: destroy,
  } as unknown as RhiDevice;
  const result = (
    await readbackTexturePixelsBatch(device, [{ handleId: 'texture', texture: {}, ...layout }], {
      onResourceStart: starts,
      onResourceComplete: completes,
    })
  ).unwrap();
  const expected = new Uint8Array(layout.totalBytes);
  for (const slice of layout.slices) {
    const rowBytes = Math.ceil(slice.width / layout.blockWidth) * layout.bytesPerBlock;
    const rows = Math.ceil(slice.height / layout.blockHeight);
    for (let row = 0; row < rows; row++)
      for (let byte = 0; byte < rowBytes; byte++)
        expected[slice.byteOffset + row * rowBytes + byte] = pattern(
          slice.layer,
          slice.mip,
          row,
          byte,
        );
  }
  expect(new Uint8Array(result.get('texture') as ArrayBuffer)).toEqual(expected);
  expect(copy).toHaveBeenCalledTimes(layout.slices.length);
  expect(create).toHaveBeenCalledTimes(allocations);
  expect(maps).toHaveBeenCalledTimes(allocations);
  expect(unmap).toHaveBeenCalledTimes(allocations);
  expect(destroy).toHaveBeenCalledTimes(allocations);
  for (const result of create.mock.results)
    expect(destroy).toHaveBeenCalledWith(result.value.unwrap());
  expect(submit).toHaveBeenCalledTimes(1);
  expect(starts).toHaveBeenCalledExactlyOnceWith('texture');
  expect(completes).toHaveBeenCalledExactlyOnceWith('texture');
});
