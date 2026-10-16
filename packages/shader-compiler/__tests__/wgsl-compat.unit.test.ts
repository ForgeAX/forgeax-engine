import { describe, expect, it } from 'vitest';
import { compileShader } from '../src/index.js';
import { canonicalizePortableWgsl } from '../src/wgsl-compat.js';

describe('WGSL browser compatibility', () => {
  it('rewrites only long integer-style decimal f32 literals', () => {
    const source = [
      'let short = 9999999999999999999f;',
      'let long = 100000000000000000000f;',
      'let nonPower = 12345678901234567890f;',
      'let negative = -100000000000000000000f;',
      'let decimal = 6.2f;',
      'let exponent = 1e20f;',
    ].join('\n');

    expect(canonicalizePortableWgsl(source)).toBe(
      [
        'let short = 9999999999999999999f;',
        'let long = 1e20f;',
        'let nonPower = 1.234567890123456789e19f;',
        'let negative = -1e20f;',
        'let decimal = 6.2f;',
        'let exponent = 1e20f;',
      ].join('\n'),
    );
  });

  it('does not rewrite comments, identifiers, or other token families', () => {
    const source = [
      'let suffix100000000000000000000f = 1f;',
      '// 100000000000000000000f',
      '/* 100000000000000000000f */',
      'let hexLike = 0x1p+4f;',
      'let integer = 100000000000000000000u;',
    ].join('\n');

    expect(canonicalizePortableWgsl(source)).toBe(source);
  });

  it('is idempotent', () => {
    const source = 'let value = 100000000000000000000f;';
    const normalized = canonicalizePortableWgsl(source);
    const repeated = canonicalizePortableWgsl(normalized);

    expect(repeated).toBe(normalized);
  });

  it('keeps compiler output concrete and Safari-compatible', async () => {
    const result = await compileShader(
      '@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 6.2, 0.0, 1.0); }',
      { id: 'game::safari-wgsl-literals' },
    );

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.wgsl).toContain('1f');
    expect(result.value.wgsl).toContain('6.2f');
  });

  it('normalizes the reproduced long decimal emitted by Naga', async () => {
    const result = await compileShader(
      '@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1e20); }',
      { id: 'game::safari-long-decimal' },
    );

    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.value.wgsl).toContain('1e20f');
    expect(result.value.wgsl).not.toContain('100000000000000000000f');
  });
});
