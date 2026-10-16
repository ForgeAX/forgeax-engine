import type { RhiCaps, RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { deriveExtendedLightingCapability } from '../extended-lighting/resources';

const device = {
  caps: {
    backendKind: 'null',
    compute: true,
    storageBuffer: true,
    storageTexture: true,
    rgba16floatRenderable: true,
    samplerAliasing: true,
  } as RhiCaps,
  limits: {
    maxSampledTexturesPerShaderStage: 24,
    maxTextureDimension2D: 4096,
    maxTextureArrayLayers: 32,
    maxUniformBuffersPerShaderStage: 12,
  },
} as unknown as RhiDevice;

describe('extended lighting capability admission', () => {
  it('derives admission from real format, filter, array, and uniform facts', () => {
    expect(deriveExtendedLightingCapability(device)).toEqual({
      admitted: true,
      topology: 'extendedLighting',
      reason: undefined,
    });
  });

  it('rejects a device whose array or uniform limit cannot hold the contract', () => {
    const limited = {
      ...device,
      limits: { ...device.limits, maxTextureArrayLayers: 16, maxUniformBuffersPerShaderStage: 0 },
    } as RhiDevice;

    expect(deriveExtendedLightingCapability(limited)).toMatchObject({
      admitted: false,
      topology: 'extendedLighting',
      reason: expect.stringContaining('maxTextureArrayLayers'),
    });
  });

  it('rejects the topology when the sampled-texture limit is below the shader contract', () => {
    const limited = {
      ...device,
      limits: { ...device.limits, maxSampledTexturesPerShaderStage: 16 },
    } as RhiDevice;

    expect(deriveExtendedLightingCapability(limited)).toEqual({
      admitted: false,
      topology: 'extendedLighting',
      reason: 'maxSampledTexturesPerShaderStage 16 < 24',
    });
  });
});
