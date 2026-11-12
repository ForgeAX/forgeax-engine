import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { type NurbsSurface, nurbs, surfaceDomain, surfacePoint } from '../nurbs';
import { fitSurface } from '../nurbs-fit';

/**
 * Layout falsifiers:
 * each case was silent before the fix.
 */
const grid = (f: (s: number, t: number) => Tuple3, n = 17, m = 17): Tuple3[][] =>
  Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => f(i / (n - 1), j / (m - 1))),
  );

function fit(
  points: Tuple3[][],
  net: [number, number] = [6, 6],
  degree: [number, number] = [5, 5],
): NurbsSurface {
  const r = fitSurface(points, { net, degree });
  if (!r.ok) throw r.error;
  return r.value.surface;
}

const free = {
  u0: { free: true },
  u1: { free: true },
  v0: { free: true },
  v1: { free: true },
} as const;

function checks(m: ReturnType<typeof model>): string[] {
  return m
    .validate({ layout: true })
    .issues.filter((i) => i.code === 'patch-layout')
    .map((i) => `${i.detail.check}@${i.detail.subject}`);
}

describe('B13 audit falsifiers', () => {
  it('A1: a fit that leaves its points (crown flattened, auto not converged, stretch) is reported', () => {
    const crown = 0.02;
    const pts = grid(
      (s, t) => [
        s,
        t * 0.6,
        crown * (1 - (2 * s - 1) ** 2) * (1 - (2 * t - 1) ** 2) +
          0.0002 * Math.sin(17 * s + 11 * t),
      ],
      17,
      13,
    );
    const build = (fitSpec: object) => {
      const m = model();
      m.patchLayout({
        name: 'c',
        patches: [
          {
            id: 'D',
            role: 'primary',
            degree: [5, 5],
            net: [6, 6],
            fit: { points: pts, ...fitSpec },
            sides: free,
          },
        ],
      });
      m.surface({ layout: 'c', chord: 0.003 });
      expect(m.poisoned).toBeUndefined();
      return checks(m);
    };
    // Unfaired, the fit stays within 0.23 mm; rate 1e-6 already leaves 1.3 mm on this crown.
    expect(build({})).toEqual([]);
    expect(build({ fair: { rate: 1e-6 } })).toContain('layout-fit@D');
    expect(build({ fair: { bend: 1 } })).toContain('layout-fit@D');
    expect(build({ fair: { stretch: 1 } })).toContain('layout-fit@D');
    const auto = model();
    auto.patchLayout({
      name: 'a',
      patches: [
        {
          id: 'D',
          role: 'primary',
          degree: [3, 3],
          fit: { points: pts, maxError: 1e-5, maxNet: [4, 4] },
          sides: free,
        },
      ],
    });
    auto.surface({ layout: 'a', chord: 0.003 });
    expect(checks(auto)).toContain('layout-fit@D');
    // The residuals are in the surface op's journal.
    const entry = auto.inspect().journal.find((e) => e.op === 'surface');
    expect(JSON.stringify(entry?.diagnostics)).toContain('"converged":false');
  });

  it('A1: under fixed boundaries a bend fairing that flattens a 15 mm crown is reported', () => {
    const crown = 0.015;
    const f = (s: number, t: number): Tuple3 => [
      s,
      0.6 * t,
      crown * (1 - 0.5 * ((2 * s - 1) ** 2 + (2 * t - 1) ** 2)),
    ];
    const pts = grid(
      (s, t) => {
        const p = f(s, t);
        return [p[0], p[1], p[2] + 0.0002 * Math.sin(17 * s + 11 * t)];
      },
      17,
      13,
    );
    const params = Array.from({ length: 17 }, (_, k) => k / 16);
    const edge = (g: (x: number) => Tuple3) => {
      const r = nurbs.approximate(params.map(g), {
        controlPoints: 3,
        degree: 2,
        parameters: params,
      });
      if (!r.ok) throw r.error;
      return r.value;
    };
    const boundaries = {
      u0: edge((x) => f(0, x)),
      u1: edge((x) => f(1, x)),
      v0: edge((x) => f(x, 0)),
      v1: edge((x) => f(x, 1)),
    };
    const build = (fair: object) => {
      const m = model();
      m.patchLayout({
        name: 'd',
        patches: [
          {
            id: 'D',
            role: 'primary',
            degree: [5, 5],
            net: [6, 6],
            fit: { points: pts, fair, boundaries },
            sides: free,
          },
        ],
      });
      m.surface({ layout: 'd', chord: 0.003 });
      return checks(m);
    };
    expect(build({ rate: 1e-6 })).toEqual([]);
    expect(build({ bend: 1e-2 })).toContain('layout-fit@D');
  });

  it('A2: a feature line only partly on its side, or a side 0.9 mm off it, is reported', () => {
    const line = {
      degree: 1,
      points: [
        [0, 0.2, 0],
        [1.6, 0.2, 0],
      ] as Tuple3[],
      knots: [0, 0, 1, 1],
    };
    const build = (x1: number, dz: number) => {
      const m = model();
      m.featureLine({ name: 'f', curve: line });
      const low = fit(
        grid((s, t) => [s * x1, t * 0.2, t === 1 ? dz : 0]),
        [4, 4],
        [3, 3],
      );
      const up = fit(
        grid((s, t) => [s * 1.6, 0.2 + t * 0.2, 0]),
        [4, 4],
        [3, 3],
      );
      m.patchLayout({
        name: 'f',
        featureLines: ['f'],
        patches: [
          { id: 'L', role: 'primary', surface: low, sides: { ...free, v1: { feature: 'f' } } },
          { id: 'U', role: 'primary', surface: up, sides: free },
        ],
      });
      m.surface({ layout: 'f', chord: 0.003 });
      return checks(m);
    };
    expect(build(1.6, 0)).toEqual([]);
    expect(build(0.32, 0)).toEqual(['layout-feature-unplaced@f']);
    expect(build(1.6, 0.0009)).toContain('layout-feature-unplaced@f');
  });

  it('A3: a G2 boundary grazing the bands 15 to 45 degrees is reported; along (< 10) or across (> 60) passes', () => {
    const R = 0.5;
    const cyl = (x: number, a: number): Tuple3 => [x, R * Math.sin(a / R), R * Math.cos(a / R)];
    const flagged = (deg: number) => {
      const th = (deg * Math.PI) / 180;
      const d: [number, number] = [Math.cos(th), Math.sin(th)];
      const c: [number, number] = deg < 45 ? [0, 1] : [1, 0];
      const patch = (t0: number) =>
        grid((s, t) => {
          const ss = s * 0.8;
          const tt = (t0 + t) * 0.3;
          return cyl(ss * d[0] + tt * c[0], ss * d[1] + tt * c[1]);
        });
      const m = model();
      m.patchLayout({
        name: 'h',
        patches: [
          {
            id: 'A',
            role: 'primary',
            surface: fit(patch(-1)),
            sides: { u0: { free: true }, u1: { free: true }, v0: { free: true } },
          },
          {
            id: 'B',
            role: 'primary',
            surface: fit(patch(0)),
            sides: {
              v0: { to: 'A:v1', continuity: 'G2' },
              u0: { free: true },
              u1: { free: true },
              v1: { free: true },
            },
          },
        ],
      });
      m.surface({ layout: 'h', chord: 0.003 });
      return checks(m).some((c2) => c2.startsWith('layout-highlight'));
    };
    expect([0, 5, 15, 20, 30, 45, 75, 90].map((deg) => [deg, flagged(deg)])).toEqual([
      [0, false],
      [5, false],
      [15, true],
      [20, true],
      [30, true],
      [45, true],
      [75, false],
      [90, false],
    ]);
  });

  it('A4: a wedge (short side) or a 12 degree corner on a primary is reported', () => {
    const corner = (variant: string) => {
      const pts = grid((s, t) => {
        if (variant === 'angle-12deg') {
          // A bilinear quad whose sides from the origin meet at 12 degrees.
          const a = (12 * Math.PI) / 180;
          const c10: Tuple3 = [0.6, 0, 0];
          const c01: Tuple3 = [0.6 * Math.cos(a), 0.6 * Math.sin(a), 0];
          const c11: Tuple3 = [1, 0.3, 0.02];
          return [0, 1, 2].map(
            (k) =>
              (1 - s) * t * (c01[k] as number) +
              s * (1 - t) * (c10[k] as number) +
              s * t * (c11[k] as number),
          ) as Tuple3;
        }
        const w0 = variant === 'short-1mm' ? 0.001 : variant === 'short-5mm' ? 0.005 : 0.4;
        const w = w0 + (0.4 - w0) * s;
        return [s * 0.6, (t - 0.5) * w, 0.03 * (1 - ((t - 0.5) * 2) ** 2) * s];
      });
      const m = model();
      m.patchLayout({
        name: 'd',
        patches: [{ id: 'P', role: 'primary', surface: fit(pts), sides: free }],
      });
      m.surface({ layout: 'd', chord: 0.003 });
      return checks(m);
    };
    expect(corner('square')).toEqual([]);
    for (const v of ['short-1mm', 'short-5mm'])
      expect(corner(v)).toContain('layout-degenerate-corner@P');
    expect(corner('angle-12deg')).toContain('layout-degenerate-corner@P');
  });

  it('A6: an unbuilt layout, or a patch without geometry, is reported', () => {
    const m = model();
    m.patchLayout({
      name: 'v',
      patches: [
        { id: 'A', role: 'primary', net: [6, 6], sides: { v1: { to: 'B:v0', continuity: 'G2' } } },
        { id: 'B', role: 'primary', net: [6, 6] },
      ],
    });
    expect(checks(m)).toEqual(['layout-unbuilt@v']);
    const half = model();
    half.patchLayout({
      name: 'h',
      patches: [
        { id: 'A', role: 'primary', surface: fit(grid((s, t) => [s, t, 0])), sides: free },
        { id: 'B', role: 'primary', net: [6, 6] },
      ],
    });
    half.surface({ layout: 'h', chord: 0.003 });
    expect(checks(half)).toEqual(['layout-unbuilt@B']);
  });

  it('A7: surface algebra keeps the shape on unclamped knots, also at the domain end', () => {
    const p = 3;
    const nu = 7;
    const knotsU = Array.from({ length: nu + p + 1 }, (_, k) => k / (nu + p));
    const s: NurbsSurface = {
      degreeU: p,
      degreeV: 3,
      points: Array.from({ length: nu }, (_, i) =>
        Array.from(
          { length: 4 },
          (_, j): Tuple3 => [i * 0.2, j * 0.2, 0.05 * Math.sin(1.7 * i + j)],
        ),
      ),
      knotsU,
      knotsV: [0, 0, 0, 0, 1, 1, 1, 1],
    };
    const [[a, b]] = surfaceDomain(s);
    const dev = (x: NurbsSurface, from = a, to = b) => {
      let worst = 0;
      for (let k = 0; k <= 64; k++) {
        const u = from + ((to - from) * k) / 64;
        for (const v of [0, 0.37, 1]) {
          const P = surfacePoint(s, u, v);
          const Q = surfacePoint(x, u, v);
          worst = Math.max(worst, Math.hypot(P[0] - Q[0], P[1] - Q[1], P[2] - Q[2]));
        }
      }
      return worst;
    };
    const elevated = nurbs.surface.elevate(s, 'u', 1);
    if (!elevated.ok) throw elevated.error;
    expect(dev(elevated.value)).toBeLessThan(1e-12);
    const split = nurbs.surface.split(s, 'u', 0.5);
    if (!split.ok) throw split.error;
    expect(dev(split.value[0], a, 0.5)).toBeLessThan(1e-12);
    expect(dev(split.value[1], 0.5, b)).toBeLessThan(1e-12);
    const extended = nurbs.surface.extend(s, 'u1', 0.1);
    if (!extended.ok) throw extended.error;
    expect(dev(extended.value)).toBeLessThan(1e-9);
    const curve = { degree: 3, points: s.points.map((row) => row[1] as Tuple3), knots: knotsU };
    const up = nurbs.elevate(curve, 1);
    const norm = nurbs.normalize(curve);
    const [c0, c1] = nurbs.domain(curve);
    for (let k = 0; k <= 64; k++) {
      const t = c0 + ((c1 - c0) * k) / 64;
      const P = nurbs.point(curve, t);
      const Q = nurbs.point(up, t);
      const R2 = nurbs.point(norm, k / 64);
      expect(Math.hypot(P[0] - Q[0], P[1] - Q[1], P[2] - Q[2])).toBeLessThan(1e-12);
      expect(Math.hypot(P[0] - R2[0], P[1] - R2[1], P[2] - R2[2])).toBeLessThan(1e-12);
    }
  });
});
