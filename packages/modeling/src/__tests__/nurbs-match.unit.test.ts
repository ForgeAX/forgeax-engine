import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type NurbsSurface, nurbs } from '../nurbs';
import { checkSurfaceQuality, measureEdge } from '../surface-quality';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

const bezier = (n: number) => [
  ...new Array<number>(n + 1).fill(0),
  ...new Array<number>(n + 1).fill(1),
];

/** Master patch b on x in [0, 1]: bicubic Bezier, curved both ways. */
const b: NurbsSurface = {
  degreeU: 3,
  degreeV: 3,
  points: Array.from({ length: 4 }, (_, i) =>
    Array.from(
      { length: 4 },
      (_, j): Tuple3 => [
        i / 3,
        j / 3,
        0.08 * Math.sin(i * 0.9 + 0.3) + 0.03 * j * j * 0.1 - 0.02 * i * j * 0.1,
      ],
    ),
  ),
  knotsU: bezier(3),
  knotsV: bezier(3),
};

/** Patch a on x in [1.02, 2.02] with its own shape: a gap and a kink at the edge. */
function patchA(rows = 6, degreeV = 3, columns = 4): NurbsSurface {
  const p = rows - 1;
  return {
    degreeU: p,
    degreeV,
    points: Array.from({ length: rows }, (_, i) =>
      Array.from(
        { length: columns },
        (_, j): Tuple3 => [
          1.02 + i / p,
          j / (columns - 1),
          0.05 + 0.04 * Math.cos(i * 0.7) - (0.01 * j) / (columns - 1),
        ],
      ),
    ),
    knotsU: bezier(p),
    knotsV:
      degreeV + 1 === columns
        ? bezier(degreeV)
        : [
            ...new Array<number>(degreeV + 1).fill(0),
            ...Array.from(
              { length: columns - degreeV - 1 },
              (_, k) => (k + 1) / (columns - degreeV),
            ),
            ...new Array<number>(degreeV + 1).fill(1),
          ],
  };
}

/** Surface-quality limits: 0.01 mm, 0.1 degree, 2 %. */
const D09 = { gap: 1e-5, angle: 0.1, curvature: 0.02 };

describe('nurbs.match', () => {
  it('starts from an edge that fails G0 (the test is not vacuous)', () => {
    const before = unwrap(measureEdge(patchA(), 'u0', b, 'u1'));
    expect(before.gap).toBeGreaterThan(0.01);
    expect(before.angle).toBeGreaterThan(1);
  });

  for (const level of ['G0', 'G1', 'G2', 'G3'] as const) {
    it(`matches ${level} to the surface-quality tolerances and changes only ${level} + 1 rows`, () => {
      const a = patchA();
      const out = unwrap(nurbs.match(a, 'u0', b, 'u1', { level }));
      const k = Number(level[1]);
      expect(out.rows).toBe(k + 1);
      expect(out.residual.gap).toBeLessThanOrEqual(D09.gap);
      if (k >= 1) expect(out.residual.angle).toBeLessThanOrEqual(D09.angle);
      if (k >= 2) expect(out.residual.curvatureRatio).toBeLessThanOrEqual(D09.curvature);
      if (k >= 3) expect(out.residual.rateRatio).toBeLessThanOrEqual(0.05);
      // Rows beyond the level are bitwise unchanged; the edge rows did move.
      for (const [i, row] of out.a.points.entries()) {
        if (i > k) expect(row).toEqual(a.points[i]);
        else expect(row).not.toEqual(a.points[i]);
      }
      expect(out.b).toBe(b);
    });
  }

  it('G2 is also what checkSurfaceQuality measures at the surface-quality tolerances', () => {
    const out = unwrap(nurbs.match(patchA(), 'u0', b, 'u1', { level: 'G2' }));
    const report = unwrap(
      checkSurfaceQuality(
        {
          surfaces: [
            { name: 'a', surface: out.a },
            { name: 'b', surface: b },
          ],
        },
        { position: D09.gap, angle: D09.angle, continuity: 'G2', isoparms: 0 },
      ),
    );
    const edge = report.edges.find((e) => e.a === 'a' && e.b === 'b');
    expect(edge?.achieved).toBe('G2');
  });

  it('falsifier: G2 on both sides of a 3-row net is a precondition with a hint', () => {
    const thin = patchA(3);
    const both = nurbs.match(thin, 'u0', b, 'u1', { level: 'G2', opposite: 'G2' });
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.error.code).toBe('model-precondition');
      expect(both.error.hint).toMatch(/insertKnot|elevate/);
    }
    // Even keeping only the opposite edge in place leaves no free row for G2.
    expect(nurbs.match(thin, 'u0', b, 'u1', { level: 'G2' }).ok).toBe(false);
    // Letting the opposite edge move is allowed, and so is adding a span first.
    expect(nurbs.match(thin, 'u0', b, 'u1', { level: 'G2', opposite: 'none' }).ok).toBe(true);
    const split = unwrap(nurbs.surface.refine(thin, 'u', [0.3, 0.5, 0.7]));
    expect(split.points).toHaveLength(6);
    const ok = unwrap(nurbs.match(split, 'u0', b, 'u1', { level: 'G2', opposite: 'G2' }));
    expect(ok.residual.curvatureRatio).toBeLessThanOrEqual(D09.curvature);
  });

  it('makes the edge compatible first: other degree, knots, side and direction', () => {
    // A quartic 6-column net whose v runs against b's, presented with the edge as side v0.
    const raw = patchA(6, 4, 6);
    const reversedV: NurbsSurface = {
      ...raw,
      points: raw.points.map((row) => [...row].reverse()),
      knotsV: raw.knotsV.map((t) => 1 - t).reverse(),
    };
    const a = nurbs.transpose(reversedV);
    const before = unwrap(measureEdge(a, 'v0', b, 'u1'));
    expect(before.gap).toBeGreaterThan(0.01);
    const out = unwrap(nurbs.match(a, 'v0', b, 'u1', { level: 'G2' }));
    expect(out.residual.gap).toBeLessThanOrEqual(D09.gap);
    expect(out.residual.angle).toBeLessThanOrEqual(D09.angle);
    expect(out.residual.curvatureRatio).toBeLessThanOrEqual(D09.curvature);
    // Compatibility raised a's along-edge degree to b's and kept its own knots too.
    expect(out.a.degreeU).toBe(4);
    expect(out.a.points.length).toBeGreaterThanOrEqual(6);
  });

  it("'both' moves both patches to a shared edge between them", () => {
    const a = patchA();
    const out = unwrap(nurbs.match(a, 'u0', b, 'u1', { level: 'G2', modify: 'both' }));
    expect(out.residual.gap).toBeLessThanOrEqual(D09.gap);
    expect(out.residual.angle).toBeLessThanOrEqual(D09.angle);
    expect(out.residual.curvatureRatio).toBeLessThanOrEqual(D09.curvature);
    const edgeX = (s: NurbsSurface, i: number) => ((s.points[i] as Tuple3[])[1] as Tuple3)[0];
    expect(edgeX(out.a, 0)).toBeGreaterThan(1);
    expect(edgeX(out.a, 0)).toBeLessThan(1.02);
    expect(out.b.points[3]).not.toEqual(b.points[3]);
    expect(out.b.points[0]).toEqual(b.points[0]);
  });

  it('lockPosition keeps the edge row; influence spreads the change behind the matched rows', () => {
    const a = patchA();
    const touching = unwrap(nurbs.match(a, 'u0', b, 'u1', { level: 'G0' })).a;
    const locked = unwrap(
      nurbs.match(touching, 'u0', b, 'u1', { level: 'G2', lockPosition: true }),
    );
    expect(locked.a.points[0]).toEqual(touching.points[0]);
    expect(locked.rows).toBe(2);
    expect(locked.residual.angle).toBeLessThanOrEqual(D09.angle);
    const spread = unwrap(nurbs.match(a, 'u0', b, 'u1', { level: 'G1', influence: 1 }));
    expect(spread.a.points[2]).not.toEqual(a.points[2]);
    expect(spread.a.points[5]).toEqual(a.points[5]);
    expect(spread.residual.angle).toBeLessThanOrEqual(D09.angle);
  });

  it('rejects rational patches, folded patches and bad options', () => {
    const a = patchA();
    const rational = { ...a, weights: a.points.map((r) => r.map(() => 1.5)) };
    const r1 = nurbs.match(
      { ...rational, weights: rational.weights.map((r, i) => r.map((w) => (i === 2 ? 2 : w))) },
      'u0',
      b,
      'u1',
      { level: 'G1' },
    );
    expect(r1.ok ? '' : r1.error.code).toBe('model-precondition');
    // b's own u0 side faces away from a: matching a's u0 there folds a back over b.
    const folded = nurbs.match(a, 'u0', b, 'u0', { level: 'G1' });
    expect(folded.ok ? '' : folded.error.code).toBe('model-precondition');
    const bad = nurbs.match(a, 'u0', b, 'u1', { level: 'G4' as never });
    expect(bad.ok ? '' : bad.error.code).toBe('model-invalid-argument');
  });
});
