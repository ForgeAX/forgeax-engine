import { describe, expect, it } from 'vitest';
import { cross, sub, type Tuple3 } from '../geom';
import { type HighlightOptions, highlightLines } from '../highlight-lines';
import { curvePoint, interpolateGrid, type NurbsSurface } from '../nurbs';
import {
  checkSurfaceQuality,
  type FeatureLine,
  isoparm,
  type NamedSurface,
} from '../surface-quality';
import { buildRight, buildWrong } from './fixtures/quality-body';

/** Surface through samples of `f` on an nu x nv grid of normalized coordinates. */
function grid(nu: number, nv: number, f: (s: number, t: number) => Tuple3): NurbsSurface {
  const fit = interpolateGrid(
    Array.from({ length: nu }, (_, i) =>
      Array.from({ length: nv }, (_, j) => f(i / (nu - 1), j / (nv - 1))),
    ),
  );
  if (!fit.ok) throw fit.error;
  return fit.value;
}

function highlights(
  surfaces: readonly NamedSurface[],
  options: HighlightOptions,
  curves: readonly FeatureLine[] = [],
) {
  const report = checkSurfaceQuality({ surfaces, curves }, { highlights: options, isoparms: 0 });
  if (!report.ok) throw report.error;
  return report.value.issues.filter((i) => i.code === 'highlight' || i.code === 'nothing-checked');
}

function lineCount(surfaces: readonly NamedSurface[], options: HighlightOptions): number {
  const lines = highlightLines(
    surfaces.map((s) => s.surface),
    options,
  );
  if (!lines.ok) throw lines.error;
  return lines.value.lines.length;
}

/** The C-114 case camera direction, 2.5 m from the body's middle. */
const target: Tuple3 = [0.6, 0.31, 0.25];
const toward: Tuple3 = [-0.5, 0.5, 0.71];
const far = 2.5 / Math.sqrt(toward[0] * toward[0] + toward[1] * toward[1] + toward[2] * toward[2]);
const caseEye: Tuple3 = [
  target[0] + far * toward[0],
  target[1] + far * toward[1],
  target[2] + far * toward[2],
];
const unit = (a: Tuple3): Tuple3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const forward = unit(sub(target, caseEye));
const right = unit(cross(forward, [0, 1, 0]));
const caseView: HighlightOptions = {
  field: 'reflection',
  eye: caseEye,
  right,
  up: cross(right, forward),
  width: 3,
};

describe('highlight lines', () => {
  it('C-114: the right body has no highlight finding, the dense traced body has many', {
    timeout: 60_000,
  }, () => {
    const options = { surfaceQuality: { highlights: caseView } } as const;
    const right = buildRight();
    const rightIssues = right.validate(options).issues.filter((i) => i.code === 'surface-quality');
    expect(rightIssues).toEqual([]);
    // Raw surfaces: the faces reach on under their blends' trims, so their lines do too.
    expect(lineCount(right.diagnostics().surfaces, caseView)).toBe(129);
    const wrong = buildWrong();
    const found = wrong
      .validate(options)
      .issues.filter((i) => i.code === 'surface-quality' && i.detail.check === 'highlight');
    expect(found.length).toBe(100);
    expect(lineCount(wrong.diagnostics().surfaces, caseView)).toBe(102);
    const first = found[0]?.detail as Record<string, unknown>;
    expect(first.patches).toEqual(['body']);
    expect(typeof first.level).toBe('number');
    expect((first.point as number[]).length).toBe(3);
    expect((first.spikes as unknown[]).length).toBeGreaterThan(0);
  });

  it('a 0.2 mm bump (sigma 20 mm) on a crowned 0.6 x 0.4 m panel is reported', () => {
    const panel = (bump: number) =>
      grid(31, 21, (s, t) => {
        const x = 0.6 * s;
        const y = 0.4 * t;
        const crown = 0.02 * (1 - ((x - 0.3) / 0.3) ** 2) + 0.012 * (1 - ((y - 0.2) / 0.2) ** 2);
        const g = bump * Math.exp(-((x - 0.33) ** 2 + (y - 0.21) ** 2) / (2 * 0.02 * 0.02));
        return [x, y, crown + g];
      });
    const view: HighlightOptions = {
      field: 'reflection',
      eye: [0.3, -0.9, 1.1],
      right: [1, 0, 0],
      up: [0, 0.77, 0.63],
      width: 3,
    };
    const smooth = [{ name: 'panel', surface: panel(0) }];
    expect(lineCount(smooth, view)).toBe(14);
    expect(highlights(smooth, view)).toEqual([]);
    const bumped = highlights([{ name: 'panel', surface: panel(0.0002) }], view);
    expect(bumped.length).toBe(4);
    expect(bumped.every((i) => i.code === 'highlight')).toBe(true);
    // The finding sits on the bump.
    const point = bumped[0]?.detail.point as Tuple3;
    expect(Math.hypot(point[0] - 0.33, point[1] - 0.21)).toBeLessThan(0.08);
  });

  it('a designed flare declared with inflections { v: 1 } is not a finding', () => {
    // The crown ridge follows an S along v, so the highlight lines along v inflect once.
    const flare = grid(25, 17, (s, t) => {
      const x = 0.6 * s;
      const ridge = 0.3 + 0.04 * Math.sin(Math.PI * (t - 0.5));
      return [x, 0.4 * t, 0.5 * (x - ridge) ** 2];
    });
    const view: HighlightOptions = {
      field: 'reflection',
      direction: [0, 0, 1],
      right: [1, 0, 0],
      up: [0, 1, 0],
      width: 4,
      orientation: 90,
    };
    expect(lineCount([{ name: 'flare', surface: flare }], view)).toBe(19);
    const undeclared = highlights([{ name: 'flare', surface: flare }], view);
    expect(undeclared.length).toBe(15);
    expect(undeclared.every((i) => (i.detail.inflections as unknown[]).length === 1)).toBe(true);
    expect(highlights([{ name: 'flare', surface: flare, inflections: { v: 1 } }], view)).toEqual(
      [],
    );
    // A feature line's designed range over the flare declares it too.
    const ridgeLine: FeatureLine = {
      name: 'ridge',
      curve: isoparm(flare, 'v', 0.5),
      inflections: [[0.3, 0.7]],
    };
    expect(highlights([{ name: 'flare', surface: flare }], view, [ridgeLine])).toEqual([]);
  });

  describe('joints: tangent breaks are exempt only by declaration', () => {
    // Profile curvature 1/m on `a`; the band beside it reaches 4/m either at once (a G1
    // joint, curvature jump) or ramping from 1/m (G2). A gentle crown along y keeps the
    // reflection field regular.
    const crownY = (y: number) => 0.5 * (y - 0.2) ** 2;
    const a = grid(13, 9, (s, t) => {
      const x = -0.3 + 0.3 * s;
      const y = 0.4 * t;
      return [x, y, x * x * 0.5 + crownY(y)];
    });
    const band = (g2: boolean) =>
      grid(13, 9, (s, t) => {
        const x = 0.3 * s;
        const y = 0.4 * t;
        const z = g2 ? x * x * 0.5 + (3 * x * x * x) / 1.8 : 2 * x * x;
        return [x, y, z + crownY(y)];
      });
    const view: HighlightOptions = {
      field: 'reflection',
      eye: [0, -0.8, 1],
      right: [1, 0, 0],
      up: [0, 0.78, 0.62],
      width: 3,
    };
    const joint = (continuity: FeatureLine['continuity']): FeatureLine => ({
      name: 'joint',
      curve: isoparm(a, 'v', 1),
      ...(continuity === undefined ? {} : { continuity }),
    });
    const g1: NamedSurface[] = [
      { name: 'a', surface: a },
      { name: 'band', surface: band(false) },
    ];

    it('an undeclared G1 joint flags the lines crossing it', () => {
      expect(lineCount(g1, view)).toBe(20);
      const found = highlights(g1, view);
      expect(found.length).toBe(11);
      expect(found.every((i) => (i.detail.patches as string[]).join() === 'a,band')).toBe(true);
    });

    it('a G1 feature line or a G1 blend transition declares the break', () => {
      expect(highlights(g1, view, [joint('G1')])).toEqual([]);
      expect(highlights(g1, view, [joint('G0')])).toEqual([]);
      expect(
        highlights(
          [
            g1[0] as NamedSurface,
            { ...(g1[1] as NamedSurface), transition: { kind: 'blend', continuity: 'G1' } },
          ],
          view,
        ),
      ).toEqual([]);
    });

    it('a kink on a joint declared G2 still flags; adjacency alone exempts nothing', () => {
      expect(highlights(g1, view, [joint('G2')]).length).toBe(11);
      expect(highlights(g1, view, [joint(undefined)]).length).toBe(11);
      expect(
        highlights(
          [
            g1[0] as NamedSurface,
            { ...(g1[1] as NamedSurface), transition: { kind: 'blend', continuity: 'G2' } },
          ],
          view,
        ).length,
      ).toBe(11);
    });

    it('a G2 blend gives no spike', () => {
      const g2: NamedSurface[] = [
        { name: 'a', surface: a },
        { name: 'band', surface: band(true), transition: { kind: 'blend', continuity: 'G2' } },
      ];
      expect(lineCount(g2, view)).toBe(14);
      expect(highlights(g2, view)).toEqual([]);
    });
  });

  it('isophotes of a cylinder are its rulings at multiples of the step', () => {
    const r = 0.2;
    const h = Math.SQRT1_2;
    const arc: Tuple3[] = [
      [r, 0, 0],
      [r, r, 0],
      [0, r, 0],
      [-r, r, 0],
      [-r, 0, 0],
    ];
    const cylinder: NurbsSurface = {
      degreeU: 2,
      degreeV: 1,
      points: arc.map((p) => [p, [p[0], p[1], 0.3]]),
      weights: [1, h, 1, h, 1].map((w) => [w, w]),
      knotsU: [0, 0, 0, 0.5, 0.5, 1, 1, 1],
      knotsV: [0, 0, 1, 1],
    };
    const result = highlightLines([cylinder], {
      field: 'isophote',
      direction: [1, 0, 0],
      step: 30,
    });
    if (!result.ok) throw result.error;
    expect(result.value.lines.map((l) => l.level)).toEqual([30, 60, 90, 120, 150]);
    for (const line of result.value.lines) {
      expect(line.patches).toEqual([0]);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const p = curvePoint(line.curve, t);
        expect((Math.atan2(p[1], p[0]) * 180) / Math.PI).toBeCloseTo(line.level, 6);
        expect(Math.hypot(p[0], p[1])).toBeCloseTo(r, 9);
      }
    }
    expect(
      highlightLines([cylinder], { field: 'isophote', direction: [1, 0, 0], step: 0 }).ok,
    ).toBe(false);
  });

  it('reports nothing-checked when no line is extracted', () => {
    const flat = grid(4, 4, (s, t) => [s, t, 0]);
    const found = highlights([{ name: 'flat', surface: flat }], {
      field: 'reflection',
      direction: [0, 0, 1],
      right: [1, 0, 0],
      up: [0, 1, 0],
    });
    expect(found.map((i) => i.code)).toEqual(['nothing-checked']);
  });

  it('is deterministic: two runs give identical curves', { timeout: 30_000 }, () => {
    const surfaces = buildRight()
      .diagnostics()
      .surfaces.map((s) => s.surface);
    const a = highlightLines(surfaces, caseView);
    const b = highlightLines(surfaces, caseView);
    if (!a.ok || !b.ok) throw new Error('highlight lines');
    expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
  });
});
