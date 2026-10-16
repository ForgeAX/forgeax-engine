import { describe, expect, it } from 'vitest';
import { reflectVfxLayout } from '../reflection.js';

describe('VFX reflection failures', () => {
  it.each([
    ['explicit empty struct', 'struct VfxParameters {}', 'vfx-reflection-empty-struct'],
    ['unknown type', 'struct VfxParameters { value: mat3x3<f32>, }', 'vfx-reflection-unknown-type'],
    [
      'invalid dimension',
      'struct VfxParameters { value: array<f32, 2>, }',
      'vfx-reflection-invalid-dimension',
    ],
    [
      'duplicate field',
      'struct VfxParameters { value: f32, value: u32, }',
      'vfx-reflection-duplicate-field',
    ],
  ])('fails closed for %s', (_name, root, code) => {
    const result = reflectVfxLayout({ root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(code);
      expect(result.error.expected).not.toBe('');
      expect(result.error.hint).not.toBe('');
      expect(result.error.detail).toBeDefined();
    }
  });

  it('rejects an unknown field annotation instead of silently dropping it', () => {
    const result = reflectVfxLayout({
      root: '// forgeax-vfx-unknown field = 1\nstruct VfxParameters { value: f32, }',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('vfx-reflection-unknown-field');
  });

  it('rejects a duplicate imported struct identity', () => {
    const result = reflectVfxLayout({
      root: '#import shared::values\nstruct VfxParameters { value: f32, }',
      imports: {
        'shared::values': 'struct VfxParameters { value: f32, }',
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('vfx-reflection-duplicate-struct');
  });

  it('rejects a layout that exceeds the bounded packed ABI', () => {
    const fields = Array.from({ length: 4097 }, (_, index) => `field${index}: vec4<f32>`).join(
      ',\n',
    );
    const uses = Array.from({ length: 4097 }, (_, index) => `_ = parameters.field${index};`).join(
      '\n',
    );
    const result = reflectVfxLayout({
      root: `struct VfxParameters { ${fields}, }\nfn use_values() { var parameters: VfxParameters; ${uses} }`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('vfx-reflection-layout-overflow');
  });
});
