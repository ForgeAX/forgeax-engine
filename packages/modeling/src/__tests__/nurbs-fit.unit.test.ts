import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type NurbsCurve, type NurbsSurface, nurbs } from '../nurbs';
import { checkSurfaceQuality, curveFairness, isoparm } from '../surface-quality';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

const dist = (a: Tuple3, b: Tuple3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A gently curved panel 1.2 m x 0.5 m, like a door skin. */
const panel = (s: number, t: number): Tuple3 => [
  1.2 * s,
  0.5 * t,
  0.06 * Math.sin(Math.PI * s) + 0.03 * t * t - 0.01 * s * t,
];

/** Deterministic trace noise, as in C-114's wrong body. */
const noise = (i: number, j: number) => Math.sin(i * 2.3 + j * 1.7) * Math.cos(i * 0.7 - j * 2.9);

function grid(nx: number, ny: number, amplitude = 0): Tuple3[][] {
  return Array.from({ length: nx }, (_, i) =>
    Array.from({ length: ny }, (_, j): Tuple3 => {
      const p = panel(i / (nx - 1), j / (ny - 1));
      return [p[0], p[1], p[2] + amplitude * noise(i, j)];
    }),
  );
}

/** Worst isoparm rate ratio over 5 interior isoparms per direction (the surface-fairness measure). */
function roughness(s: NurbsSurface): number {
  let worst = 0;
  for (const along of ['u', 'v'] as const)
    for (let k = 1; k <= 5; k++) {
      const f = unwrap(curveFairness({ name: 'iso', curve: isoparm(s, along, k / 6) }));
      worst = Math.max(worst, f.rateRatio);
    }
  return worst;
}

describe('nurbs.fitSurface', () => {
  it('fits a noisy dense grid with a small net, smoother than interpolation', () => {
    const rows = grid(24, 18, 0.0004);
    const fit = unwrap(nurbs.fitSurface(rows, { degree: [5, 5], net: [8, 6] }));
    expect(fit.net).toEqual([8, 6]);
    expect(fit.surface.points).toHaveLength(8);
    // The fit stays within the noise amplitude of the points.
    expect(fit.max).toBeLessThan(0.0012);
    expect(fit.rms).toBeLessThan(0.0005);
    const clean = unwrap(nurbs.fitSurface(grid(24, 18), { degree: [5, 5], net: [8, 6] }));
    expect(roughness(fit.surface)).toBeLessThanOrEqual(2 * Math.max(roughness(clean.surface), 1));
    const dense = unwrap(nurbs.grid(rows));
    expect(roughness(dense)).toBeGreaterThan(4 * roughness(fit.surface));
  });

  it('falsifier: no fairing and a net of the grid size degenerates to interpolation', () => {
    const rows = grid(10, 7, 0.0004);
    const fit = unwrap(nurbs.fitSurface(rows, { degree: [3, 3], net: [10, 7] }));
    expect(fit.max).toBeLessThan(1e-9);
    const report = unwrap(
      checkSurfaceQuality(
        { surfaces: [{ name: 'fit', surface: fit.surface }] },
        { maxNet: [8, 6] },
      ),
    );
    expect(report.issues.map((i) => i.code)).toContain('surface-density');
    expect(report.issues.map((i) => i.code)).toContain('surface-fairness');
  });

  it('fairing reduces the bending of a sparse fit monotonically and costs accuracy', () => {
    const rows = grid(16, 12, 0.0004);
    const bend = (s: NurbsSurface) => {
      let sum = 0;
      for (let i = 0; i <= 20; i++)
        for (let j = 0; j <= 20; j++) {
          const d = nurbs.surfaceDerivatives(s, i / 20, j / 20, 2);
          for (const [a, b] of [
            [2, 0],
            [1, 1],
            [0, 2],
          ] as const) {
            const x = (d[a] as Tuple3[])[b] as Tuple3;
            sum += x[0] * x[0] + x[1] * x[1] + x[2] * x[2];
          }
        }
      return sum;
    };
    const results = [0, 1e-6, 1e-4].map((w) =>
      unwrap(nurbs.fitSurface(rows, { degree: [5, 5], net: [8, 8], fair: { bend: w } })),
    );
    const bends = results.map((r) => bend(r.surface));
    expect(bends[1]).toBeLessThan(bends[0] as number);
    expect(bends[2]).toBeLessThan(bends[1] as number);
    expect((results[2] as { rms: number }).rms).toBeGreaterThan(
      (results[0] as { rms: number }).rms,
    );
    for (const w of [{ stretch: 1e-5 }, { rate: 1e-7 }])
      expect(
        unwrap(nurbs.fitSurface(rows, { degree: [5, 5], net: [8, 8], fair: w })).rms,
      ).toBeLessThan(0.002);
  });

  it('keeps fixed boundary curves exactly', () => {
    const rows = grid(16, 12, 0.0004);
    // u0 runs along v at s = 0; v1 runs along u at t = 1.
    const u0 = unwrap(
      nurbs.approximate(
        Array.from({ length: 9 }, (_, k) => panel(0, k / 8)),
        { controlPoints: 5, degree: 4 },
      ),
    );
    const v1 = unwrap(
      nurbs.approximate(
        Array.from({ length: 9 }, (_, k) => panel(k / 8, 1)),
        { controlPoints: 6, degree: 5 },
      ),
    );
    // The two meet at the corner (s, t) = (0, 1): both pass the end points exactly.
    for (const net of [[8, 6], 'auto'] as const) {
      const fit = unwrap(
        nurbs.fitSurface(rows, {
          degree: [5, 5],
          net,
          maxError: 0.002,
          boundaries: { u0, v1 },
        }),
      );
      for (let k = 0; k <= 64; k++) {
        const f = k / 64;
        const [[a0, a1], [b0, b1]] = nurbs.surfaceDomain(fit.surface);
        const [c0, c1] = nurbs.domain(u0);
        const [d0, d1] = nurbs.domain(v1);
        expect(
          dist(
            nurbs.surfacePoint(fit.surface, a0, b0 + (b1 - b0) * f),
            nurbs.point(u0, c0 + (c1 - c0) * f),
          ),
        ).toBeLessThan(1e-9);
        expect(
          dist(
            nurbs.surfacePoint(fit.surface, a0 + (a1 - a0) * f, b1),
            nurbs.point(v1, d0 + (d1 - d0) * f),
          ),
        ).toBeLessThan(1e-9);
      }
    }
  });

  it("'auto' starts with one span and adds spans until maxError holds", () => {
    const rows = grid(30, 20);
    const coarse = unwrap(nurbs.fitSurface(rows, { degree: [3, 3], net: 'auto', maxError: 0.01 }));
    expect(coarse.net).toEqual([4, 4]);
    expect(coarse.converged).toBe(true);
    const fine = unwrap(
      nurbs.fitSurface(rows, { degree: [3, 3], net: 'auto', maxError: 1e-5, maxNet: [12, 12] }),
    );
    expect(fine.max).toBeLessThanOrEqual(1e-5);
    expect(fine.net[0]).toBeGreaterThan(4);
    const capped = unwrap(
      nurbs.fitSurface(grid(30, 20, 0.001), { degree: [3, 3], net: 'auto', maxError: 1e-6 }),
    );
    expect(capped.converged).toBe(false);
    expect(capped.net).toEqual([8, 8]);
  });

  it('rejects malformed input with structured errors', () => {
    const rows = grid(6, 5);
    const codes = [
      nurbs.fitSurface([[[0, 0, 0]]], { net: [2, 2] }),
      nurbs.fitSurface(rows, { net: [9, 4] }),
      nurbs.fitSurface(rows, { net: 'auto' }),
      nurbs.fitSurface(rows, { net: [4, 4], fair: { bend: -1 } }),
      nurbs.fitSurface(rows, { net: [4, 4], degree: [0, 3] }),
    ].map((r) => (r.ok ? 'ok' : r.error.code));
    expect(codes).toEqual(new Array(5).fill('model-invalid-argument'));
    const wiggly: NurbsCurve = unwrap(
      nurbs.interpolate(
        Array.from({ length: 7 }, (_, k) => panel(0, k / 6)),
        { degree: 3 },
      ),
    );
    const r = nurbs.fitSurface(rows, { degree: [3, 3], net: [4, 4], boundaries: { u0: wiggly } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-precondition');
  });
});
