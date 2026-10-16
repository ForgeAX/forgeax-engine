import { describe, expect, it } from 'vitest';

function normalizeDirection(direction: readonly [number, number, number]):
  | readonly [number, number, number]
  | null {
  const length = Math.hypot(...direction);
  if (length <= 1e-6) return null;
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

describe('direct-light spot direction boundaries', () => {
  it('normalizes a non-unit direction once for both pipeline consumers', () => {
    const normalized = normalizeDirection([2, -2, 1]);
    expect(normalized).not.toBeNull();
    expect(normalized?.map((value) => Number(value.toFixed(6)))).toEqual([
      0.666667,
      -0.666667,
      0.333333,
    ]);
    expect(normalized).toEqual(normalized);
  });

  it('keeps a unit direction unchanged', () => {
    expect(normalizeDirection([0, -1, 0])).toEqual([0, -1, 0]);
  });

  it('returns a structured null boundary for a degenerate direction', () => {
    expect(normalizeDirection([0, 0, 0])).toBeNull();
    expect(normalizeDirection([1e-8, 0, 0])).toBeNull();
  });
});
