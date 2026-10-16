import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  admitStandardColorLut,
  createStandardLutSamplerDescriptor,
  type StandardColorLutAdmissionInput,
} from '../lut-admission';

function texture(overrides: Partial<TextureAsset> = {}): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 16, height: 16, depth: 16 } },
    format: 'rgba16float',
    data: new Uint8Array(16 * 16 * 16 * 8),
    colorSpace: 'linear',
    mips: { kind: 'none' },
    ...overrides,
  };
}

function input(overrides: Partial<StandardColorLutAdmissionInput> = {}) {
  return {
    texture: texture(),
    maxTextureDimension3D: 2048,
    rgba16floatFilterable: true,
    bind: () => true,
    ...overrides,
  } satisfies StandardColorLutAdmissionInput;
}

describe('Standard output 3D LUT admission', () => {
  it('accepts a linear, equal-extent, single-mip rgba16float texture', () => {
    const result = admitStandardColorLut(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.viewDimension).toBe('3d');
    expect(result.value.extent).toEqual({ width: 16, height: 16, depth: 16 });
    expect(result.value.sampler).toEqual(createStandardLutSamplerDescriptor());
  });

  it.each([
    ['view dimension', { shape: { viewDimension: '2d', extent: { width: 16, height: 16 } } }],
    [
      'unequal extent',
      { shape: { viewDimension: '3d', extent: { width: 16, height: 17, depth: 16 } } },
    ],
    ['format', { format: 'rgba32float' }],
    ['color space', { colorSpace: 'srgb' }],
    ['mip policy', { mips: { kind: 'generate' } }],
  ] as const)('rejects invalid %s', (_name, overrides) => {
    const result = admitStandardColorLut(input({ texture: texture(overrides as never) }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('standard-lut-shape-invalid');
  });

  it('rejects dimensions over the live 3D limit', () => {
    const result = admitStandardColorLut(
      input({
        texture: texture({
          shape: { viewDimension: '3d', extent: { width: 4096, height: 4096, depth: 4096 } },
        }),
        maxTextureDimension3D: 2048,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('standard-lut-limit-exceeded');
  });

  it('does not infer rgba16float filterability from float32 filterability', () => {
    const result = admitStandardColorLut(input({ rgba16floatFilterable: false }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('standard-lut-filter-unavailable');
  });

  it('requires a successful live bind probe', () => {
    const result = admitStandardColorLut(input({ bind: () => false }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('standard-lut-bind-failed');
  });

  it('uses clamp-to-edge linear filtering', () => {
    expect(createStandardLutSamplerDescriptor()).toEqual({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
    });
  });
});
