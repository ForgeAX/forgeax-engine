import * as gpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { nativeDeviceFixture } from './native-device-fixture';
import { verifyPlanarMipChain } from './planar-mip-passes.gpu-fixture';

for (const format of ['rgba8unorm', 'rgba8unorm-srgb', 'rgba16float'] as const)
  it.each([
    [8, 8],
    [17, 5],
  ])(`writes exact ${format} planar mips without scratch/copies (%i x %i)`, async (width, height) => {
    const { device, native } = await nativeDeviceFixture();
    native.pushErrorScope('validation');
    try {
      await verifyPlanarMipChain(
        device,
        (_device, descriptor) => gpu.createShaderModule(device, descriptor),
        format,
        width,
        height,
      );
      expect(await native.popErrorScope()).toBeNull();
    } finally {
      native.destroy();
    }
  });
