import { configureNativeMipmapCompiler, mipmapCacheSize } from '@forgeax/engine-assets-runtime';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { expect, it, vi } from 'vitest';
import { nativeDeviceFixture } from './native-device-fixture';
import { verifyPlanarMipChain } from './planar-mip-passes.gpu-fixture';

for (const format of ['rgba8unorm', 'rgba8unorm-srgb', 'rgba16float'] as const)
  it.each([
    [8, 8],
    [17, 5],
  ])(`writes exact ${format} planar mips without scratch/copies (%i x %i)`, async (width, height) => {
    const { device, native } = await nativeDeviceFixture({
      requiredFeatures: ['depth32float-stencil8'],
    });
    native.pushErrorScope('validation');
    const compile = vi.fn(gpu.createShaderModuleImmediate);
    configureNativeMipmapCompiler(device, compile);
    expect(mipmapCacheSize(device)).toBe(0);
    try {
      await verifyPlanarMipChain(device, undefined, format, width, height);
      expect(compile).toHaveBeenCalledTimes(1);
      expect(mipmapCacheSize(device)).toBe(1);
      expect(await native.popErrorScope()).toBeNull();
    } finally {
      native.destroy();
    }
  });
