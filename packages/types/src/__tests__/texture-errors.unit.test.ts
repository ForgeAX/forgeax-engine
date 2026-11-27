import { describe, expect, it } from 'vitest';
import type { TextureShape } from '../texture/asset.js';
import { validateTextureShape } from '../texture/errors.js';
import { validateTextureLayout } from '../texture/layout.js';

describe('texture rejection matrix', () => {
  it.each([
    [
      'zero width',
      { viewDimension: '2d', extent: { width: 0, height: 2 } },
      'texture-shape-invalid',
    ],
    [
      'negative depth',
      { viewDimension: '3d', extent: { width: 2, height: 2, depth: -1 } },
      'texture-shape-invalid',
    ],
    [
      'zero array layers',
      { viewDimension: '2d-array', extent: { width: 2, height: 2, layers: 0 } },
      'texture-shape-invalid',
    ],
  ] as const)('%s has a narrowed structured detail', (_name, shape, code) => {
    const result = validateTextureShape(shape);
    expect(result).toMatchObject({
      ok: false,
      error: { code, expected: expect.any(String), hint: expect.any(String) },
    });
    if (!result.ok) expect(result.error.detail.code).toBe(code);
  });

  it.each([
    ['2d', { height: 2 }, 'width'],
    ['2d', { width: 2 }, 'height'],
    ['2d-array', { width: 2, height: 2 }, 'layers'],
    ['3d', { width: 2, height: 2 }, 'depth'],
  ] as const)('rejects a missing %s extent axis', (viewDimension, extent, field) => {
    const shape = { viewDimension, extent } as TextureShape;
    expect(validateTextureShape(shape)).toMatchObject({
      ok: false,
      error: { code: 'texture-shape-invalid', detail: { field } },
    });
  });

  it('reads all enumerable extent values before reporting the first invalid axis', () => {
    const error = new Error('extent read interrupted');
    const extent = {
      width: 0,
      get height(): number {
        throw error;
      },
    };
    expect(() => validateTextureShape({ viewDimension: '2d', extent })).toThrow(error);
  });

  it('rejects incompatible mip policies and unsupported authored formats', () => {
    const generate3d = validateTextureShape(
      { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
      { kind: 'generate' },
    );
    expect(generate3d).toMatchObject({ ok: false, error: { code: 'texture-mip-policy-invalid' } });

    const compressed3d = validateTextureShape(
      { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
      { kind: 'none' },
      'bc1-rgba-unorm',
    );
    expect(compressed3d).toMatchObject({
      ok: false,
      error: { code: 'texture-format-dimension-unsupported' },
    });

    const depth = validateTextureShape(
      { viewDimension: '2d', extent: { width: 2, height: 2 } },
      { kind: 'none' },
      'depth24plus',
    );
    expect(depth).toMatchObject({
      ok: false,
      error: { code: 'texture-format-dimension-unsupported' },
    });
  });

  it('uses the same generated mip bounds for shape and layout admission', () => {
    const shape = {
      viewDimension: '2d-array',
      extent: { width: 8, height: 4, layers: 24 },
    } as const;
    const format = 'rgba8unorm';
    const mips = { kind: 'custom', levelCount: 4 } as const;
    const volume = { viewDimension: '3d', extent: { width: 8, height: 4, depth: 2 } } as const;
    const cases = [
      { shape, mips, expected: true },
      { shape, mips: { ...mips, levelCount: 5 }, expected: false },
      { shape, mips: { ...mips, levelCount: 1.5 }, expected: false },
      { shape: volume, mips, expected: false },
    ];
    for (const sample of cases) {
      const received = validateTextureShape(sample.shape, sample.mips, format);
      expect(received).toEqual(validateTextureLayout({ ...sample, format }));
      expect(received.ok).toBe(sample.expected);
      if (!received.ok)
        expect(received.error.detail).toMatchObject({
          code: 'texture-mip-policy-invalid',
          policy: 'custom',
        });
    }
  });
});
