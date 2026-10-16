import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import {
  readbackBufferBytes,
  readbackBufferBytesBatch,
  readbackTexturePixels,
  readbackTexturePixelsBatch,
} from '../readback';

async function deviceWithRejectedDrain() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const base = (await adapter.requestDevice()).unwrap();
  const destroy = vi.fn((buffer) => base.destroyBuffer(buffer));
  const queue = Object.create(base.queue);
  const drain = vi.fn(() => Promise.reject(new Error('device lost while draining')));
  queue.onSubmittedWorkDone = drain;
  const device = Object.create(base) as RhiDevice;
  Object.defineProperties(device, {
    queue: { value: queue },
    destroyBuffer: { value: destroy },
  });
  return { device, destroy, drain, create: vi.spyOn(device, 'createBuffer') };
}

it.each([
  'single',
  'batch',
] as const)('%s buffer readback uses map-readable copy staging and retires it after a rejected drain', async (mode) => {
  const { device, destroy, create, drain } = await deviceWithRejectedDrain();
  const source = device.createBuffer({ size: 8, usage: 4 }).unwrap();
  create.mockClear();
  const result =
    mode === 'single'
      ? await readbackBufferBytes(device, source, 4)
      : await readbackBufferBytesBatch(device, [
          { handleId: 'first', buffer: source, size: 4 },
          { handleId: 'second', buffer: source, size: 8 },
        ]);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('readback-failed');
    expect(result.error.detail.cause).toContain('device lost while draining');
  }
  expect(drain).toHaveBeenCalledTimes(1);
  expect(create.mock.calls).toEqual(
    mode === 'single'
      ? [[{ size: 4, usage: 9 }]]
      : [[{ size: 4, usage: 9 }], [{ size: 8, usage: 9 }]],
  );
  expect(destroy).toHaveBeenCalledTimes(mode === 'single' ? 1 : 2);
  for (const staging of create.mock.results)
    expect(destroy).toHaveBeenCalledWith(staging.value.unwrap());
  expect(destroy).not.toHaveBeenCalledWith(source);
});

it.each([
  'single',
  'batch',
] as const)('%s texture readback uses aligned map-readable copy staging and retires it after a rejected drain', async (mode) => {
  const { device, destroy, create, drain } = await deviceWithRejectedDrain();
  const texture = device
    .createTexture({ size: [1, 1, 2], format: 'rgba8unorm', usage: 1 })
    .unwrap();
  if (mode === 'single') {
    await expect(readbackTexturePixels(device, texture, 1, 1)).rejects.toThrow(
      'device lost while draining',
    );
  } else {
    const result = await readbackTexturePixelsBatch(
      device,
      ['first', 'second'].map((handleId) => ({
        handleId,
        texture,
        bytesPerBlock: 4,
        blockWidth: 1,
        blockHeight: 1,
        totalBytes: 8,
        slices: [
          { layer: 0, mip: 0, width: 1, height: 1, byteOffset: 0, byteLength: 4 },
          { layer: 1, mip: 0, width: 1, height: 1, byteOffset: 4, byteLength: 4 },
        ],
      })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('readback-failed');
      expect(result.error.detail.cause).toContain('device lost while draining');
    }
  }
  expect(drain).toHaveBeenCalledTimes(1);
  expect(create.mock.calls).toEqual(
    Array.from({ length: mode === 'single' ? 1 : 4 }, () => [{ size: 256, usage: 9 }]),
  );
  expect(destroy).toHaveBeenCalledTimes(mode === 'single' ? 1 : 4);
  for (const staging of create.mock.results)
    expect(destroy).toHaveBeenCalledWith(staging.value.unwrap());
});

it('retires buffer staging when a capture timeout cancels a pending queue drain', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const base = (await adapter.requestDevice()).unwrap();
  const source = base.createBuffer({ size: 8, usage: 4 }).unwrap();
  const destroy = vi.fn((buffer) => base.destroyBuffer(buffer));
  const queue = Object.create(base.queue);
  queue.onSubmittedWorkDone = () => new Promise<void>(() => {});
  const device = Object.create(base) as RhiDevice;
  Object.defineProperties(device, {
    queue: { value: queue },
    destroyBuffer: { value: destroy },
  });
  let cancelled = false;
  const pending = readbackBufferBytesBatch(
    device,
    [{ handleId: 'source', buffer: source, size: 8 }],
    { isCancelled: () => cancelled },
  );
  cancelled = true;
  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.detail.cause).toContain('cancelled');
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(destroy).not.toHaveBeenCalledWith(source);
});
