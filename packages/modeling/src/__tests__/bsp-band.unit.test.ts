import { describe, expect, it } from 'vitest';
import { type Plane, type Poly, planeOf, splitPoly } from '../compute/bsp';
import type { Tuple3 } from '../geom';

const EPS = 1e-3;
const PLANE: Plane = { n: [0, 0, 1], w: 0 };

function triangle(a: Tuple3, b: Tuple3, c: Tuple3): Poly {
  return { points: [a, b, c], plane: planeOf(a, b, c) as Plane, source: 0 };
}

describe('splitPoly band vertices', () => {
  it('a corner in the band stays on the plane when the plane crosses its edges within a few tolerances', () => {
    const split = splitPoly(
      PLANE,
      triangle([0, 0, -0.9e-3], [0.025, 0, 0.01], [0, 0.025, 0.01]),
      EPS,
    );
    expect(split.front).toBeDefined();
    expect(split.back).toBeUndefined();
  });

  it('a corner in the band takes its own side when the plane cuts the polygon far from it', () => {
    const a: Tuple3 = [0, 0, -5e-5];
    const split = splitPoly(PLANE, triangle(a, [100, 0, 0.3], [0, 100, 0.3]), EPS);
    expect(split.front).toBeDefined();
    expect(split.back).toBeDefined();
    expect(split.back?.points.length).toBe(3);
    expect(split.front?.points).not.toContain(undefined);
    const crossing = (split.back?.points ?? []).filter((p) => p !== a);
    for (const p of crossing) expect(Math.abs(p[2] as number)).toBeLessThan(1e-9);
  });

  it('measures the crossing along the edge, not as a share of it', () => {
    const split = splitPoly(PLANE, triangle([0, 0, -5e-5], [100, 0, 0.3], [0, 100, 0.3]), EPS);
    expect(split.back).toBeDefined();
  });

  it('a corner deeper in the band than a tenth of the tolerance stays on the plane however far the crossing', () => {
    const split = splitPoly(PLANE, triangle([0, 0, -0.5e-3], [100, 0, 0.3], [0, 100, 0.3]), EPS);
    expect(split.front).toBeDefined();
    expect(split.back).toBeUndefined();
  });

  it('a neighbour on the same side of the plane does not move the corner', () => {
    const a: Tuple3 = [0, 0, 0.9e-3];
    const split = splitPoly(PLANE, triangle(a, [100, 0, 1], [0, 0.001, -1]), EPS);
    expect(split.back).toBeDefined();
    expect(split.back?.points).toContain(a);
  });

  it('a polygon whose corners are all in the band is coplanar', () => {
    const split = splitPoly(PLANE, triangle([0, 0, 0], [1, 0, 0.5e-3], [0, 1, -0.5e-3]), EPS);
    expect(split.coplanar).toBeDefined();
  });

  // A corner at `depth` tolerances behind the plane, joined to a corner `rise` above it by an
  // edge that the plane crosses `reach` tolerances from the first corner.
  function reaching(depth: number, reach: number) {
    const rise = 0.3;
    const dist = depth * EPS;
    const ratio = dist / (dist + rise);
    const run = Math.sqrt((reach * EPS) ** 2 / ratio ** 2 - (rise + dist) ** 2);
    return triangle([0, 0, -dist], [run, 0, rise], [0, run, rise]);
  }

  it('settles a corner whose crossing lies beyond four tolerances, and not one within them (falsifier)', () => {
    expect(splitPoly(PLANE, reaching(0.05, 3.9), EPS).back).toBeUndefined();
    expect(splitPoly(PLANE, reaching(0.05, 4.1), EPS).back).toBeDefined();
    // Well inside the reach a corner that merely touches the plane stays on it: settling
    // would cut a sliver off the polygon.
    expect(splitPoly(PLANE, reaching(0.05, 0.07), EPS).back).toBeUndefined();
  });

  it('settles a corner up to a tenth of the tolerance deep, and not one deeper (falsifier)', () => {
    expect(splitPoly(PLANE, reaching(0.09, 50), EPS).back).toBeDefined();
    expect(splitPoly(PLANE, reaching(0.11, 50), EPS).back).toBeUndefined();
  });

  it('settle off keeps the band decision alone', () => {
    expect(splitPoly(PLANE, reaching(0.05, 50), EPS, false).back).toBeUndefined();
    expect(splitPoly(PLANE, reaching(0.05, 50), EPS).back).toBeDefined();
  });
});
