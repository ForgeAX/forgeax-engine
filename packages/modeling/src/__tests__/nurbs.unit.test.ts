import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type NurbsCurve, type NurbsSurface, nurbs } from '../nurbs';

const H = Math.SQRT1_2;
/** Unit circle in XY as a rational quadratic (The NURBS Book Ex. 7.2). */
const circle: NurbsCurve = {
  degree: 2,
  points: [
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [-1, 1, 0],
    [-1, 0, 0],
    [-1, -1, 0],
    [0, -1, 0],
    [1, -1, 0],
    [1, 0, 0],
  ],
  weights: [1, H, 1, H, 1, H, 1, H, 1],
  knots: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1],
};

const dist = (a: Tuple3, b: Tuple3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const samples = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

describe('NURBS curves', () => {
  it('evaluates a rational circle exactly with tangent derivatives', () => {
    expect(nurbs.check(circle).ok).toBe(true);
    for (const t of samples(37)) {
      const [p, d] = nurbs.derivatives(circle, t, 1) as [Tuple3, Tuple3];
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(1, 12);
      expect(Math.abs(p[0] * d[0] + p[1] * d[1])).toBeLessThan(1e-9);
    }
  });

  it('matches derivatives against central differences', () => {
    const curve = nurbs.interpolate([
      [0, 0, 0],
      [1, 2, 0],
      [3, 3, 1],
      [4, 1, 2],
      [6, 0, 1],
    ]);
    if (!curve.ok) throw curve.error;
    const h = 1e-5;
    for (const t of [0.13, 0.5, 0.77]) {
      const [, d1, d2] = nurbs.derivatives(curve.value, t, 2) as [Tuple3, Tuple3, Tuple3];
      const a = nurbs.point(curve.value, t - h);
      const b = nurbs.point(curve.value, t + h);
      const c = nurbs.point(curve.value, t);
      for (let k = 0; k < 3; k++) {
        expect(d1[k]).toBeCloseTo(((b[k] as number) - (a[k] as number)) / (2 * h), 4);
        expect(d2[k]).toBeCloseTo(
          ((b[k] as number) - 2 * (c[k] as number) + (a[k] as number)) / (h * h),
          1,
        );
      }
    }
  });

  it('keeps the shape through knot insertion, refinement and degree elevation', () => {
    const inserted = nurbs.insertKnot(circle, 0.3, 2);
    const refined = nurbs.refine(circle, [0.1, 0.6, 0.6]);
    const raised = nurbs.elevate(circle, 2);
    expect(raised.degree).toBe(4);
    for (const curve of [inserted, refined, raised]) {
      expect(nurbs.check(curve).ok).toBe(true);
      for (const t of samples(29)) {
        expect(dist(nurbs.point(curve, t), nurbs.point(circle, t))).toBeLessThan(1e-12);
      }
    }
    expect(inserted.points).toHaveLength(11);
  });

  it('interpolates points and approximates with fixed ends', () => {
    const points: Tuple3[] = samples(20).map((t) => [t * 4, Math.sin(t * 3), t * t]);
    const exact = nurbs.interpolate(points, { parametrization: 'chord' });
    if (!exact.ok) throw exact.error;
    expect(exact.value.points).toHaveLength(21);
    const fit = nurbs.approximate(points, { controlPoints: 8 });
    if (!fit.ok) throw fit.error;
    expect(fit.value.points[0]).toEqual(points[0]);
    expect(fit.value.points[7]).toEqual(points[20]);
    const worst = Math.max(
      ...points.map((p) =>
        Math.min(...samples(400).map((t) => dist(nurbs.point(fit.value, t), p))),
      ),
    );
    expect(worst).toBeLessThan(0.01);
  });

  it('rejects malformed input', () => {
    expect(nurbs.check({ ...circle, knots: circle.knots.slice(1) }).ok).toBe(false);
    expect(nurbs.check({ ...circle, weights: [1, -1, 1, 1, 1, 1, 1, 1, 1] }).ok).toBe(false);
    const dup = nurbs.interpolate([
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
    ]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('model-degenerate');
  });
});

describe('NURBS surfaces', () => {
  const paraboloid = (x: number, y: number): Tuple3 => [x, y, 0.5 * (x * x + y * y)];
  const grid = samples(6).map((x) => samples(6).map((y) => paraboloid(x, y)));

  it('interpolates a grid and matches partial derivatives', () => {
    const s = nurbs.grid(grid);
    if (!s.ok) throw s.error;
    expect(nurbs.checkSurface(s.value).ok).toBe(true);
    expect(dist(nurbs.surfacePoint(s.value, 0, 0), [0, 0, 0])).toBeLessThan(1e-12);
    expect(dist(nurbs.surfacePoint(s.value, 1, 1), [1, 1, 1])).toBeLessThan(1e-12);
    const h = 1e-5;
    const d = nurbs.surfaceDerivatives(s.value, 0.4, 0.6, 2);
    const su = d[1]?.[0] as Tuple3;
    const a = nurbs.surfacePoint(s.value, 0.4 - h, 0.6);
    const b = nurbs.surfacePoint(s.value, 0.4 + h, 0.6);
    for (let k = 0; k < 3; k++)
      expect(su[k]).toBeCloseTo(((b[k] as number) - (a[k] as number)) / (2 * h), 4);
  });

  it('evaluates rational surfaces (a cylinder patch from a circle)', () => {
    const rows = circle.points.map((p) => [p, [p[0], p[1], 2] as Tuple3]);
    const cylinder: NurbsSurface = {
      degreeU: 2,
      degreeV: 1,
      points: rows,
      weights: circle.weights?.map((w) => [w, w]) as number[][],
      knotsU: circle.knots,
      knotsV: [0, 0, 1, 1],
    };
    for (const u of samples(11)) {
      const [[p, sv] = [], [su] = []] = nurbs.surfaceDerivatives(cylinder, u, 0.3, 1);
      expect(Math.hypot((p as Tuple3)[0], (p as Tuple3)[1])).toBeCloseTo(1, 12);
      expect((p as Tuple3)[2]).toBeCloseTo(0.6, 12);
      for (const [k, c] of [0, 0, 2].entries()) expect((sv as Tuple3)[k]).toBeCloseTo(c, 12);
      expect(Math.abs((su as Tuple3)[2])).toBeLessThan(1e-12);
    }
  });

  it('lofts sections so every section is an isoparm', () => {
    const sections: NurbsCurve[] = [];
    for (const z of [0, 0.4, 1, 1.5]) {
      const c = nurbs.interpolate(
        samples(5).map((t) => [t, 0.3 * Math.sin(3 * t + z), z] as Tuple3),
        { degree: 3 },
      );
      if (!c.ok) throw c.error;
      sections.push(c.value);
    }
    sections[1] = nurbs.elevate(sections[1] as NurbsCurve, 1);
    const s = nurbs.loft(sections, { parameters: [0, 0.3, 0.7, 1] });
    if (!s.ok) throw s.error;
    for (const [k, v] of [0, 0.3, 0.7, 1].entries()) {
      for (const u of samples(9)) {
        expect(
          dist(nurbs.surfacePoint(s.value, u, v), nurbs.point(sections[k] as NurbsCurve, u)),
        ).toBeLessThan(1e-9);
      }
    }
  });

  it('builds a Gordon surface through a curve network', () => {
    const along = (fixed: number, dir: 'u' | 'v') =>
      nurbs.interpolate(
        samples(8).map((t) => (dir === 'u' ? paraboloid(t, fixed) : paraboloid(fixed, t))),
      );
    const uCurves = [0, 0.5, 1].map((y) => along(y, 'u'));
    const vCurves = [0, 0.3, 1].map((x) => along(x, 'v'));
    const all = [...uCurves, ...vCurves];
    for (const c of all) if (!c.ok) throw c.error;
    const unwrap = (c: (typeof all)[number]) => (c.ok ? c.value : (undefined as never));
    const s = nurbs.network(uCurves.map(unwrap), vCurves.map(unwrap));
    if (!s.ok) throw s.error;
    // Every network curve lies on the surface, and the interior follows the paraboloid.
    for (const c of [...uCurves, ...vCurves]) {
      const curve = unwrap(c);
      for (const t of samples(10)) {
        const target = nurbs.point(curve, t);
        expect(nurbs.closest(s.value, target).distance).toBeLessThan(1e-6);
      }
    }
    const mid = nurbs.surfacePoint(s.value, 0.5, 0.25);
    expect(Math.abs(mid[2] - 0.5 * (mid[0] * mid[0] + mid[1] * mid[1]))).toBeLessThan(5e-3);
    const crossing = nurbs.network(
      [unwrap(uCurves[0] as never)].concat(unwrap(uCurves[1] as never)),
      [
        nurbs.interpolate([
          [5, 5, 5],
          [6, 6, 6],
        ]).ok
          ? (
              nurbs.interpolate([
                [5, 5, 5],
                [6, 6, 6],
              ]) as { value: NurbsCurve }
            ).value
          : (undefined as never),
        unwrap(vCurves[0] as never),
      ],
    );
    expect(crossing.ok).toBe(false);
    if (!crossing.ok) expect(crossing.error.code).toBe('model-precondition');
  });
});
