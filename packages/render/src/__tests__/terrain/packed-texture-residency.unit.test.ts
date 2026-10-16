import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../../device/gpu-residency';

it('uploads every authored uncompressed packed mip through ordinary texture residency', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const writes = vi.spyOn(device.queue, 'writeTexture');
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('unused');
    },
    device.caps,
  );
  const data = new Uint8Array(84);
  data.fill(17, 0, 64);
  data.fill(83, 64, 80);
  data.fill(211, 80);
  const texture: TextureAsset = {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    mips: { kind: 'packed', levelCount: 3 },
    data,
  };
  const world = new World();
  try {
    store.ensureResident(world.allocSharedRef('TextureAsset', texture), texture, world).unwrap();
    expect(
      writes.mock.calls.map(([destination, bytes, layout, extent]) => ({
        mip: destination.mipLevel,
        bytes: Array.from(
          ArrayBuffer.isView(bytes)
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : new Uint8Array(bytes),
        ),
        row: layout.bytesPerRow,
        extent,
      })),
    ).toEqual(
      [4, 2, 1].map((width, mip) => ({
        mip,
        bytes: Array(width * width * 4).fill([17, 83, 211][mip]),
        row: width * 4,
        extent: { width, height: width, depthOrArrayLayers: 1 },
      })),
    );
  } finally {
    store.destroyAll();
    writes.mockRestore();
  }
});
