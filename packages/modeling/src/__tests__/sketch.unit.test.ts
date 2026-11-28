import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { model } from '../model';
import type { Point2 } from '../primitives';
import { region2d } from '../region2d';
import { type SketchConstraint, type SketchCurve, type SketchSpec, sketch } from '../sketch';

type Points = Record<string, Point2>;
type Curves = Record<string, SketchCurve>;

const dist = (p: Point2, q: Point2) => Math.hypot(q[0] - p[0], q[1] - p[1]);
const line = (a: string, b: string): SketchCurve => ({ kind: 'line', a, b });
const arc = (center: string, from: string, to: string): SketchCurve => ({
  kind: 'arc',
  center,
  from,
  to,
});

/** Independent measurements on the solved points: no solver code is reused here. */
const measure = {
  dir: (p: Points, c: Curves, name: string): Point2 => {
    const l = c[name] as { a: string; b: string };
    const a = p[l.a] as Point2;
    const b = p[l.b] as Point2;
    return [b[0] - a[0], b[1] - a[1]];
  },
  radius: (p: Points, c: Curves, name: string) => {
    const a = c[name] as { center: string; from: string };
    return dist(p[a.center] as Point2, p[a.from] as Point2);
  },
  sinBetween(p: Points, c: Curves, a: string, b: string) {
    const u = measure.dir(p, c, a);
    const v = measure.dir(p, c, b);
    return (u[0] * v[1] - u[1] * v[0]) / (Math.hypot(...u) * Math.hypot(...v));
  },
  cosBetween(p: Points, c: Curves, a: string, b: string) {
    const u = measure.dir(p, c, a);
    const v = measure.dir(p, c, b);
    return (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v));
  },
};

const scale = (points: Points, s: number): Points =>
  Object.fromEntries(Object.entries(points).map(([k, [x, y]]) => [k, [x * s, y * s] as Point2]));

function jitter(points: Points, amount: number, noise: readonly number[]): Points {
  return Object.fromEntries(
    Object.keys(points)
      .sort()
      .map((k, i) => {
        const [x, y] = points[k] as Point2;
        return [
          k,
          [
            x + amount * (noise[2 * i] as number),
            y + amount * (noise[2 * i + 1] as number),
          ] as Point2,
        ];
      }),
  );
}

const RECT: Points = { a: [0, 0], b: [4, 0], c: [4, 3], d: [0, 3] };
const RECT_CURVES: Curves = {
  ab: line('a', 'b'),
  bc: line('b', 'c'),
  cd: line('c', 'd'),
  da: line('d', 'a'),
};
// Stadium: centers k1 and k2, radius 1, tangent end points on the flats.
const SLOT: Points = {
  k1: [0, 0],
  k2: [5, 0],
  p1: [0, -1],
  p2: [5, -1],
  p3: [5, 1],
  p4: [0, 1],
};
const SLOT_CURVES: Curves = {
  bottom: line('p1', 'p2'),
  right: arc('k2', 'p2', 'p3'),
  top: line('p3', 'p4'),
  left: arc('k1', 'p4', 'p1'),
};
const TRIANGLE: Points = { a: [0, 0], b: [4, 0], c: [1, 3] };
const TRIANGLE_CURVES: Curves = { ab: line('a', 'b'), bc: line('b', 'c'), ca: line('c', 'a') };

interface Case {
  readonly name: string;
  readonly points: Points;
  readonly curves: Curves;
  readonly constraints: readonly SketchConstraint[];
  /** The relation each constraint states, measured on the solved points (0 when satisfied). */
  readonly error: (p: Points, c: Curves, s: number) => number;
}

const KINDS: readonly Case[] = [
  {
    name: 'horizontal',
    points: RECT,
    curves: RECT_CURVES,
    constraints: [
      { kind: 'horizontal', line: 'ab' },
      { kind: 'horizontal', line: 'cd' },
    ],
    error: (p, c) =>
      Math.max(Math.abs(measure.dir(p, c, 'ab')[1]), Math.abs(measure.dir(p, c, 'cd')[1])),
  },
  {
    name: 'vertical',
    points: RECT,
    curves: RECT_CURVES,
    constraints: [
      { kind: 'vertical', line: 'bc' },
      { kind: 'vertical', line: 'da' },
    ],
    error: (p, c) =>
      Math.max(Math.abs(measure.dir(p, c, 'bc')[0]), Math.abs(measure.dir(p, c, 'da')[0])),
  },
  {
    name: 'parallel',
    points: RECT,
    curves: RECT_CURVES,
    constraints: [
      { kind: 'parallel', a: 'ab', b: 'cd' },
      { kind: 'parallel', a: 'bc', b: 'da' },
    ],
    error: (p, c) =>
      Math.max(
        Math.abs(measure.sinBetween(p, c, 'ab', 'cd')),
        Math.abs(measure.sinBetween(p, c, 'bc', 'da')),
      ),
  },
  {
    name: 'perpendicular',
    points: RECT,
    curves: RECT_CURVES,
    constraints: [
      { kind: 'perpendicular', a: 'ab', b: 'bc' },
      { kind: 'perpendicular', a: 'bc', b: 'cd' },
    ],
    error: (p, c) =>
      Math.max(
        Math.abs(measure.cosBetween(p, c, 'ab', 'bc')),
        Math.abs(measure.cosBetween(p, c, 'bc', 'cd')),
      ),
  },
  {
    name: 'distance',
    points: RECT,
    curves: RECT_CURVES,
    constraints: [
      { kind: 'distance', a: 'a', b: 'b', value: 4 },
      { kind: 'distance', a: 'b', b: 'c', value: 3 },
    ],
    error: (p, _c, s) =>
      Math.max(
        Math.abs(dist(p.a as Point2, p.b as Point2) - 4 * s),
        Math.abs(dist(p.b as Point2, p.c as Point2) - 3 * s),
      ),
  },
  {
    name: 'coincident',
    points: { ...RECT, d2: [0, 3] },
    curves: { ...RECT_CURVES, da: line('d2', 'a') },
    constraints: [{ kind: 'coincident', a: 'd', b: 'd2' }],
    error: (p) => dist(p.d as Point2, p.d2 as Point2),
  },
  {
    name: 'fix',
    points: RECT,
    curves: RECT_CURVES,
    constraints: [
      { kind: 'fix', point: 'a', at: [0, 0] },
      { kind: 'fix', point: 'c', at: [4, 3] },
    ],
    error: (p, _c, s) => Math.max(dist(p.a as Point2, [0, 0]), dist(p.c as Point2, [4 * s, 3 * s])),
  },
  {
    name: 'equal (lines)',
    points: RECT,
    curves: RECT_CURVES,
    constraints: [
      { kind: 'equal', a: 'ab', b: 'cd' },
      { kind: 'equal', a: 'bc', b: 'da' },
    ],
    error: (p, c) =>
      Math.max(
        Math.abs(Math.hypot(...measure.dir(p, c, 'ab')) - Math.hypot(...measure.dir(p, c, 'cd'))),
        Math.abs(Math.hypot(...measure.dir(p, c, 'bc')) - Math.hypot(...measure.dir(p, c, 'da'))),
      ),
  },
  {
    name: 'equal (arcs)',
    points: SLOT,
    curves: SLOT_CURVES,
    constraints: [{ kind: 'equal', a: 'left', b: 'right' }],
    error: (p, c) => Math.abs(measure.radius(p, c, 'left') - measure.radius(p, c, 'right')),
  },
  {
    name: 'radius',
    points: SLOT,
    curves: SLOT_CURVES,
    constraints: [
      { kind: 'radius', arc: 'left', value: 1 },
      { kind: 'radius', arc: 'right', value: 1 },
    ],
    error: (p, c, s) =>
      Math.max(
        Math.abs(measure.radius(p, c, 'left') - s),
        Math.abs(measure.radius(p, c, 'right') - s),
      ),
  },
  {
    name: 'tangent',
    points: SLOT,
    curves: SLOT_CURVES,
    constraints: [
      { kind: 'tangent', line: 'bottom', arc: 'left' },
      { kind: 'tangent', line: 'top', arc: 'right' },
      { kind: 'tangent', line: 'top', arc: 'left' },
      { kind: 'tangent', line: 'bottom', arc: 'right' },
    ],
    error: (p, c) => {
      const off = (l: string, a: string) => {
        const u = measure.dir(p, c, l);
        const o = p[(c[l] as { a: string }).a] as Point2;
        const k = p[(c[a] as { center: string }).center] as Point2;
        return Math.abs(
          Math.abs(u[0] * (k[1] - o[1]) - u[1] * (k[0] - o[0])) / Math.hypot(...u) -
            measure.radius(p, c, a),
        );
      };
      return Math.max(
        off('bottom', 'left'),
        off('top', 'right'),
        off('top', 'left'),
        off('bottom', 'right'),
      );
    },
  },
  {
    name: 'angle',
    points: TRIANGLE,
    curves: TRIANGLE_CURVES,
    constraints: [
      { kind: 'angle', a: 'ab', b: 'bc', degrees: 180 - (Math.atan2(3, -3) * -180) / Math.PI },
    ],
    error: (p, c) => {
      const t = ((180 - (Math.atan2(3, -3) * -180) / Math.PI) * Math.PI) / 180;
      return Math.abs(
        measure.sinBetween(p, c, 'ab', 'bc') * Math.cos(t) -
          measure.cosBetween(p, c, 'ab', 'bc') * Math.sin(t),
      );
    },
  },
];

const noiseOf = (n: number) =>
  fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 2 * n, maxLength: 2 * n });

describe('sketch.solve: every constraint kind converges from 1 percent noise', () => {
  for (const kind of KINDS) {
    it(kind.name, () => {
      const count = Object.keys(kind.points).length;
      fc.assert(
        fc.property(fc.double({ min: 0.01, max: 10, noNaN: true }), noiseOf(count), (s, noise) => {
          const truth = scale(kind.points, s);
          const start = jitter(truth, 0.01 * s, noise);
          const constraints = kind.constraints.map((k) => scaled(k, s));
          const result = sketch.solve({ points: start, curves: kind.curves, constraints });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.residual).toBeLessThanOrEqual(1e-8);
          expect(kind.error(result.value.points, kind.curves, s)).toBeLessThanOrEqual(
            1e-7 * Math.max(1, s),
          );
        }),
        { seed: 20261102, numRuns: 40 },
      );
    });

    it(`${kind.name}: the noisy start violates the relation (the check is not vacuous)`, () => {
      const count = Object.keys(kind.points).length;
      const noise = Array.from({ length: 2 * count }, (_, i) =>
        i % 3 === 0 ? 1 : i % 3 === 1 ? -0.7 : 0.4,
      );
      const start = jitter(kind.points, 0.05, noise);
      expect(kind.error(start, kind.curves, 1)).toBeGreaterThan(1e-4);
    });
  }
});

function scaled(k: SketchConstraint, s: number): SketchConstraint {
  if (k.kind === 'distance' || k.kind === 'radius') return { ...k, value: k.value * s };
  if (k.kind === 'fix') return k.at === undefined ? k : { ...k, at: [k.at[0] * s, k.at[1] * s] };
  return k;
}

describe('sketch.solve: region', () => {
  const stadium: SketchSpec = {
    points: SLOT,
    curves: SLOT_CURVES,
    constraints: [
      { kind: 'fix', point: 'k1' },
      { kind: 'horizontal', line: 'bottom' },
      { kind: 'distance', a: 'k1', b: 'k2', value: 5 },
      { kind: 'radius', arc: 'left', value: 1 },
      { kind: 'equal', a: 'left', b: 'right' },
      { kind: 'tangent', line: 'bottom', arc: 'left' },
      { kind: 'tangent', line: 'top', arc: 'left' },
      { kind: 'coincident', a: 'k1', b: 'k1' },
    ],
  };

  it('samples arcs within the chord tolerance and encloses the analytic area', () => {
    const r = sketch.solve(stadium, { arcTolerance: 1e-4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.region).toHaveLength(1);
    const area = region2d.area(r.value.region);
    const exact = 2 * 5 + Math.PI;
    expect(area).toBeLessThan(exact);
    expect(exact - area).toBeLessThan(exact * 1e-3);
    const ring = (r.value.region[0] as { outer: readonly Point2[] }).outer;
    let signed = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i] as Point2;
      const q = ring[(i + 1) % ring.length] as Point2;
      signed += p[0] * q[1] - q[0] * p[1];
    }
    expect(signed).toBeGreaterThan(0);
    for (const p of ring) {
      const k = (p[0] < 2.5 ? [0, 0] : [5, 0]) as Point2;
      if (p[0] < 0 || p[0] > 5) expect(Math.abs(dist(p, k) - 1)).toBeLessThan(1e-9);
    }
  });

  it('a finer arcTolerance gives more points', () => {
    const coarse = sketch.solve(stadium, { arcTolerance: 1e-2 });
    const fine = sketch.solve(stadium, { arcTolerance: 1e-5 });
    if (!coarse.ok || !fine.ok) throw new Error('solve');
    const count = (r: typeof coarse.value) =>
      (r.region[0] as { outer: readonly Point2[] }).outer.length;
    expect(count(fine.value)).toBeGreaterThan(count(coarse.value));
  });

  it('nested loops become an outline with a hole; a full circle is one arc', () => {
    const r = sketch.solve({
      points: { ...RECT, c0: [2, 1.5], rim: [3, 1.5] },
      curves: { ...RECT_CURVES, bore: arc('c0', 'rim', 'rim') },
      constraints: [{ kind: 'radius', arc: 'bore', value: 0.8 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.region).toHaveLength(1);
    const shape = r.value.region[0] as {
      outer: readonly Point2[];
      holes?: readonly (readonly Point2[])[];
    };
    expect(shape.holes).toHaveLength(1);
    const expected = 12 - Math.PI * 0.64;
    expect(Math.abs(region2d.area(r.value.region) - expected)).toBeLessThan(expected * 1e-3);
    expect(region2d.contains(r.value.region, [2, 1.5])).toBe(false);
    expect(region2d.contains(r.value.region, [0.5, 0.5])).toBe(true);
  });

  it('two separate loops give two shapes, in any curve order', () => {
    const points: Points = { ...RECT, e: [6, 0], f: [8, 0], g: [8, 2], h: [6, 2] };
    const curves: Curves = {
      ...RECT_CURVES,
      ef: line('e', 'f'),
      fg: line('f', 'g'),
      gh: line('g', 'h'),
      he: line('h', 'e'),
    };
    const forward = sketch.solve({ points, curves, constraints: [] });
    const reversed = sketch.solve({
      points,
      curves: Object.fromEntries(Object.entries(curves).reverse()),
      constraints: [],
    });
    if (!forward.ok || !reversed.ok) throw new Error('solve');
    expect(forward.value.region).toHaveLength(2);
    expect(region2d.area(forward.value.region)).toBeCloseTo(16, 12);
    expect(region2d.area(reversed.value.region)).toBeCloseTo(16, 12);
  });

  it('extrudes into a closed solid whose volume is area times depth', () => {
    const r = sketch.solve({
      points: { ...RECT, c0: [2, 1.5], rim: [3, 1.5] },
      curves: { ...RECT_CURVES, bore: arc('c0', 'rim', 'rim') },
      constraints: [{ kind: 'radius', arc: 'bore', value: 0.5 }],
    });
    if (!r.ok) throw new Error('solve');
    const shape = r.value.region[0] as {
      outer: readonly Point2[];
      holes?: readonly (readonly Point2[])[];
    };
    const m = model();
    m.extrudePolygon({
      points: shape.outer,
      ...(shape.holes === undefined ? {} : { holes: shape.holes }),
      depth: 0.5,
    });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(report.volume).toBeCloseTo(region2d.area(r.value.region) * 0.5, 9);
  });

  it('is deterministic', () => {
    const a = sketch.solve(stadium);
    const b = sketch.solve(stadium);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('sketch.solve: degrees of freedom', () => {
  const points = RECT;
  const base: SketchConstraint[] = [
    { kind: 'horizontal', line: 'ab' },
    { kind: 'horizontal', line: 'cd' },
    { kind: 'vertical', line: 'bc' },
    { kind: 'vertical', line: 'da' },
  ];
  const dof = (constraints: readonly SketchConstraint[]) => {
    const r = sketch.solve({ points, curves: RECT_CURVES, constraints });
    if (!r.ok) throw r.error;
    return r.value;
  };

  it('counts position and both sizes for an axis-aligned rectangle', () => {
    const r = dof(base);
    expect(r.dof).toBe(4);
    expect(r.free).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops one per added independent constraint down to a fully constrained sketch', () => {
    const fixed = dof([...base, { kind: 'fix', point: 'a' }]);
    expect(fixed.dof).toBe(2);
    const wide = dof([
      ...base,
      { kind: 'fix', point: 'a' },
      { kind: 'distance', a: 'a', b: 'b', value: 4 },
    ]);
    expect(wide.dof).toBe(1);
    expect(wide.free).toEqual(['c', 'd']);
    const full = dof([
      ...base,
      { kind: 'fix', point: 'a' },
      { kind: 'distance', a: 'a', b: 'b', value: 4 },
      { kind: 'distance', a: 'b', b: 'c', value: 3 },
    ]);
    expect(full.dof).toBe(0);
    expect(full.free).toEqual([]);
  });

  it('keeps the dof of a sketch with redundant but consistent constraints', () => {
    const full = dof([
      ...base,
      { kind: 'perpendicular', a: 'ab', b: 'bc' },
      { kind: 'parallel', a: 'ab', b: 'cd' },
      { kind: 'fix', point: 'a' },
      { kind: 'distance', a: 'a', b: 'b', value: 4 },
      { kind: 'distance', a: 'b', b: 'c', value: 3 },
    ]);
    expect(full.dof).toBe(0);
  });

  it('a free sketch stays where it started and any dof configuration satisfies the constraints', () => {
    const r = dof(base);
    expect((r.points.a as Point2)[0]).toBeCloseTo(0, 6);
    const other = sketch.solve({
      points: { ...points, c: [5, 4.5] },
      curves: RECT_CURVES,
      constraints: base,
    });
    if (!other.ok) throw other.error;
    expect((other.value.points.c as Point2)[0]).toBeCloseTo((other.value.points.b as Point2)[0], 9);
    expect(other.value.dof).toBe(4);
  });
});

describe('sketch.solve: failures', () => {
  const rect = (constraints: readonly SketchConstraint[]) =>
    sketch.solve({ points: RECT, curves: RECT_CURVES, constraints });

  it('contradicting constraints fail with model-solver-diverged and the residual', () => {
    const r = rect([
      { kind: 'distance', a: 'a', b: 'b', value: 4 },
      { kind: 'distance', a: 'a', b: 'b', value: 6 },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-solver-diverged');
    expect((r.error.detail?.residual as number) > 0.1).toBe(true);
    expect(typeof r.error.detail?.iterations).toBe('number');
  });

  it('a perpendicular and parallel pair on one line pair contradict', () => {
    const r = rect([
      { kind: 'parallel', a: 'ab', b: 'bc' },
      { kind: 'perpendicular', a: 'ab', b: 'bc' },
    ]);
    expect(r.ok === false && r.error.code).toBe('model-solver-diverged');
  });

  it.each([
    [
      'an unknown point in a constraint',
      [{ kind: 'fix', point: 'zz' }] as SketchConstraint[],
      'constraints[0].point',
    ],
    [
      'an unknown curve in a constraint',
      [{ kind: 'horizontal', line: 'zz' }] as SketchConstraint[],
      'constraints[0].line',
    ],
    [
      'an arc where a line is required',
      [{ kind: 'horizontal', line: 'r' }] as SketchConstraint[],
      'constraints[0].line',
    ],
    [
      'a negative radius',
      [{ kind: 'radius', arc: 'r', value: -1 }] as SketchConstraint[],
      'constraints[0].value',
    ],
    [
      'a non-finite distance',
      [{ kind: 'distance', a: 'a', b: 'b', value: Number.NaN }] as SketchConstraint[],
      'constraints[0].value',
    ],
  ])('%s is model-invalid-argument naming the option', (_name, constraints, option) => {
    const r = sketch.solve({
      points: { ...RECT, k: [2, 1], q: [3, 1] },
      curves: { ...RECT_CURVES, r: arc('k', 'q', 'q') },
      constraints,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
    expect(r.error.detail?.option).toBe(option);
  });

  it('rejects unknown kinds, non-finite points, no curves and bad options', () => {
    const bad = (spec: SketchSpec, options = {}) => {
      const r = sketch.solve(spec, options);
      return r.ok ? 'ok' : r.error.code;
    };
    expect(
      bad({ points: RECT, curves: RECT_CURVES, constraints: [{ kind: 'bogus' } as never] }),
    ).toBe('model-invalid-argument');
    expect(
      bad({ points: { ...RECT, a: [Number.NaN, 0] }, curves: RECT_CURVES, constraints: [] }),
    ).toBe('model-invalid-argument');
    expect(bad({ points: RECT, curves: {}, constraints: [] })).toBe('model-invalid-argument');
    expect(bad({ points: RECT, curves: RECT_CURVES, constraints: [] }, { tolerance: 0 })).toBe(
      'model-invalid-argument',
    );
    expect(bad({ points: RECT, curves: RECT_CURVES, constraints: [] }, { arcTolerance: -1 })).toBe(
      'model-invalid-argument',
    );
    expect(bad({ points: RECT, curves: { ab: line('a', 'zz') }, constraints: [] })).toBe(
      'model-invalid-argument',
    );
  });

  it('an open chain is model-precondition profile-not-closed naming the point', () => {
    const r = sketch.solve({
      points: RECT,
      curves: { ab: line('a', 'b'), bc: line('b', 'c'), cd: line('c', 'd') },
      constraints: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-precondition');
    expect(r.error.detail).toMatchObject({ reason: 'profile-not-closed' });
  });

  it('a loop that encloses no area is model-degenerate', () => {
    const r = sketch.solve({
      points: { a: [0, 0], b: [1, 0], c: [2, 0] },
      curves: { ab: line('a', 'b'), bc: line('b', 'c'), ca: line('c', 'a') },
      constraints: [],
    });
    expect(r.ok === false && r.error.code).toBe('model-degenerate');
  });
});
