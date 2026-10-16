import { describe, expect, it } from 'vitest';
import { validateTextureShape } from '../texture/errors.js';

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
});
