import { describe, expect, it } from 'vitest';
import { type Soup, sampleDistances, signedDeviation } from '../compute/mesh-query';
import type { Tuple3 } from '../geom';

/** Welded, outward-oriented box soup over [lo, hi]. */
function box(lo: Tuple3, hi: Tuple3): Soup {
  const points: number[] = [];
  for (let i = 0; i < 8; i++)
    points.push(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const corners = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d] as number[]);
  return { points: Float64Array.from(points), corners: Int32Array.from(corners) };
}

describe('signedDeviation', () => {
  it('splits a shrunken and a grown box into inside and outside', () => {
    const cube = box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
    const shrunk = signedDeviation(box([-0.45, -0.45, -0.45], [0.45, 0.45, 0.45]), cube);
    expect(shrunk.inside.max).toBeCloseTo(0.05, 12);
    expect(shrunk.inside.p95).toBeCloseTo(0.05, 12);
    expect(shrunk.outside).toEqual({ max: 0, p95: 0 });
    // The grown corners sit off the cube's vertices: the vertex pseudo-normal signs them.
    const grown = signedDeviation(box([-0.55, -0.55, -0.55], [0.55, 0.55, 0.55]), cube);
    expect(grown.outside.max).toBeCloseTo(0.05 * Math.sqrt(3), 12);
    expect(grown.inside).toEqual({ max: 0, p95: 0 });
  });

  it('reports both sides of a box with one face pushed out and one pushed in', () => {
    const cube = box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
    const from = box([-0.5, -0.48, -0.5], [0.53, 0.5, 0.5]);
    const r = signedDeviation(from, cube);
    expect(r.outside.max).toBeCloseTo(0.03, 12);
    expect(r.inside.max).toBeCloseTo(0.02, 12);
    const unsigned = Math.max(...sampleDistances(from, cube).distance);
    expect(Math.max(r.inside.max, r.outside.max)).toBe(unsigned);
  });

  it('keeps a sample off a sharp edge outside where the closest face normal says inside', () => {
    // A 30 degree wedge prism along z with its sharp edge on the z axis, the upper face first.
    const t = Math.tan((15 * Math.PI) / 180);
    const pts: Tuple3[] = [
      [0, 0, -1],
      [-1, t, -1],
      [-1, -t, -1],
      [0, 0, 1],
      [-1, t, 1],
      [-1, -t, 1],
    ];
    const corners = [0, 1, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4, 0, 2, 1, 3, 4, 5];
    const wedge: Soup = {
      points: Float64Array.from(pts.flat()),
      corners: Int32Array.from(corners),
    };
    const upper: Tuple3 = [Math.sin((15 * Math.PI) / 180), Math.cos((15 * Math.PI) / 180), 0];
    const lower: Tuple3 = [upper[0], -upper[1], 0];
    const dir = [0, 1, 2].map(
      (k) => 0.9 * (lower[k] as number) + 0.1 * (upper[k] as number),
    ) as Tuple3;
    const len = Math.hypot(...dir);
    const p = dir.map((x) => (0.01 * x) / len) as Tuple3;
    const e = 1e-6;
    const from: Soup = {
      points: Float64Array.from([...p, p[0], p[1], p[2] + e, p[0], p[1] + e, p[2]]),
      corners: Int32Array.from([0, 1, 2]),
    };
    // Falsifier: the fixture's closest triangle is the upper face, whose normal points away.
    const sampled = sampleDistances(from, wedge);
    const tri = sampled.closest[0] as number;
    expect(tri).toBeLessThan(2);
    expect(p[0] * upper[0] + p[1] * upper[1]).toBeLessThan(0);
    const r = signedDeviation(from, wedge);
    expect(r.inside.max).toBe(0);
    expect(r.outside.max).toBeCloseTo(0.01, 5);
  });
});
