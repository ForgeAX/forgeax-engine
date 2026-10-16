import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../lighting-directional.wgsl', import.meta.url), 'utf8');

type Vec3 = readonly [number, number, number];

function unsafeNormalize(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function directionalHalfVector(viewDir: Vec3, lightDir: Vec3): Vec3 {
  const sum: Vec3 = [viewDir[0] + lightDir[0], viewDir[1] + lightDir[1], viewDir[2] + lightDir[2]];
  const lengthSquared = Math.max(sum[0] ** 2 + sum[1] ** 2 + sum[2] ** 2, 1e-8);
  const inverseLength = 1 / Math.sqrt(lengthSquared);
  return [sum[0] * inverseLength, sum[1] * inverseLength, sum[2] * inverseLength];
}

describe('directional GGX half-vector boundary', () => {
  it('reproduces the old normalize zero-vector failure', () => {
    const halfVector: Vec3 = [0, 0, 0];
    expect(unsafeNormalize(halfVector).some((value) => !Number.isFinite(value))).toBe(true);
  });

  it.each([
    ['anti-parallel', [0, 0, 1] as const, [0, 0, -1] as const],
    ['near anti-parallel', [0, 0, 1] as const, [1e-5, 0, -1] as const],
  ])('%s inputs remain finite in evalDirectionalNoShadow', (_name, viewDir, lightDir) => {
    expect(directionalHalfVector(viewDir, lightDir).every(Number.isFinite)).toBe(true);
  });

  it('uses a finite lower bound for the half-vector length', () => {
    expect(source).toContain('max(dot(halfVector, halfVector), 1e-8)');
  });
});
