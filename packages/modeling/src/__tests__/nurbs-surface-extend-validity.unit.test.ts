import { describe, expect, it } from 'vitest';
import { nurbs } from '../nurbs';

const w = Math.SQRT1_2;
const quarter = {
  degreeU: 2,
  degreeV: 1,
  points: [
    [
      [1, 0, 0],
      [1, 0, 1],
    ],
    [
      [1, 1, 0],
      [1, 1, 1],
    ],
    [
      [0, 1, 0],
      [0, 1, 1],
    ],
  ],
  weights: [
    [1, 1],
    [w, w],
    [1, 1],
  ],
  knotsU: [0, 0, 0, 1, 1, 1],
  knotsV: [0, 0, 1, 1],
} as unknown as Parameters<typeof nurbs.checkSurface>[0];

const reachOf = (e: typeof quarter): number => {
  const end = (s: typeof quarter) => {
    const [[, u1], [v0]] = nurbs.surfaceDomain(s) as unknown as [
      [number, number],
      [number, number],
    ];
    return nurbs.surfacePoint(s, u1, v0) as [number, number, number];
  };
  const a = end(quarter);
  const b = end(e);
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
};

describe('S-R3 a rational extension is valid and reaches its length, or fails structured', () => {
  it.each([3, 6, 12])('G2 length %f never returns an invalid patch', (len) => {
    const r = nurbs.surface.extend(quarter, 'u1', len, { continuity: 'G2' });
    if (r.ok) {
      expect(nurbs.checkSurface(r.value).ok).toBe(true);
      expect(Math.min(...(r.value.weights ?? []).flat())).toBeGreaterThan(0);
    } else {
      expect(r.error.code).toBe('model-precondition');
    }
  });

  it.each([3, 6, 12])('G1 length %f reaches the length or fails structured', (len) => {
    const r = nurbs.surface.extend(quarter, 'u1', len, { continuity: 'G1' });
    if (r.ok) expect(Math.abs(reachOf(r.value) - len)).toBeLessThan(1e-3 * len);
    else expect(r.error.code).toBe('model-precondition');
  });

  it('the over-long rational extension fails instead of returning a short patch', () => {
    const r = nurbs.surface.extend(quarter, 'u1', 3, { continuity: 'G1' });
    expect(r.ok).toBe(false);
  });

  it('a reachable length still succeeds', () => {
    const r = nurbs.surface.extend(quarter, 'u1', 0.2, { continuity: 'G2' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.abs(reachOf(r.value) - 0.2)).toBeLessThan(1e-3);
  });
});
