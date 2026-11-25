import * as gpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { nativeDeviceFixture } from './native-device-fixture';
import {
  verifyBuiltinColorMipFilters,
  verifyGpuTextureGeneration,
  verifyWaterImpulseMipChain,
  verifyWaterSurfaceTextures,
} from './texture-generators.gpu-fixture';

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
        volumeRecipe: await commands.prepareWaterVolumeRecipe(),
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

it('generates all six Water surface assets and their mips without a pixel upload', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  try {
    await verifyWaterSurfaceTextures(
      device,
      (_device, descriptor) => gpu.createShaderModule(device, descriptor),
      await commands.prepareWaterSurfaceTextures(),
    );
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    native.destroy();
  }
}, 60_000);

it('publishes authored impulse mips and built-in color reductions in Chromium', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  try {
    const factory = (_device: typeof device, descriptor: { code: string; label?: string }) =>
      gpu.createShaderModule(device, descriptor);
    await verifyBuiltinColorMipFilters(device, factory);
    await verifyWaterImpulseMipChain(device, factory, await commands.prepareWaterImpulseNoise());
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    native.destroy();
  }
}, 60_000);
