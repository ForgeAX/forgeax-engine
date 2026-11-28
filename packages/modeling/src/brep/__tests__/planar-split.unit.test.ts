import { describe, expect, it } from 'vitest';
import { splitPlanarPolygon } from '../planar-split.ts';
import type { P3 } from '../vec.ts';

const TOL = 1e-7;
// Unit square in the z = 0 plane, counter-clockwise seen from +z.
const SQUARE: P3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];
// L-shape (concave at (1,1)), counter-clockwise: area 3.
const L: P3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [2, 1, 0],
  [1, 1, 0],
  [1, 2, 0],
  [0, 2, 0],
];

/** Shoelace area in the z = 0 plane, signed. */
function area(poly: readonly P3[]): number {
  let s = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k] as P3;
    const q = poly[(k + 1) % poly.length] as P3;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

describe('splitPlanarPolygon', () => {
  it('splits a square along a diagonal into two triangles that tile it', () => {
    const r = splitPlanarPolygon(SQUARE, 0, 2, TOL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.first).toHaveLength(3);
    expect(r.value.second).toHaveLength(3);
    // Both sides are counter-clockwise, so their areas are positive and sum to the square.
    expect(area(r.value.first)).toBeCloseTo(0.5, 12);
    expect(area(r.value.second)).toBeCloseTo(0.5, 12);
    expect(area(r.value.first) + area(r.value.second)).toBeCloseTo(area(SQUARE), 12);
  });

  it('splits a concave L-shape along an interior chord and conserves its area', () => {
    // Chord from (0,0) to (1,2) cuts the L into two pieces.
    const r = splitPlanarPolygon(L, 0, 4, TOL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(area(r.value.first) + area(r.value.second)).toBeCloseTo(3, 12);
  });

  it('refuses a chord that leaves a concave polygon (falsifier: no false split)', () => {
    // Chord from (2,0) to (0,2) passes outside the notch at (1,1): the L is not convex.
    const r = splitPlanarPolygon(L, 1, 5, TOL);
    expect(r.ok).toBe(false);
  });

  it('refuses a chord joining adjacent vertices (they are an edge, not a section)', () => {
    expect(splitPlanarPolygon(SQUARE, 0, 1, TOL).ok).toBe(false);
  });

  it('refuses out-of-range and equal vertex indices', () => {
    expect(splitPlanarPolygon(SQUARE, 0, 9, TOL).ok).toBe(false);
    expect(splitPlanarPolygon(SQUARE, 2, 2, TOL).ok).toBe(false);
  });

  it('refuses a polygon with fewer than three vertices', () => {
    expect(
      splitPlanarPolygon(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        0,
        1,
        TOL,
      ).ok,
    ).toBe(false);
  });

  it('refuses a split whose sub-loop would be degenerate (deliberate break)', () => {
    // Break: vertices 0, 1, 2 are collinear on the x-axis, and vertex 3 sits off that line. Newell's
    // normal uses the whole loop, so the plane is valid; chord 0 -> 2 then encloses a zero-area side,
    // which the area guard must refuse rather than emit a sliver face.
    const sliver: P3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [1, 0.5, 0],
    ];
    const r = splitPlanarPolygon(sliver, 0, 2, TOL);
    expect(r.ok).toBe(false);
  });
});
