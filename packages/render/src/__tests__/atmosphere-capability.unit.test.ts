import { expect, it } from 'vitest';
import { atmosphereFrameAdmissible } from '../environment/capability';

const volumeCaps = {
  compute: true,
  rgba16floatRenderable: true,
  storageBuffer: true,
  storageTexture: true,
} as const;

it('admits the native atmosphere material layout on a capable device', () => {
  expect(
    atmosphereFrameAdmissible({
      atmosphereAvailable: true,
      backgroundOnly: false,
      caps: volumeCaps,
      limits: { maxTextureDimension3D: 32, maxSampledTexturesPerShaderStage: 32 },
    }),
  ).toBe(true);
});

it('admits reduced Standard variants with the physical sky on a 16-sampler WebGPU device', () => {
  expect(
    atmosphereFrameAdmissible({
      atmosphereAvailable: false,
      backgroundOnly: false,
      caps: volumeCaps,
      limits: { maxTextureDimension3D: 2048, maxSampledTexturesPerShaderStage: 16 },
    }),
  ).toBe(true);
});

it('rejects reduced variants below their sampled-texture floor or without the atmosphere volume', () => {
  const base = {
    atmosphereAvailable: false,
    backgroundOnly: false,
    caps: volumeCaps,
  } as const;
  expect(
    atmosphereFrameAdmissible({
      ...base,
      limits: { maxTextureDimension3D: 32, maxSampledTexturesPerShaderStage: 15 },
    }),
  ).toBe(false);
  expect(
    atmosphereFrameAdmissible({
      ...base,
      limits: { maxTextureDimension3D: 31, maxSampledTexturesPerShaderStage: 16 },
    }),
  ).toBe(false);
});

it('preserves the no-storage packed atmosphere and background-only routes', () => {
  expect(
    atmosphereFrameAdmissible({
      atmosphereAvailable: false,
      backgroundOnly: false,
      caps: { ...volumeCaps, compute: false, storageBuffer: false, storageTexture: false },
      limits: { maxTextureDimension2D: 1024, maxSampledTexturesPerShaderStage: 16 },
    }),
  ).toBe(true);
  expect(
    atmosphereFrameAdmissible({
      atmosphereAvailable: false,
      backgroundOnly: true,
      caps: volumeCaps,
      limits: {},
    }),
  ).toBe(true);
});
