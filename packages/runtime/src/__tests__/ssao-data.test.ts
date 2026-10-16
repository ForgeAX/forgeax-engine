// ssao-kernel.test.ts -- M1 / w1: kernel distribution test (TDD red phase).
//
// Asserts:
//  - generateSsaoKernel() returns 64 vec3 samples.
//  - All z >= 0 (tangent-space hemisphere).
//  - Quadratic falloff: first sample magnitude < last sample magnitude.
//  - Same seed produces byte-identical output (deterministic).
//  - generateSsaoNoise() returns 4x4=16 vec3 rotation vectors.
//  - All noise z == 0 (tangent-plane rotation).
//
// AC-03 anchor: kernel length 64 + distribution properties.

import { describe, expect, it } from 'vitest';
import { generateSsaoKernel, generateSsaoNoise } from '../../../render/src/ssao-buffers';

function readFloat(v: Float32Array, idx: number): number {
  const val = v[idx];
  if (val === undefined) throw new Error(`missing float at index ${idx}`);
  return val;
}

function readSample(kernel: readonly Float32Array[], i: number): Float32Array {
  const s = kernel[i];
  if (s === undefined) throw new Error(`missing sample at index ${i}`);
  return s;
}

describe('generateSsaoKernel', () => {
  it('returns 64 vec3 samples', () => {
    const kernel = generateSsaoKernel();
    expect(kernel).toHaveLength(64);
    for (const v of kernel) {
      expect(v).toHaveLength(3);
    }
  });

  it('all samples have z >= 0 (tangent-space hemisphere)', () => {
    const kernel = generateSsaoKernel();
    for (const v of kernel) {
      expect(readFloat(v, 2)).toBeGreaterThanOrEqual(0);
    }
  });

  it('quadratic falloff: first sample magnitude < last sample magnitude', () => {
    const kernel = generateSsaoKernel();
    const s0 = readSample(kernel, 0);
    const s63 = readSample(kernel, 63);
    const firstMag = Math.sqrt(
      readFloat(s0, 0) ** 2 + readFloat(s0, 1) ** 2 + readFloat(s0, 2) ** 2,
    );
    const lastMag = Math.sqrt(
      readFloat(s63, 0) ** 2 + readFloat(s63, 1) ** 2 + readFloat(s63, 2) ** 2,
    );
    expect(firstMag).toBeLessThan(lastMag);
  });

  it('same seed produces byte-identical output', () => {
    const a = generateSsaoKernel(42);
    const b = generateSsaoKernel(42);
    expect(a).toEqual(b);
  });

  it('different seeds produce different output', () => {
    const a = generateSsaoKernel(1);
    const b = generateSsaoKernel(2);
    let diff = false;
    for (let i = 0; i < 64; i++) {
      const sa = readSample(a, i);
      const sb = readSample(b, i);
      if (
        readFloat(sa, 0) !== readFloat(sb, 0) ||
        readFloat(sa, 1) !== readFloat(sb, 1) ||
        readFloat(sa, 2) !== readFloat(sb, 2)
      ) {
        diff = true;
        break;
      }
    }
    expect(diff).toBe(true);
  });

  it('samples are normalized directions scaled by length <= 1', () => {
    const kernel = generateSsaoKernel();
    for (const v of kernel) {
      const mag = Math.sqrt(readFloat(v, 0) ** 2 + readFloat(v, 1) ** 2 + readFloat(v, 2) ** 2);
      expect(mag).toBeGreaterThan(0);
      expect(mag).toBeLessThanOrEqual(1);
    }
  });
});

describe('generateSsaoNoise', () => {
  it('returns a Float32Array of 48 floats (4*4*3)', () => {
    const noise = generateSsaoNoise();
    expect(noise).toBeInstanceOf(Float32Array);
    expect(noise).toHaveLength(48);
  });

  it('all noise z-components are 0 (tangent-plane rotation)', () => {
    const noise = generateSsaoNoise();
    for (let i = 0; i < 16; i++) {
      const z = noise[i * 3 + 2];
      expect(z).toBe(0);
    }
  });

  it('each rotation vector is non-zero in xy plane', () => {
    const noise = generateSsaoNoise();
    for (let i = 0; i < 16; i++) {
      const x = noise[i * 3 + 0];
      const y = noise[i * 3 + 1];
      expect(x !== 0 || y !== 0).toBe(true);
    }
  });

  it('same seed produces byte-identical output', () => {
    const a = generateSsaoNoise(7);
    const b = generateSsaoNoise(7);
    expect(a).toEqual(b);
  });
});
