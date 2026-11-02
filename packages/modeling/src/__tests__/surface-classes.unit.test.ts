import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';
import { checkSurfaceQuality, D09_CLASSES } from '../surface-quality';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

const bezier = (n: number) => [
  ...new Array<number>(n + 1).fill(0),
  ...new Array<number>(n + 1).fill(1),
];

/** A flat quintic patch over [x0, x1] x [0, 1], tilted about y by `tilt` degrees from x = x0. */
function plate(x0: number, x1: number, tilt = 0, bend = 0): NurbsSurface {
  const a = (tilt * Math.PI) / 180;
  return {
    degreeU: 5,
    degreeV: 3,
    points: Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 4 }, (_, j): Tuple3 => {
        const d = ((x1 - x0) * i) / 5;
        return [x0 + d * Math.cos(a), j / 3, d * Math.sin(a) + bend * d * d];
      }),
    ),
    knotsU: bezier(5),
    knotsV: bezier(3),
  };
}

describe('continuity classes and G3', () => {
  it('falsifier: a 0.3 degree kink fails as a primary edge and passes the old 0.5 degree default', () => {
    const surfaces = [
      { name: 'a', surface: plate(0, 1) },
      { name: 'b', surface: plate(1, 2, 0.3) },
    ];
    const old = unwrap(checkSurfaceQuality({ surfaces }, { isoparms: 0 }));
    expect(old.pass).toBe(true);
    expect(old.edges[0]?.class).toBe('primary');
    const d09 = unwrap(checkSurfaceQuality({ surfaces }, { isoparms: 0, classes: D09_CLASSES }));
    expect(d09.pass).toBe(false);
    expect(d09.edges[0]?.achieved).toBe('G0');
    expect(d09.issues.map((i) => i.code)).toEqual(['surface-continuity']);
  });

  it('judges an edge of a transition patch by the blend class', () => {
    const surfaces = [
      { name: 'a', surface: plate(0, 1) },
      {
        name: 'b',
        surface: plate(1, 2, 0.3),
        transition: { kind: 'blend' as const, continuity: 'G1' as const },
      },
    ];
    const r = unwrap(
      checkSurfaceQuality(
        { surfaces },
        { isoparms: 0, classes: { primary: { angle: 0.01 }, blend: { angle: 1 } } },
      ),
    );
    expect(r.edges[0]?.class).toBe('blend');
    expect(r.pass).toBe(true);
    const strict = unwrap(
      checkSurfaceQuality(
        { surfaces: surfaces.map(({ transition: _, ...s }) => s) },
        { isoparms: 0, classes: { primary: { angle: 0.01 } } },
      ),
    );
    expect(strict.pass).toBe(false);
  });

  it('G3: a G2 match is not G3, a G3 match is', () => {
    const b = plate(0, 1, 0, 0.08);
    const a = {
      ...plate(1.02, 2.02, 4, -0.05),
      points: plate(1.02, 2.02, 4, -0.05).points.map((r, i) =>
        r.map((p): Tuple3 => [p[0], p[1], p[2] + 0.02 * Math.sin(i)]),
      ),
    };
    const g2 = unwrap(nurbs.match(a, 'u0', b, 'u1', { level: 'G2' })).a;
    const g3 = unwrap(nurbs.match(a, 'u0', b, 'u1', { level: 'G3' })).a;
    const report = (s: NurbsSurface) =>
      unwrap(
        checkSurfaceQuality(
          {
            surfaces: [
              { name: 'b', surface: b },
              { name: 'a', surface: s },
            ],
          },
          { isoparms: 0, continuity: 'G3', classes: D09_CLASSES },
        ),
      );
    expect(report(g2).edges[0]?.achieved).toBe('G2');
    expect(report(g2).pass).toBe(false);
    expect(report(g3).edges[0]?.achieved).toBe('G3');
    expect(report(g3).pass).toBe(true);
  });

  it('samples a trim edge against the patch beside it (class trim)', () => {
    // A plate over x in [0, 2] trimmed to x <= 1, and a second plate from x = 1 tilted 0.3 degrees.
    const m = model();
    m.surface({
      patches: [
        {
          name: 'base',
          surface: plate(0, 2),
          trims: [
            {
              uv: [
                [0.5, -0.1],
                [1.1, -0.1],
                [1.1, 1.1],
                [0.5, 1.1],
              ],
            },
          ],
        },
        { name: 'wing', surface: plate(1, 2, 0.3) },
      ],
      chord: 0.002,
    });
    expect(m.poisoned).toBeUndefined();
    const base = m.diagnostics().surfaces.find((s) => s.name === 'base');
    expect(base?.trims?.length).toBe(1);
    const old = unwrap(
      checkSurfaceQuality({ surfaces: m.diagnostics().surfaces }, { isoparms: 0 }),
    );
    const trim = old.edges.filter((e) => e.sideA === 'trim');
    expect(trim.map((e) => [e.a, e.b, e.sideB, e.class])).toEqual([['base', 'wing', 'u0', 'trim']]);
    expect(trim[0]?.angle.value).toBeGreaterThan(0.25);
    expect(trim[0]?.angle.value).toBeLessThan(0.35);
    expect(old.pass).toBe(true);
    const d09 = unwrap(
      checkSurfaceQuality(
        { surfaces: m.diagnostics().surfaces },
        { isoparms: 0, classes: D09_CLASSES },
      ),
    );
    expect(d09.issues.map((i) => i.detail.subject)).toEqual(['base:trim0|wing:u0']);
    // Without the trim record the edge is invisible: no side of base runs beside wing's u0.
    const blind = unwrap(
      checkSurfaceQuality(
        { surfaces: m.diagnostics().surfaces.map(({ trims: _t, ...s }) => s) },
        { isoparms: 0, classes: D09_CLASSES },
      ),
    );
    expect(blind.edges.filter((e) => e.b === 'wing' && e.sideB === 'u0')).toEqual([]);
  });

  it('rejects malformed classes and rate', () => {
    const surfaces = [{ name: 'a', surface: plate(0, 1) }];
    for (const options of [
      { rate: 0 },
      { classes: { hero: {} } as never },
      { classes: { primary: { angle: -1 } } },
    ]) {
      const r = checkSurfaceQuality({ surfaces }, options);
      expect(r.ok ? '' : r.error.code).toBe('model-invalid-argument');
    }
  });
});
