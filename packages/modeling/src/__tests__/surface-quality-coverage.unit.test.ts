import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import type { HighlightOptions } from '../highlight-lines';
import { type NurbsCurve, type NurbsSurface, nurbs } from '../nurbs';
import {
  checkSurfaceQuality,
  type FeatureLine,
  isoparm,
  type NamedSurface,
  type SurfaceQualityCode,
  type SurfaceQualityInput,
  type SurfaceQualityOptions,
  type SurfaceQualityReport,
} from '../surface-quality';
import { halves, panel } from './fixtures/crowned-panel';
import { expectConserved, expectFalsifiable } from './fixtures/falsifiable';

// B32 gate evidence: coverage of the surface-quality gate, a falsifier per issue code.

interface Run {
  readonly input: SurfaceQualityInput;
  readonly options?: SurfaceQualityOptions;
}

const run = ({ input, options }: Run): SurfaceQualityReport => {
  const report = checkSurfaceQuality(input, options);
  if (!report.ok) throw report.error;
  return report.value;
};

function heightPatch(
  [x0, x1]: readonly [number, number],
  [y0, y1]: readonly [number, number],
  f: (x: number, y: number) => number,
  n = 4,
): NurbsSurface {
  const rows = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j): Tuple3 => {
      const x = x0 + ((x1 - x0) * i) / (n - 1);
      const y = y0 + ((y1 - y0) * j) / (n - 1);
      return [x, y, f(x, y)];
    }),
  );
  const s = nurbs.grid(rows, { parametrization: 'uniform' });
  if (!s.ok) throw s.error;
  return s.value;
}

function through(points: readonly Tuple3[]): NurbsCurve {
  const c = nurbs.interpolate(points);
  if (!c.ok) throw c.error;
  return c.value;
}

const paraboloid = (x: number, y: number) => 0.2 * (x * x + y * y);
const arc = (n: number): Tuple3[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / (n - 1)) * 1.2;
    return [2 * Math.sin(a), 0, 2 * (1 - Math.cos(a))];
  });
const reflection: HighlightOptions = {
  field: 'reflection',
  eye: [0.3, -0.9, 1.1],
  right: [1, 0, 0],
  up: [0, 0.77, 0.63],
  width: 3,
};
const fairArc: FeatureLine = { name: 'roof', curve: through(arc(6)) };

/** A ripple of 2 mm on the interior of an 8 x 6 net. */
const rippled = (ripple: number): NurbsSurface => {
  const rows = Array.from({ length: 8 }, (_, i) =>
    Array.from({ length: 6 }, (_, j): Tuple3 => {
      const x = -0.5 + i / 7;
      const y = -0.4 + (0.8 * j) / 5;
      const w = i > 0 && i < 7 && j > 0 && j < 5 ? (((i + j) % 2) * 2 - 1) * ripple : 0;
      return [x, y, 0.06 * (1 - (y / 0.4) ** 2) + 0.02 * x + w];
    }),
  );
  const s = nurbs.grid(rows, { parametrization: 'uniform' });
  if (!s.ok) throw s.error;
  return s.value;
};

const base = arc(20);
const bumped: NurbsCurve = {
  ...through(base),
  points: through(base).points.map((p, i): Tuple3 => (i === 10 ? [p[0], p[1], p[2] - 0.003] : p)),
};
const quarter = through(
  Array.from({ length: 7 }, (_, i): Tuple3 => {
    const a = (i / 6) * (Math.PI / 2);
    return [2 * Math.cos(a), 0, 0.6 * Math.sin(a)];
  }),
);
const wavy = through(
  Array.from({ length: 24 }, (_, i): Tuple3 => [i * 0.1, 0, 0.002 * Math.sin(i * 1.3)]),
);

describe('surface-quality coverage and falsifiers', () => {
  it('every issue code has an input that turns the gate red, and the clean twin passes', {
    timeout: 240_000,
  }, () => {
    const fairHalves: Run = {
      input: { surfaces: halves(0), curves: [fairArc] },
      options: { highlights: reflection },
    };
    const crease: NamedSurface[] = [
      { name: 'hood', surface: heightPatch([-1, 0], [-1, 1], () => 0) },
      { name: 'fender', surface: heightPatch([0, 1], [-1, 1], (x) => -0.3 * x) },
    ];
    expectFalsifiable<Run, SurfaceQualityCode>(run, fairHalves, {
      'surface-density': {
        input: {
          surfaces: [{ name: 'dense', surface: heightPatch([0, 1], [0, 1], paraboloid, 10) }],
        },
      },
      'surface-continuity': { input: { surfaces: crease } },
      'curve-inflection': { input: { curves: [{ name: 'waist', curve: wavy }] } },
      'curve-spike': { input: { curves: [{ name: 'bump', curve: bumped }] } },
      'curve-curvature-rate': {
        input: { curves: [{ name: 'arch', curve: quarter }] },
        options: { fairness: { maxCurvatureRate: 5 } },
      },
      'surface-fairness': { input: { surfaces: [{ name: 'hood', surface: rippled(0.002) }] } },
      highlight: {
        input: { surfaces: halves(0.25) },
        options: { highlights: reflection, isoparms: 0 },
      },
      'nothing-checked': { input: {} },
    });
  });

  it('the highlight falsifier is the joint jump itself, located at the joint', {
    timeout: 60_000,
  }, () => {
    const options = { highlights: { ...reflection, orientation: 90 }, isoparms: 0 };
    const jumps = (theta: number) =>
      run({ input: { surfaces: halves(theta) }, options }).issues.filter(
        (i) => i.code === 'highlight' && 'jump' in i.detail,
      );
    expect(jumps(0.25).length).toBeGreaterThan(0);
    expect(jumps(0)).toEqual([]);
  });

  it('accounts for every listed subject: checked plus unchecked equals the total', {
    timeout: 120_000,
  }, () => {
    const report = run({
      input: { surfaces: halves(0.25), curves: [fairArc] },
      options: { highlights: reflection },
    });
    expectConserved(report.coverage, {
      'surface-density': 2,
      'surface-continuity': 8,
      'curve-inflection': 1,
      'curve-spike': 1,
      'curve-curvature-rate': 1,
      'surface-fairness': 4,
      highlight: 1,
    });
    expect(report.coverage.checked.find((c) => c.code === 'highlight')).toEqual({
      code: 'highlight',
      subjects: 1,
    });
  });

  it('lists the joints of a kinked panel and a knot kink inside one patch as checked', {
    timeout: 120_000,
  }, () => {
    const options = { highlights: reflection, isoparms: 0 };
    const pair = run({ input: { surfaces: halves(0.25) }, options });
    expect(pair.coverage.checked).toContainEqual({ code: 'highlight', subjects: 1 });
    const knot = run({ input: { surfaces: [{ name: 'p', surface: panel(0.25) }] }, options });
    expect(knot.coverage.checked).toContainEqual({ code: 'highlight', subjects: 1 });
    expectConserved(knot.coverage, { highlight: 1 });
  });

  it('names highlights not requested instead of leaving the joints out of the report', () => {
    const report = run({ input: { surfaces: halves(0.25) } });
    expect(report.coverage.unchecked).toContainEqual({
      code: 'highlight',
      reason: 'not-requested',
      subjects: 1,
      sample: ['l:u1|r:u0'],
    });
    expect(report.coverage.checked.some((c) => c.code === 'highlight')).toBe(false);
    expect(
      run({ input: { surfaces: halves(0) }, options: { isoparms: 0 } }).coverage.unchecked,
    ).toContainEqual(
      expect.objectContaining({ code: 'surface-fairness', reason: 'not-requested' }),
    );
  });

  it('a trim loop with no other patch to pair is missing-input, not checked', () => {
    const report = run({
      input: {
        surfaces: [
          {
            name: 'a',
            surface: heightPatch([0, 1], [0, 1], paraboloid),
            trims: [
              [
                [0.2, 0.2],
                [0.8, 0.2],
                [0.8, 0.8],
                [0.2, 0.8],
              ],
            ],
          },
        ],
      },
    });
    expect(report.coverage.unchecked).toContainEqual({
      code: 'surface-continuity',
      reason: 'missing-input',
      subjects: 1,
      sample: ['a:trim0'],
    });
  });

  it('a gate with nothing to check never passes and lists nothing as checked', () => {
    const report = run({ input: {} });
    expect(report.pass).toBe(false);
    expect(report.coverage.checked).toEqual([]);
  });

  it('a declared G1 joint is a designed break: evaluated, not unchecked', {
    timeout: 120_000,
  }, () => {
    const joint: FeatureLine = {
      name: 'joint',
      curve: isoparm(panel(0), 'v', 0.5),
      continuity: 'G1',
    };
    const report = run({
      input: { surfaces: halves(2), curves: [joint] },
      options: { highlights: reflection, isoparms: 0 },
    });
    expect(report.coverage.checked).toContainEqual({ code: 'highlight', subjects: 1 });
    expect(report.coverage.unchecked.some((u) => u.code === 'highlight')).toBe(false);
  });
});
