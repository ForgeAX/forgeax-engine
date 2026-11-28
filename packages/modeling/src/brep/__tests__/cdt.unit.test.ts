import { describe, expect, it } from 'vitest';
import { incircleCertain, triangulateRings } from '../cdt';
import type { P2 } from '../vec';

function area2(a: P2, b: P2, c: P2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function ringArea(points: readonly P2[], ring: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = points[ring[i] as number] as P2;
    const q = points[ring[(i + 1) % ring.length] as number] as P2;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/** Undirected edges of a triangle list, with their use count. */
function edgeUses(tris: readonly (readonly number[])[]): Map<string, number> {
  const uses = new Map<string, number>();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const a = t[k] as number;
      const b = t[(k + 1) % 3] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return uses;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A star polygon: the falsifier family in which a plain Delaunay misses boundary segments. */
function star(next: () => number, n: number): P2[] {
  const pts: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * (i + 0.3 * next())) / n;
    const r = 0.15 + 0.85 * next();
    pts.push([0.5 + 0.5 * r * Math.cos(a), 0.5 + 0.5 * r * Math.sin(a)]);
  }
  return pts;
}

describe('incircleCertain', () => {
  it('is positive inside, negative outside and 0 on a cocircular point', () => {
    const a: P2 = [1, 0];
    const b: P2 = [0, 1];
    const c: P2 = [-1, 0];
    expect(incircleCertain(a, b, c, [0, 0])).toBeGreaterThan(0);
    expect(incircleCertain(a, b, c, [2, 2])).toBeLessThan(0);
    expect(incircleCertain(a, b, c, [0, -1])).toBe(0);
  });
});

describe('triangulateRings', () => {
  it('meshes a square with a square hole: area, closed boundary and no triangle in the hole', () => {
    const points: P2[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0.4, 0.4],
      [0.4, 0.6],
      [0.6, 0.6],
      [0.6, 0.4],
    ];
    const r = triangulateRings(points, [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tris = r.value.triangles();
    expect(tris.length).toBe(8);
    let area = 0;
    for (const [a, b, c] of tris) {
      const s = area2(points[a] as P2, points[b] as P2, points[c] as P2);
      expect(s).toBeGreaterThan(0);
      area += s / 2;
    }
    expect(area).toBeCloseTo(1 - 0.04, 12);
    const open = [...edgeUses(tris).values()].filter((n) => n === 1).length;
    expect(open).toBe(8);
  });

  it('recovers every boundary segment of 200 random star polygons with the exact polygon area', () => {
    const next = lcg(7);
    let missingInDelaunay = 0;
    for (let trial = 0; trial < 200; trial++) {
      const points = star(next, 9 + (trial % 12));
      const ring = points.map((_, i) => i);
      const r = triangulateRings(points, [ring]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const tris = r.value.triangles();
      const uses = edgeUses(tris);
      for (let i = 0; i < ring.length; i++) {
        const a = i;
        const b = (i + 1) % ring.length;
        expect(uses.get(a < b ? `${a},${b}` : `${b},${a}`)).toBe(1);
      }
      let area = 0;
      for (const [a, b, c] of tris)
        area += area2(points[a] as P2, points[b] as P2, points[c] as P2) / 2;
      expect(area).toBeCloseTo(ringArea(points, ring), 12);
      expect(tris.length).toBe(points.length - 2);
      let constrainedNeeded = false;
      const cdt = r.value;
      for (let t = 0; t < cdt.triangleCount && !constrainedNeeded; t++) {
        for (let k = 0; k < 3; k++) {
          const n = cdt.neighbour(t, k);
          if (n < 0 || !cdt.isConstrained(t, k)) continue;
          const apex = cdt.vertexOf(t, k + 2);
          const j = [0, 1, 2].find((m) => cdt.vertexOf(n, m) === cdt.vertexOf(t, k + 1)) as number;
          const opp = cdt.vertexOf(n, j + 2);
          const p = (v: number) => cdt.point(v);
          if (
            incircleCertain(p(cdt.vertexOf(t, k)), p(cdt.vertexOf(t, k + 1)), p(apex), p(opp)) > 0
          ) {
            constrainedNeeded = true;
            break;
          }
        }
      }
      if (constrainedNeeded) missingInDelaunay++;
    }
    // The family is a real test of recovery: many polygons have a segment that is not Delaunay.
    expect(missingInDelaunay).toBeGreaterThan(20);
  });

  it('leaves every unconstrained interior edge locally Delaunay', () => {
    const next = lcg(11);
    const points: P2[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (let i = 0; i < 300; i++) points.push([0.02 + 0.96 * next(), 0.02 + 0.96 * next()]);
    const r = triangulateRings(points, [[0, 1, 2, 3]]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cdt = r.value;
    let checked = 0;
    for (let t = 0; t < cdt.triangleCount; t++) {
      if (!cdt.isInside(t)) continue;
      for (let k = 0; k < 3; k++) {
        const n = cdt.neighbour(t, k);
        if (n < 0 || cdt.isConstrained(t, k) || !cdt.isInside(n)) continue;
        const a = cdt.vertexOf(t, k);
        const b = cdt.vertexOf(t, k + 1);
        const j = [0, 1, 2].find((m) => cdt.vertexOf(n, m) === b) as number;
        const opp = cdt.vertexOf(n, j + 2);
        const p = (v: number) => cdt.point(v);
        expect(incircleCertain(p(a), p(b), p(cdt.vertexOf(t, k + 2)), p(opp))).toBeLessThanOrEqual(
          0,
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    // Euler on a convex hull of 4 points: 2n - h - 2 triangles.
    expect(cdt.triangles().length).toBe(2 * points.length - 4 - 2);
  });

  it('fails closed on a duplicate point', () => {
    const r = triangulateRings(
      [
        [0, 0],
        [1, 0],
        [1, 0],
        [0, 1],
      ],
      [[0, 1, 2, 3]],
    );
    expect(r).toMatchObject({ ok: false, reason: 'duplicate-point', at: 2 });
  });

  it('fails closed on crossing rings', () => {
    const r = triangulateRings(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0.5, 0.5],
        [1.5, 0.4],
        [1.5, 0.6],
      ],
      [
        [0, 1, 2, 3],
        [4, 5, 6],
      ],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(['segments-cross', 'vertex-on-segment']).toContain(r.reason);
  });

  it('fails closed when a ring vertex lies on another segment', () => {
    const r = triangulateRings(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0.5, 0],
        [0.5, 0.5],
        [0.7, 0.5],
      ],
      [
        [0, 1, 2, 3],
        [4, 5, 6],
      ],
    );
    expect(r).toMatchObject({ ok: false, reason: 'vertex-on-segment' });
  });
});
