import * as gpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { nativeDeviceFixture } from './native-device-fixture';
import { verifyGpuTextureGeneration } from './texture-generators.gpu-fixture';

it('generates Pack textures and mips entirely on GPU and samples 60 completed frames', async () => {
  const { device, native } = await nativeDeviceFixture();
  let raw = native;
  raw.pushErrorScope('validation');
  try {
    const result = await verifyGpuTextureGeneration(
      device,
      (_device, descriptor) => gpu.createShaderModule(device, descriptor),
      await commands.prepareTextureGeneratorPrograms(),
      await commands.prepareDerivedTextureGeneratorPrograms(),
      {
        async recreateDevice() {
          expect(await raw.popErrorScope()).toBeNull();
          raw.destroy();
          expect((await raw.lost).reason).toBe('destroyed');
          const { device: replacement, native: replacementNative } = await nativeDeviceFixture();
          raw = replacementNative;
          raw.pushErrorScope('validation');
          return {
            device: replacement,
            factory: (_device, descriptor) => gpu.createShaderModule(replacement, descriptor),
          };
        },
      },
    );
    expect(result.frames).toBe(60);
    expect(await raw.popErrorScope()).toBeNull();
  } finally {
    raw.destroy();
  }
}, 60_000);
