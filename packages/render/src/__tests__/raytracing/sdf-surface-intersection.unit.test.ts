import { describe, expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  exactSurface,
  intervalArithmeticCases,
  intervalArithmeticKernel,
  surfaceCases,
  surfaceKernel,
  validatePermittedScalar,
} from './sdf-surface-intersection.fixture';

describe('conservative surface primitive inputs', () => {
  it('controlled scalar witnesses stay inside the specified rounding allowance', () => {
    for (const row of intervalArithmeticCases)
      if ('roundedBits' in row) expect(() => validatePermittedScalar(row), row.name).not.toThrow();
  });
  it('controlled scalar witness validation rejects inaccurate and non-rounded results', () => {
    expect(() =>
      validatePermittedScalar({
        name: 'exact-add-is-not-an-adjacent-approximation',
        op: 5,
        a: 1,
        b: 0,
        roundedBits: 0x3f800001,
        valid: true,
      }),
    ).toThrow();
    expect(() =>
      validatePermittedScalar({
        name: 'power-of-two-division-too-inaccurate',
        op: 4,
        a: 1,
        b: 1,
        roundedBits: 0x3f800002,
        valid: true,
      }),
    ).toThrow();
  });
  it('compiles both actual entrypoints through the shader producer', async () => {
    for (const [id, source] of [
      ['surface', surfaceKernel],
      ['arithmetic', intervalArithmeticKernel],
    ] as const) {
      const result = await compileShader(source, { id: `sdf-surface-${id}` });
      expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    }
  });
  it('keeps non-unit original ray parameters in an independent integer oracle', () => {
    for (const speed of [0.5, 1, 2]) {
      const row = surfaceCases().find((r) => r.name === `scale-1-speed-${speed}-reverse-false`);
      expect(row).toBeDefined();
      if (row === undefined) throw new Error('Authored non-unit case missing');
      const exact = exactSurface(row);
      expect(exact.kind).toBe('hit');
      if (exact.kind !== 'hit') throw new Error('Authored through ray must hit');
      expect(exact.time * BigInt(speed * 2)).toBe(exact.det * 4n);
    }
  });
  it('separates the AABB-overlap miss from a true triangle hit', () => {
    const row = surfaceCases().find((r) => r.name === 'aabb-overlap-triangle-miss');
    if (row === undefined) throw new Error('Required silhouette negative missing');
    expect(exactSurface(row).kind).toBe('clear');
  });
});
