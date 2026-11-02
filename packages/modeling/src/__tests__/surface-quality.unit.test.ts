import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { type NurbsCurve, type NurbsSurface, nurbs } from '../nurbs';
import { checkSurfaceQuality, curveFairness, isoparm } from '../surface-quality';

/** Bicubic patch of the height field z = f(x, y) over a rectangle (exact for cubic f). */
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

function curve(points: readonly Tuple3[]): NurbsCurve {
  const c = nurbs.interpolate(points);
  if (!c.ok) throw c.error;
  return c.value;
}

const paraboloid = (x: number, y: number) => 0.2 * (x * x + y * y);

describe('continuity report', () => {
  it('reports G2 across a split of one smooth surface', () => {
    const report = checkSurfaceQuality({
      surfaces: [
        { name: 'left', surface: heightPatch([-1, 0], [-1, 1], paraboloid) },
        { name: 'right', surface: heightPatch([0, 1], [-1, 1], paraboloid) },
      ],
    });
    if (!report.ok) throw report.error;
    expect(report.value.edges).toHaveLength(1);
    const edge = report.value.edges[0];
    expect(edge).toMatchObject({
      a: 'left',
      sideA: 'u1',
      b: 'right',
      sideB: 'u0',
      achieved: 'G3',
      class: 'primary',
    });
    expect(edge?.gap.value).toBeLessThan(1e-9);
    expect(edge?.angle.value).toBeLessThan(1e-6);
    expect(edge?.curvature.value).toBeLessThan(1e-6);
    expect(report.value.pass).toBe(true);
  });

  it('reports a tangent joint as G1, not G2', () => {
    const report = checkSurfaceQuality(
      {
        surfaces: [
          { name: 'flat', surface: heightPatch([-1, 0], [-1, 1], () => 0) },
          { name: 'bend', surface: heightPatch([0, 1], [-1, 1], (x) => 0.5 * x * x) },
        ],
      },
      { continuity: 'G2' },
    );
    if (!report.ok) throw report.error;
    const edge = report.value.edges[0];
    expect(edge?.achieved).toBe('G1');
    expect(edge?.curvature.value).toBeCloseTo(1, 6);
    expect(edge?.pass).toBe(false);
    expect(report.value.issues.map((i) => i.code)).toEqual(['surface-continuity']);
    expect(report.value.issues[0]?.detail.subject).toBe('flat:u1|bend:u0');
  });

  it('tightens the per-scene G2 floor on request', () => {
    const surfaces = [
      { name: 'flat', surface: heightPatch([-1, 0], [-1, 1], () => 0) },
      { name: 'gentle', surface: heightPatch([0, 1], [-1, 1], (x) => 0.0045 * x * x) },
    ];
    const loose = checkSurfaceQuality({ surfaces }, { continuity: 'G2' });
    const tight = checkSurfaceQuality({ surfaces }, { continuity: 'G2', curvatureFloor: 0.001 });
    if (!loose.ok || !tight.ok) throw new Error('check');
    // Under the floor the curvatures count as equal; both rates are near zero, so G3.
    expect(loose.value.edges[0]?.achieved).toBe('G3');
    expect(tight.value.edges[0]?.achieved).toBe('G1');
    expect(checkSurfaceQuality({ surfaces }, { curvatureFloor: 0 }).ok).toBe(false);
  });

  it('measures a crease and accepts it as a designed break on a G0 feature line', () => {
    const surfaces = [
      { name: 'hood', surface: heightPatch([-1, 0], [-1, 1], () => 0) },
      { name: 'fender', surface: heightPatch([0, 1], [-1, 1], (x) => -0.3 * x) },
    ];
    const plain = checkSurfaceQuality({ surfaces });
    if (!plain.ok) throw plain.error;
    expect(plain.value.edges[0]?.achieved).toBe('G0');
    expect(plain.value.edges[0]?.angle.value).toBeCloseTo((Math.atan(0.3) * 180) / Math.PI, 6);
    expect(plain.value.pass).toBe(false);
    const crease = curve([
      [0, -1, 0],
      [0, 0, 0],
      [0, 1, 0],
    ]);
    const designed = checkSurfaceQuality({
      surfaces,
      curves: [{ name: 'shoulder', curve: crease, continuity: 'G0' }],
    });
    if (!designed.ok) throw designed.error;
    expect(designed.value.edges[0]).toMatchObject({
      achieved: 'G0',
      required: 'G0',
      feature: 'shoulder',
      designedBreak: true,
      pass: true,
    });
    expect(designed.value.pass).toBe(true);
  });

  it('reports a gap within the adjacency distance as a G0 failure with its location', () => {
    const report = checkSurfaceQuality({
      surfaces: [
        { name: 'a', surface: heightPatch([-1, 0], [-1, 1], () => 0) },
        { name: 'b', surface: heightPatch([0, 1], [-1, 1], () => 5e-4) },
      ],
    });
    if (!report.ok) throw report.error;
    expect(report.value.edges[0]?.achieved).toBe('none');
    expect(report.value.edges[0]?.gap.value).toBeCloseTo(5e-4, 9);
    const far = checkSurfaceQuality({
      surfaces: [
        { name: 'a', surface: heightPatch([-1, 0], [-1, 1], () => 0) },
        { name: 'b', surface: heightPatch([0, 1], [-1, 1], () => 0.01) },
      ],
    });
    if (!far.ok) throw far.error;
    expect(far.value.edges).toHaveLength(0);
  });

  it('pairs a closed patch seam with itself', () => {
    const H = Math.SQRT1_2;
    const ring: NurbsCurve = {
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
    const lifted = (z: number): NurbsCurve => ({
      ...ring,
      points: ring.points.map(([x, y]) => [x, y, z] as Tuple3),
    });
    const tube = nurbs.loft([lifted(0), lifted(1)], { degree: 1 });
    if (!tube.ok) throw tube.error;
    const report = checkSurfaceQuality({ surfaces: [{ name: 'tube', surface: tube.value }] });
    if (!report.ok) throw report.error;
    expect(report.value.edges).toHaveLength(1);
    expect(report.value.edges[0]).toMatchObject({ a: 'tube', b: 'tube', achieved: 'G3' });
  });
});

describe('control-point density', () => {
  it('fails a 10 x 8 net and passes 8 x 6 in either orientation', () => {
    const dense = heightPatch([0, 1], [0, 1], paraboloid, 10);
    const report = checkSurfaceQuality({
      surfaces: [
        { name: 'dense', surface: nurbs.transpose(heightPatch([0, 1], [0, 1], paraboloid, 8)) },
        { name: 'ok', surface: heightPatch([2, 3], [0, 1], paraboloid, 6) },
        { name: 'interp', surface: dense },
      ],
    });
    if (!report.ok) throw report.error;
    expect(report.value.surfaces.map((s) => [s.name, s.pass])).toEqual([
      ['dense', false],
      ['ok', true],
      ['interp', false],
    ]);
    const tall: NurbsSurface = {
      ...heightPatch([0, 1], [0, 1], paraboloid, 8),
    };
    const ok = checkSurfaceQuality(
      { surfaces: [{ name: 's', surface: tall }] },
      { maxNet: [8, 8] },
    );
    if (!ok.ok) throw ok.error;
    expect(ok.value.pass).toBe(true);
    const issue = report.value.issues.find((i) => i.detail.subject === 'interp');
    expect(issue).toMatchObject({ code: 'surface-density', detail: { net: [10, 10] } });
  });
});

describe('curve fairness', () => {
  const arc = (n: number): Tuple3[] =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / (n - 1)) * 1.2;
      return [2 * Math.sin(a), 0, 2 * (1 - Math.cos(a))];
    });

  it('passes a fair arc and fails a wavy line on inflections', () => {
    const fair = curveFairness({ name: 'roof', curve: curve(arc(6)) });
    if (!fair.ok) throw fair.error;
    expect(fair.value.inflections).toHaveLength(0);
    expect(fair.value.spikes).toHaveLength(0);
    expect(fair.value.pass).toBe(true);
    const wavy = curveFairness({
      name: 'waist',
      curve: curve(
        Array.from({ length: 24 }, (_, i): Tuple3 => [i * 0.1, 0, 0.002 * Math.sin(i * 1.3)]),
      ),
    });
    if (!wavy.ok) throw wavy.error;
    expect(wavy.value.inflections.length).toBeGreaterThan(4);
    expect(wavy.value.pass).toBe(false);
  });

  it('finds a local curvature spike on an otherwise convex curve', () => {
    const base = curve(arc(20));
    const bump = (d: number): NurbsCurve => ({
      ...base,
      points: base.points.map((p, i): Tuple3 => (i === 10 ? [p[0], p[1], p[2] - d] : p)),
    });
    const result = curveFairness({ name: 'bump', curve: bump(0.003) });
    if (!result.ok) throw result.error;
    expect(result.value.inflections).toHaveLength(0);
    expect(result.value.spikes).toHaveLength(1);
    expect(result.value.spikes[0]?.t).toBeCloseTo(0.53, 1);
    expect(result.value.pass).toBe(false);
    const smooth = curveFairness({ name: 'base', curve: base });
    if (!smooth.ok) throw smooth.error;
    expect(smooth.value.pass).toBe(true);
  });

  it('accepts an eccentric but monotone quarter ellipse and bounds its rate on request', () => {
    const quarter = curve(
      Array.from({ length: 7 }, (_, i): Tuple3 => {
        const a = (i / 6) * (Math.PI / 2);
        return [2 * Math.cos(a), 0, 0.6 * Math.sin(a)];
      }),
    );
    const result = curveFairness({ name: 'arch', curve: quarter });
    if (!result.ok) throw result.error;
    expect(result.value.rateRatio).toBeLessThan(15);
    expect(result.value.pass).toBe(true);
    const strict = curveFairness({ name: 'arch', curve: quarter }, { maxCurvatureRate: 5 });
    expect(strict.ok && strict.value.pass).toBe(false);
  });

  it('dense interpolation of noisy samples fails where a least-squares fit passes', () => {
    const noisy = arc(40).map((p, i): Tuple3 => [p[0], p[1], p[2] + 0.0015 * Math.sin(i * 2.7)]);
    const dense = curveFairness({ name: 'dense', curve: curve(noisy) });
    const fitted = nurbs.approximate(noisy, { controlPoints: 6 });
    if (!dense.ok || !fitted.ok) throw new Error('fit');
    const fair = curveFairness({ name: 'fit', curve: fitted.value });
    if (!fair.ok) throw fair.error;
    expect(dense.value.pass).toBe(false);
    expect(fair.value.pass).toBe(true);
  });

  it('ignores flat ends and near-straight noise but keeps a hooked start', () => {
    // F1 side-intake span: curvature passes zero within the first sample.
    const intake: NurbsCurve = {
      degree: 3,
      points: [
        [-0.6178743591569353, 0.41285591026747187, 0],
        [-0.5805543011023282, 0.3775861223094153, 0],
        [-0.5462028528538769, 0.34484818640859466, 0],
        [-0.37583780228686475, 0.380221455111399, 0],
        [-0.3496505981201936, 0.4254667817083692, 0],
      ],
      knots: [0, 0, 0, 0, 0.3970226439253201, 1, 1, 1, 1],
    };
    const end = curveFairness({ name: 'intake', curve: intake });
    if (!end.ok) throw end.error;
    expect(end.value.inflections).toHaveLength(0);
    const straight = curveFairness({
      name: 'deck',
      curve: curve([
        [0, 0, 0],
        [0.5, 0.0004, 0],
        [1, 0.0002, 0],
        [1.5, 0.0005, 0],
      ]),
    });
    if (!straight.ok) throw straight.error;
    expect(straight.value.rateRatio).toBe(0);
    // F1 roof span whose second control point lies behind the first: a hook at the start.
    const hooked = curveFairness({
      name: 'roof',
      curve: {
        degree: 2,
        points: [
          [-2.2235, 0.9034493849870848, 0],
          [-2.2473745186217986, 0.9301246894149362, 0],
          [-0.6835, 1.1038701708438903, 0],
        ],
        knots: [0, 0, 0, 1, 1, 1],
      },
    });
    if (!hooked.ok) throw hooked.error;
    expect(hooked.value.pass).toBe(false);
    expect(hooked.value.rateAt.t).toBeLessThan(0.01);
  });

  it('rejects malformed options and duplicate names', () => {
    expect(curveFairness({ name: 'c', curve: curve(arc(5)) }, { samples: 3 }).ok).toBe(false);
    const s = heightPatch([0, 1], [0, 1], paraboloid);
    const dup = checkSurfaceQuality({
      surfaces: [
        { name: 'x', surface: s },
        { name: 'x', surface: s },
      ],
    });
    expect(!dup.ok && dup.error.code).toBe('model-invalid-argument');
    const bad = checkSurfaceQuality({ surfaces: [{ name: 'x', surface: s }] }, { position: -1 });
    expect(!bad.ok && bad.error.code).toBe('model-invalid-argument');
  });
});

describe('session surface quality', () => {
  it('records patches and feature lines and validates them on request', () => {
    const m = model();
    m.surface({
      patches: [
        { name: 'hood', surface: heightPatch([-1, 0], [-1, 1], () => 0) },
        { name: 'hood', surface: heightPatch([0, 1], [-1, 1], (x) => 0.5 * x * x) },
      ],
      chord: 0.005,
    });
    m.featureLine({
      name: 'wavy',
      curve: curve(
        Array.from({ length: 12 }, (_, i): Tuple3 => [i * 0.1, 0, 0.002 * Math.sin(i * 1.3)]),
      ),
    });
    const d = m.diagnostics();
    expect(d.surfaces.map((s) => s.name)).toEqual(['hood', 'hood.1']);
    expect(d.featureLines.map((f) => f.name)).toEqual(['wavy']);
    expect(m.validate().issues.some((i) => i.code === 'surface-quality')).toBe(false);
    const report = m.validate({ surfaceQuality: { continuity: 'G2' } });
    const quality = report.issues.filter((i) => i.code === 'surface-quality');
    expect(quality.map((i) => i.detail.check).sort()).toEqual([
      'curve-inflection',
      'surface-continuity',
    ]);
    const continuity = quality.find((i) => i.detail.check === 'surface-continuity');
    expect(continuity?.severity).toBe('warn');
    expect(continuity?.detail).toMatchObject({
      subject: 'hood:u1|hood.1:u0',
      opIndex: 0,
      achieved: 'G1',
    });
    expect((continuity?.detail.point as number[])[0]).toBeCloseTo(0, 9);
    expect(quality.find((i) => i.detail.check === 'curve-inflection')?.detail.opIndex).toBe(1);
    const bad = m.validate({ surfaceQuality: { angle: 0 } });
    expect(bad.pass).toBe(false);
    expect(bad.issues.at(-1)).toMatchObject({ code: 'surface-quality', severity: 'error' });
  });

  it('rejects duplicate or malformed feature lines and poisons the session', () => {
    const m = model();
    const line = curve([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0.1, 0],
    ]);
    expect(m.featureLine({ name: 'sill', curve: line }).status).toBe('ok');
    const dup = m.featureLine({ name: 'sill', curve: line });
    expect(dup.status).toBe('failed');
    expect(dup.error?.code).toBe('model-invalid-argument');
    const other = model();
    const broken = other.featureLine({
      name: 'x',
      curve: { degree: 3, points: [[0, 0, 0]], knots: [0, 1] },
    });
    expect(broken.error?.code).toBe('model-invalid-argument');
  });
});

describe('surface fairness', () => {
  const crown = (x: number, y: number) => 0.06 * (1 - (y / 0.4) ** 2) + 0.02 * x;
  /** 1 m x 0.8 m crowned panel on an 8 x 6 net; `ripple` alternates the interior points. */
  const panel = (ripple: number) => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      Array.from({ length: 6 }, (_, j): Tuple3 => {
        const x = -0.5 + i / 7;
        const y = -0.4 + (0.8 * j) / 5;
        const w = i > 0 && i < 7 && j > 0 && j < 5 ? (((i + j) % 2) * 2 - 1) * ripple : 0;
        return [x, y, crown(x, y) + w];
      }),
    );
    const s = nurbs.grid(rows, { parametrization: 'uniform' });
    if (!s.ok) throw s.error;
    return s.value;
  };

  it('extracts exact isoparms', () => {
    const s = panel(0);
    const line = isoparm(s, 'u', 0.3);
    const [[u0, u1], [v0, v1]] = nurbs.surfaceDomain(s);
    for (const f of [0, 0.2, 0.55, 1]) {
      const a = nurbs.point(line, f);
      const b = nurbs.surfacePoint(s, u0 + (u1 - u0) * f, v0 + (v1 - v0) * 0.3);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-12);
    }
  });

  it('fails a panel whose control net ripples 2 mm and passes the smooth one', () => {
    const wavy = checkSurfaceQuality({ surfaces: [{ name: 'hood', surface: panel(0.002) }] });
    if (!wavy.ok) throw wavy.error;
    expect(wavy.value.issues.map((i) => i.code)).toContain('surface-fairness');
    expect(wavy.value.pass).toBe(false);
    const smooth = checkSurfaceQuality({ surfaces: [{ name: 'hood', surface: panel(0) }] });
    if (!smooth.ok) throw smooth.error;
    expect(smooth.value.pass).toBe(true);
    const m = model();
    m.surface({ patches: [{ name: 'hood', surface: panel(0.002) }] });
    const v = m.validate({ surfaceQuality: true });
    expect(
      v.issues.some((i) => i.code === 'surface-quality' && i.detail.check === 'surface-fairness'),
    ).toBe(true);
  });

  it('reports a session with nothing to check instead of passing', () => {
    const m = model();
    m.plane({ width: 1, height: 1 });
    const v = m.validate({ surfaceQuality: true });
    expect(v.issues.some((i) => i.detail.check === 'nothing-checked')).toBe(true);
    const empty = checkSurfaceQuality({});
    if (!empty.ok) throw empty.error;
    expect(empty.value.pass).toBe(false);
  });
});

describe('designed inflections', () => {
  /** A wheel-arch flare: an S-shaped section across v (smoothstep), crowned along u. */
  const flare = (ripple: number) => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 6 }, (_, j): Tuple3 => {
        const x = i / 5;
        const y = (0.4 * j) / 5;
        const t = y / 0.4;
        const w = i > 0 && i < 5 && j > 0 && j < 5 ? (((i + j) % 2) * 2 - 1) * ripple : 0;
        return [x, y, 0.05 * (3 * t * t - 2 * t * t * t) + 0.03 * (1 - (2 * x - 1) ** 2) + w];
      }),
    );
    const s = nurbs.grid(rows, { parametrization: 'uniform' });
    if (!s.ok) throw s.error;
    return s.value;
  };
  const checks = (surface: NurbsSurface, inflections?: { u?: number; v?: number }) => {
    const r = checkSurfaceQuality({
      surfaces: [{ name: 'flare', surface, ...(inflections === undefined ? {} : { inflections }) }],
    });
    if (!r.ok) throw r.error;
    return r.value.issues.map((i) => `${i.code}:${(i.detail as { along?: string }).along}`);
  };

  it('passes a declared flare and still fails the same flare with a 0.5 mm ripple', () => {
    expect(checks(flare(0))).toEqual(['surface-fairness:v']);
    expect(checks(flare(0), { v: 1 })).toEqual([]);
    expect(checks(flare(0.0005), { v: 1 }).length).toBeGreaterThan(0);
    // The allowance is per patch and direction: it does not relax u.
    expect(checks(flare(0.0005), { v: 1 }).some((c) => c.endsWith(':u'))).toBe(true);
  });

  it('records the allowance with m.surface patches', () => {
    const m = model();
    m.surface({
      patches: [{ name: 'flare', surface: flare(0), inflections: { v: 1 } }],
      chord: 0.002,
    });
    expect(m.diagnostics().surfaces[0]?.inflections).toEqual({ v: 1 });
    expect(
      m.validate({ surfaceQuality: true }).issues.filter((i) => i.code === 'surface-quality'),
    ).toEqual([]);
    const bad = checkSurfaceQuality({
      surfaces: [{ name: 'f', surface: flare(0), inflections: { v: -1 } }],
    });
    expect(bad.ok).toBe(false);
  });
});

describe('designed feature-line inflections', () => {
  const s = Array.from(
    { length: 13 },
    (_, i): Tuple3 => [i / 6, 0, 0.05 * Math.sin((Math.PI * i) / 6)],
  );
  // The falsifier: the same S with an accidental wiggle near its start.
  const wiggle = s.map(([x, y, z]): Tuple3 => [x, y, z + (x < 0.5 ? 0.004 * Math.sin(x * 40) : 0)]);
  const issues = (
    points: readonly Tuple3[],
    inflections?: readonly (readonly [number, number])[],
  ) => {
    const m = model();
    expect(
      m.featureLine({ name: 'sill', curve: curve(points), ...(inflections ? { inflections } : {}) })
        .status,
    ).toBe('ok');
    return m
      .validate({ surfaceQuality: {} })
      .issues.filter((i) => i.code === 'surface-quality' && i.detail.check === 'curve-inflection');
  };

  it('accepts the S-curve a line declares and reports it as designed', () => {
    expect(issues(s)).toHaveLength(1);
    expect(issues(s, [[0.4, 0.6]])).toEqual([]);
    const f = curveFairness({ name: 'sill', curve: curve(s), inflections: [[0.4, 0.6]] });
    if (!f.ok) throw f.error;
    expect(f.value.pass).toBe(true);
    expect(f.value.inflections).toEqual([]);
    expect(f.value.designed.map((p) => Math.round(p.t * 10) / 10)).toEqual([0.5]);
  });

  it('still fails an accidental inflection outside the declared ranges, or a range in the wrong place', () => {
    const accidental = issues(wiggle, [[0.4, 0.6]]);
    expect(accidental).toHaveLength(1);
    const places = accidental[0]?.detail.inflections as readonly { t: number }[];
    expect(places.map((p) => p.t < 0.1)).toEqual([true]);
    expect(issues(s, [[0.1, 0.2]])).toHaveLength(1);
    // One range holds one inflection: two inside it still fail.
    expect(issues(wiggle, [[0, 0.6]])).toHaveLength(1);
  });

  it('rejects malformed ranges when the line is declared', () => {
    for (const bad of [[[0.6, 0.4]], [[-0.1, 0.2]], [[0.2, 1.5]], [[0.1]]]) {
      const m = model();
      const op = m.featureLine({
        name: 'sill',
        curve: curve(s),
        inflections: bad as unknown as readonly (readonly [number, number])[],
      });
      expect(op.error?.code).toBe('model-invalid-argument');
    }
  });
});
