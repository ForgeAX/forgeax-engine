import { describe, expect, it } from 'vitest';

const inputs = [
  { name: 'factor alpha', factorAlpha: 0.4, textureAlpha: 1, expected: 0.4 },
  { name: 'texture alpha', factorAlpha: 1, textureAlpha: 0.35, expected: 0.35 },
  { name: 'factor times texture alpha', factorAlpha: 0.4, textureAlpha: 0.35, expected: 0.14 },
] as const;

describe('material alpha RGBA and factor cases', () => {
  it.each(inputs)('keeps an independent analytic assertion for $name', (input) => {
    expect(input.factorAlpha * input.textureAlpha).toBeCloseTo(input.expected, 8);
  });
});
