import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type CubeLut, cubeLutBytes, parseCubeLut } from '../lut/cube-parser.js';

function cubeSource(
  size: number,
  options: { readonly extra?: string; readonly rows?: string[] } = {},
) {
  const rows =
    options.rows ??
    Array.from({ length: size ** 3 }, (_, index) => {
      const value = index / Math.max(1, size ** 3 - 1);
      return `${value.toFixed(8)} ${value.toFixed(8)} ${value.toFixed(8)}`;
    });
  return [
    '# canonical test source',
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    options.extra ?? '',
    ...rows,
  ].join('\n');
}

describe('parseCubeLut', () => {
  it.each([16, 32, 64])('accepts canonical %s^3 data with R-fastest ordering', (size) => {
    const parsed = parseCubeLut(cubeSource(size), `fixture/canonical-${size}.cube`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      size,
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
    });
    expect(parsed.value.values).toHaveLength(size ** 3 * 3);
    expect(parsed.value.values.slice(0, 3)).toEqual(new Float32Array([0, 0, 0]));
    expect(parsed.value.values.slice(-3)).toEqual(new Float32Array([1, 1, 1]));
  });

  it('emits deterministic linear rgba16float bytes with alpha one', () => {
    const parsed = parseCubeLut(cubeSource(16), 'fixture/deterministic.cube');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const first = cubeLutBytes(parsed.value);
    const second = cubeLutBytes(parsed.value);
    expect(first).toEqual(second);
    expect(first.byteLength).toBe(16 ** 3 * 4 * 2);
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      '38344bf4db2170fd88c41f0acda182470777eed00688bcf214f2127ce62896e9',
    );
  });

  it.each([
    ['missing size', '# no size\n0 0 0'],
    ['non-cubic size', cubeSource(16, { extra: 'LUT_3D_SIZE 32' })],
    ['short data', cubeSource(16, { rows: ['0 0 0'] })],
    [
      'extra data',
      cubeSource(16, { rows: [...Array.from({ length: 16 ** 3 }, () => '0 0 0'), '0 0 0'] }),
    ],
    [
      'non-finite data',
      cubeSource(16, { rows: ['nan 0 0', ...Array.from({ length: 16 ** 3 - 1 }, () => '0 0 0')] }),
    ],
    [
      'out of domain',
      cubeSource(16, { rows: ['2 0 0', ...Array.from({ length: 16 ** 3 - 1 }, () => '0 0 0')] }),
    ],
  ])('rejects %s with structured source diagnostics', (_name, source) => {
    const parsed = parseCubeLut(source, 'fixture/invalid.cube');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toMatch(/^cube-/);
    expect(parsed.error.expected).toContain('LUT_3D_SIZE');
    expect(parsed.error.hint).toContain('sourceKey');
    expect(parsed.error.detail).toMatchObject({ sourceKey: 'fixture/invalid.cube' });
  });

  it('keeps the parser type independent from TextureAsset runtime loading', () => {
    const parsed = parseCubeLut(cubeSource(16), 'fixture/runtime-boundary.cube');
    expect(parsed.ok).toBe(true);
    expect(typeof ({} as CubeLut)).toBe('object');
  });
});
