import { describe, expect, it } from 'vitest';
import { fresnelReflectance } from '../oracle.js';

describe('transmission CPU oracle', () => {
  it('keeps total internal reflection as reflection', () => {
    expect(fresnelReflectance(0.5, 1.5)).toBe(1);
    expect(fresnelReflectance(1, 1 / 1.5)).toBeCloseTo(0.04, 8);
  });
});
