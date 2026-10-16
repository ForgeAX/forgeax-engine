import { describe, expect, it } from 'vitest';

const cases = [
  { name: 'default cutoff', alpha: 0.49, cutoff: 0.5, discarded: true },
  { name: 'equal cutoff', alpha: 0.5, cutoff: 0.5, discarded: true },
  { name: 'zero cutoff', alpha: 0, cutoff: 0, discarded: false },
  { name: 'one cutoff', alpha: 0.99, cutoff: 1, discarded: true },
] as const;

describe('material alpha MASK cutoff cases', () => {
  it.each(cases)('matches Three r184 discard boundary for $name', (entry) => {
    expect(entry.cutoff > 0 && entry.alpha <= entry.cutoff).toBe(entry.discarded);
  });
});
