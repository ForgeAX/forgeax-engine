import { describe, expect, it } from 'vitest';
import { blendSurfaces, resolveBlends } from '../blend';
import { checkEdgeFlow } from '../edge-flow';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';
import type { Point2 } from '../primitives';
import { region2d } from '../region2d';
import { sel } from '../selectors';
import { splitAlong } from '../surface';
import { checkSurfaceQuality, D09_CLASSES, isoparm } from '../surface-quality';

/** Bicubic patch of z = f(x, y) over x0..x1, y in [-0.5, 0.5]; exact for cubic f. */
function patch(x0: number, x1: number, f: (x: number, y: number) => number): NurbsSurface {
  const rows = [0, 1, 2, 3].map((i) =>
    [0, 1, 2, 3].map((j): Tuple3 => {
      const x = x0 + ((x1 - x0) * i) / 3;
      const y = -0.5 + j / 3;
      return [x, y, f(x, y)];
    }),
  );
  const s = nurbs.grid(rows, { parametrization: 'uniform' });
  if (!s.ok) throw s.error;
  return s.value;
}

const crown = (y: number) => 0.06 * (1 - y * y);
const hood = patch(-0.4, 0, (x, y) => crown(y) + 0.05 * x);
const fender = patch(0, 0.4, (x, y) => crown(y) - 0.4 * x - 0.3 * x * x);

/** The blend between two patches, each trimmed by its region, for the quality checks. */
function trimmedSet(
  a: NurbsSurface,
  b: NurbsSurface,
  result: { trimA: readonly Point2[]; trimB: readonly Point2[]; blend: NurbsSurface },
  names: readonly [string, string, string] = ['a', 'roll', 'b'],
) {
  return [
    { name: names[0], surface: a, trims: [result.trimA] },
    {
      name: names[1],
      surface: result.blend,
      transition: { kind: 'blend' as const, continuity: 'G1' as const },
    },
    { name: names[2], surface: b, trims: [result.trimB] },
  ];
}

const edgeList = (edges: readonly { a: string; sideA: string; b: string; achieved: string }[]) =>
  edges.map((e) => `${e.a}:${e.sideA}|${e.b}:${e.achieved}`).sort();

/** A patch through 7 x 7 points of z = f(x, y) over x0..x1, y in [-0.5, 0.5]. */
function wavy(x0: number, x1: number, f: (x: number, y: number) => number): NurbsSurface {
  const rows = Array.from({ length: 7 }, (_, i) =>
    Array.from({ length: 7 }, (_, j): Tuple3 => {
      const x = x0 + ((x1 - x0) * i) / 6;
      const y = -0.5 + j / 6;
      return [x, y, f(x, y)];
    }),
  );
  const s = nurbs.grid(rows, { parametrization: 'uniform' });
  if (!s.ok) throw s.error;
  return s.value;
}

describe('surface blend', () => {
  it('rolls a constant-radius G1 fillet and trims both sides up to its contact curves', () => {
    const r = 0.004;
    const result = blendSurfaces(hood, fender, { radius: r });
    if (!result.ok) throw result.error;
    expect(result.value.sides).toEqual(['u1', 'u0']);
    // Planar wedge estimate r cot(opening / 2) for the kink between slopes 0.05 and -0.4.
    const kink = Math.atan(0.05) - Math.atan(-0.4);
    const setback = r * Math.tan(kink / 2);
    expect(result.value.setback[0]).toBeGreaterThan(setback * 0.8);
    expect(result.value.setback[1]).toBeLessThan(setback * 1.25);
    expect(result.value.gap).toBeLessThanOrEqual(5e-6);
    // Each trim is the strip from the contact curve over the shared side (hood's u1, fender's u0).
    const { trimA, trimB } = result.value;
    expect(region2d.contains(trimA, [0.9999, 0.5])).toBe(true);
    expect(region2d.contains(trimA, [0.9, 0.5])).toBe(false);
    expect(region2d.contains(trimB, [0.0001, 0.5])).toBe(true);
    expect(region2d.contains(trimB, [0.1, 0.5])).toBe(false);
    expect(region2d.area(trimA)).toBeGreaterThan(0);
    const report = checkSurfaceQuality({
      surfaces: trimmedSet(hood, fender, result.value, ['hood', 'blend', 'fender']),
    });
    if (!report.ok) throw report.error;
    expect(edgeList(report.value.edges)).toEqual(['fender:trim|blend:G1', 'hood:trim|blend:G1']);
    expect(report.value.edges.every((e) => e.class === 'blend')).toBe(true);
  });

  it('matches cross curvature at both contacts with a G2 blend', () => {
    const result = blendSurfaces(hood, fender, { radius: 0.004, continuity: 'G2' });
    if (!result.ok) throw result.error;
    expect(result.value.blend.degreeV).toBe(5);
    const report = checkSurfaceQuality(
      { surfaces: trimmedSet(hood, fender, result.value) },
      { continuity: 'G2', angle: 0.5 },
    );
    if (!report.ok) throw report.error;
    expect(report.value.edges.map((e) => e.achieved)).toEqual(['G2', 'G2']);
  });

  it('fits only the blend, adding control points until its contacts lie within tolerance / 2', () => {
    // A crease that waves along its length: 8 control points leave the contacts off the trims.
    const wave = (y: number) => 0.03 * Math.sin(3 * y);
    const a = wavy(-0.4, 0, (x, y) => wave(y) + 0.05 * x);
    const b = wavy(0, 0.4, (x, y) => wave(y) - 0.4 * x - 0.3 * x * x);
    const blend = { between: ['a', 'b'] as const, radius: 0.012, continuity: 'G2' as const };
    const fit = blendSurfaces(a, b, blend);
    const fixed = blendSurfaces(a, b, { ...blend, controlPoints: 8 });
    if (!fit.ok || !fixed.ok) throw new Error('blend failed');
    expect(fit.value.gap).toBeLessThanOrEqual(5e-6);
    expect(fit.value.blend.points.length).toBeGreaterThan(8);
    expect(fixed.value.gap).toBeGreaterThan(1e-5);
    // The trim edges are judged at the surface-quality limits (position 1e-5): the adaptive fit passes, and
    // the falsifier (8 fixed control points) fails `position` on both contacts.
    const continuity = (controlPoints?: number, quality: object = { classes: D09_CLASSES }) => {
      const m = model();
      m.surface({
        patches: [
          { name: 'a', surface: a },
          { name: 'b', surface: b },
        ],
        blends: [
          { ...blend, name: 'roll', ...(controlPoints === undefined ? {} : { controlPoints }) },
        ],
        chord: 0.0005,
      });
      expect(m.poisoned).toBeUndefined();
      return m
        .validate({ surfaceQuality: { ...quality, continuity: 'G2' } })
        .issues.filter(
          (i) =>
            i.code === 'surface-quality' &&
            (i.detail as { check?: string }).check === 'surface-continuity',
        )
        .map((i) => (i.detail as { subject: string }).subject);
    };
    expect(continuity()).toEqual([]);
    expect(continuity(8).sort()).toEqual(['a:trim0|roll:v0', 'b:trim0|roll:v1']);
    // A fit that stops above its gap is a finding at the default limits too: the blend's
    // declared gap (tolerance / 2) is the position limit of its trim edges.
    expect(continuity(undefined, {})).toEqual([]);
    expect(continuity(8, {}).sort()).toEqual(['a:trim0|roll:v0', 'b:trim0|roll:v1']);
  });

  it('varies the radius along the edge', () => {
    const result = blendSurfaces(hood, fender, {
      radius: [
        [0, 0.002],
        [1, 0.005],
      ],
    });
    if (!result.ok) throw result.error;
    expect(result.value.setback[1] / result.value.setback[0]).toBeGreaterThan(2);
  });

  it('tessellates the blended patches watertight inside one surface call, faces as designed', () => {
    const patches = [
      { name: 'hood', surface: hood },
      { name: 'fender', surface: fender },
    ];
    const blends = [{ between: ['hood', 'fender'] as const, radius: 0.003, name: 'shoulder' }];
    const m = model();
    const report = m.surface({ patches, blends, chord: 0.0005 });
    if (report.status !== 'ok')
      console.log(
        'POISON',
        m.poisoned?.message,
        JSON.stringify((m.poisoned as { detail?: unknown } | undefined)?.detail)?.slice(0, 900),
      );
    expect(report.status).toBe('ok');
    const surfaces = m.diagnostics().surfaces;
    expect(surfaces.map((s) => s.name)).toEqual(['hood', 'fender', 'shoulder']);
    // The design faces are the input surfaces, byte for byte, each with its trim.
    for (const [k, p] of patches.entries()) {
      expect(surfaces[k]?.surface).toBe(p.surface);
      expect(JSON.stringify(surfaces[k]?.surface)).toBe(JSON.stringify(p.surface));
      expect(surfaces[k]?.trims).toHaveLength(1);
    }
    const check = m.validate();
    expect(check.issues.filter((i) => i.severity !== 'info').map((i) => i.code)).toEqual([]);
    expect(check.vertices - check.edges + check.faces).toBe(1);
    const quality = m.validate({ surfaceQuality: true });
    expect(quality.issues.filter((i) => i.code === 'surface-quality')).toEqual([]);
    // The cells along the seams are edge flow's own `trim` group (never `support`): the band's
    // isoparms are pinned to the faces' crossings of the outlines, so they are clean halves of
    // grid cells; a tighter bound makes them a finding.
    const flow = checkEdgeFlow(m.editMesh, []);
    if (!flow.ok) throw flow.error;
    const { trim } = flow.value;
    expect(trim.faces).toBeGreaterThan(0);
    expect(trim.aspect.over).toBe(0);
    expect(trim.sizeRatio.over).toBe(0);
    const tight = checkEdgeFlow(m.editMesh, [], { maxTrimAspect: 1.5 });
    if (!tight.ok) throw tight.error;
    expect(tight.value.issues.map((i) => i.code)).toContain('trim-aspect');
    // Falsifier: the same trimmed faces and blend without the shared call's trim conformity
    // (tessellated apart) leave the seams with T-junctions.
    const resolved = resolveBlends(patches, blends);
    if (!resolved.ok) throw resolved.error;
    const apart = model();
    for (const p of resolved.value.patches) apart.surface({ patches: [p], chord: 0.0005 });
    expect(apart.validate().issues.map((i) => i.code)).toContain('t-junction');
  });

  it('refuses tangent joints, oversized radii and unknown patches', () => {
    const smooth = blendSurfaces(
      patch(-0.4, 0, (x) => 0.1 * x),
      patch(0, 0.4, (x) => 0.1 * x),
      { radius: 0.003 },
    );
    expect(!smooth.ok && smooth.error.code).toBe('model-precondition');
    const huge = blendSurfaces(hood, fender, { radius: 50 });
    expect(!huge.ok && huge.error.code).toBe('model-precondition');
    expect(blendSurfaces(hood, fender, { radius: -1 }).ok).toBe(false);
    const apart = blendSurfaces(
      hood,
      patch(1, 2, () => 0),
      { radius: 0.003 },
    );
    expect(!apart.ok && apart.error.code).toBe('model-precondition');
    const m = model();
    const bad = m.surface({
      patches: [{ name: 'hood', surface: hood }],
      blends: [{ between: ['hood', 'nope'], radius: 0.003 }],
    });
    expect(bad.error?.code).toBe('model-invalid-argument');
    // A blended face keeps its domain, so its { uv } trims still mean what they say.
    const domain = model();
    const domainTrim = domain.surface({
      patches: [
        {
          name: 'hood',
          surface: hood,
          trims: [
            {
              uv: [
                [0.4, 0.4],
                [0.6, 0.4],
                [0.6, 0.6],
              ],
            },
          ],
        },
        { name: 'fender', surface: fender },
      ],
      blends: [{ between: ['hood', 'fender'], radius: 0.003 }],
      chord: 0.001,
    });
    if (domainTrim.status !== 'ok')
      console.log(
        'POISON',
        domain.poisoned?.message,
        JSON.stringify((domain.poisoned as { detail?: unknown } | undefined)?.detail)?.slice(
          0,
          900,
        ),
      );
    if (domainTrim.status !== 'ok')
      console.log(
        'POISON',
        domain.poisoned?.message,
        JSON.stringify((domain.poisoned as { detail?: unknown } | undefined)?.detail)?.slice(
          0,
          600,
        ),
      );
    expect(domainTrim.status).toBe('ok');
    expect(domain.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const viewTrim = model();
    const cut = viewTrim.surface({
      patches: [
        {
          name: 'hood',
          surface: hood,
          trims: [
            {
              view: 'top',
              region: [
                [-0.3, 0.1],
                [-0.1, 0.1],
                [-0.1, -0.1],
                [-0.3, -0.1],
              ],
            },
          ],
        },
        { name: 'fender', surface: fender },
      ],
      blends: [{ between: ['hood', 'fender'], radius: 0.003 }],
      chord: 0.001,
    });
    expect(cut.status).toBe('ok');
    expect(viewTrim.count(sel.tag('trim'))).toBeGreaterThan(0);
  });
});

/** A bilinear patch through four corners: [u0v0, u0v1], [u1v0, u1v1]. */
function quad(a: Tuple3, b: Tuple3, c: Tuple3, d: Tuple3): NurbsSurface {
  return {
    degreeU: 1,
    degreeV: 1,
    points: [
      [a, b],
      [c, d],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

describe('surface blend at slanted ends', () => {
  // A crease along x; `a` ends square, `b`'s ends slant inward (its edge x runs 0.3 per meter
  // up it), so at the end stations the ball's contact on `b` would fall past b's end.
  const a = quad([0, 0, 0], [0, -0.2, 0], [1, 0, 0], [1, -0.2, 0]);
  const b = quad([0, 0, 0], [0.06, 0, 0.2], [1, 0, 0], [0.94, 0, 0.2]);

  it('holds the contact on b at its end and moves a inside, instead of failing the end station', () => {
    const result = blendSurfaces(a, b, { radius: 0.01 });
    if (!result.ok) throw result.error;
    // The planar 90 degree crease sets back r, measured along b's slanted side up to r / cos.
    expect(result.value.setback[0]).toBeGreaterThan(0.0099);
    expect(result.value.setback[1]).toBeLessThan(0.0101 * Math.hypot(1, 0.3));
    expect(result.value.gap).toBeLessThan(5e-6);
  });

  it('gives the blend the inflections its patches declare along the shared side', () => {
    const r = resolveBlends(
      [
        { name: 'a', surface: a, inflections: { u: 1 } },
        { name: 'b', surface: b },
      ],
      [{ between: ['a', 'b'], radius: 0.01, name: 'ab' }],
    );
    if (!r.ok) throw r.error;
    expect(r.value.patches.find((p) => p.name === 'ab')?.inflections).toEqual({ u: 1 });
  });
});

describe('blend run-out and sub-range', () => {
  // A 90 degree crease along x from 0 to 1 (consistently oriented): the ball of radius r sets
  // back r on both sides.
  const a = quad([0, 0, 0], [0, -0.2, 0], [1, 0, 0], [1, -0.2, 0]);
  const b = quad([0, 0, 0.2], [0, 0, 0], [1, 0, 0.2], [1, 0, 0]);
  const r = 0.01;
  /** The C2 cubic step of a run-out (blend.ts `step`). */
  const smooth = (s: number) => {
    const x = 3 * s;
    if (x <= 1) return (x * x * x) / 6;
    if (x <= 2) return (x * (x * (9 - 2 * x) - 9) + 3) / 6;
    return 1 - ((3 - x) * (3 - x) * (3 - x)) / 6;
  };
  const at = (s: NurbsSurface, u: number, v: number) => nurbs.surfacePoint(s, u, v);
  /** The u end of the blend at x = 1 (orientation may reverse u). */
  const tipU = (blend: NurbsSurface) => {
    const [[u0, u1]] = nurbs.surfaceDomain(blend);
    return Math.abs(at(blend, u0, 0)[0] - 1) < 1e-9 ? u0 : u1;
  };
  /** Angle (degrees) of the blend's contact side on `a` against the crease at its x = 1 end. */
  const endAngle = (blend: NurbsSurface) => {
    const [, [v0, v1]] = nurbs.surfaceDomain(blend);
    const u = tipU(blend);
    const contact = [v0, v1].find((v) => Math.abs(at(blend, 0.5, v)[2]) < 1e-9);
    const d = nurbs.surfaceDerivatives(blend, u, contact as number, 1);
    const du = (d[1] as Tuple3[])[0] as Tuple3;
    return (Math.atan2(Math.hypot(du[1], du[2]), Math.abs(du[0])) * 180) / Math.PI;
  };

  it('runs a fillet out to zero at an end with a G2 eased radius', () => {
    const result = blendSurfaces(a, b, {
      radius: [
        [0, r],
        [0.7, r],
        [1, 0],
      ],
    });
    if (!result.ok) throw result.error;
    const { blend } = result.value;
    expect(result.value.setback[0]).toBe(0);
    expect(result.value.setback[1]).toBeCloseTo(r, 6);
    const [[u0, u1], [v0, v1]] = nurbs.surfaceDomain(blend);
    expect([u0, u1]).toEqual([0, 1]);
    // The run-out end is one point; the contact on `a` follows r(t) = r (1 - step), and never
    // crosses the crease.
    const tip = blend.points[tipU(blend) === u0 ? 0 : blend.points.length - 1] as readonly Tuple3[];
    expect(tip.every((p) => Math.hypot(p[0] - 1, p[1], p[2]) <= 1e-9)).toBe(true);
    const c = [v0, v1].find((v) => Math.abs(at(blend, 0.5, v)[2]) < 1e-9) as number;
    for (let k = 0; k <= 200; k++) {
      const p = at(blend, k / 200, c);
      if (p[0] < 0.7) continue;
      expect(Math.abs(-p[1] - r * (1 - smooth((p[0] - 0.7) / 0.3)))).toBeLessThan(0.01 * r);
      expect(p[1]).toBeLessThanOrEqual(1e-9);
    }
    expect(endAngle(blend)).toBeLessThan(0.1);
    // Falsifier: a linear segment to a tiny radius leaves the crease at an angle.
    const linear = blendSurfaces(a, b, {
      radius: [
        [0, r],
        [0.7, r],
        [1, 1e-6],
      ],
    });
    if (!linear.ok) throw linear.error;
    expect(endAngle(linear.value.blend)).toBeGreaterThan(1);
  });

  it('blends part of a side and keeps the crease outside the range', () => {
    const result = blendSurfaces(a, b, {
      radius: [
        [0.2, 0],
        [0.35, r],
        [0.7, r],
        [0.85, 0],
      ],
      continuity: 'G2',
    });
    if (!result.ok) throw result.error;
    const [[u0, u1]] = nurbs.surfaceDomain(result.value.blend);
    expect(u0).toBeCloseTo(0.2, 12);
    expect(u1).toBeCloseTo(0.85, 12);
    expect(result.value.gap).toBeLessThan(5e-6);
    // The trim covers the crease only over the blended range (a's crease is its v0 side).
    for (const x of [0, 0.1, 0.18, 0.88, 0.95, 1])
      expect(region2d.contains(result.value.trimA, [x, 1e-4])).toBe(false);
    expect(region2d.contains(result.value.trimA, [0.5, 1e-4])).toBe(true);
    expect(region2d.contains(result.value.trimA, [0.5, (0.9 * r) / 0.2])).toBe(true);
  });

  it('refuses a zero between positive stations and a run-out of no length', () => {
    for (const radius of [
      [
        [0, r],
        [0.5, 0],
        [1, r],
      ],
      [
        [0, 0],
        [1, 0],
      ],
      [
        [0.3, 0],
        [0.3, r],
        [1, r],
      ],
    ] as const) {
      const result = blendSurfaces(a, b, { radius });
      expect(!result.ok && result.error.code).toBe('model-invalid-argument');
    }
    const zero = blendSurfaces(a, b, { radius: 0 });
    expect(!zero.ok && zero.error.code).toBe('model-invalid-argument');
  });

  it('checks a partly blended side part by part: the crease at G0, the contacts at G2', () => {
    const result = blendSurfaces(a, b, {
      radius: [
        [0.2, 0],
        [0.35, r],
        [0.7, r],
        [1, 0],
      ],
      continuity: 'G2',
    });
    if (!result.ok) throw result.error;
    const crease = nurbs.interpolate([
      [0, 0, 0],
      [0.5, 0, 0],
      [1, 0, 0],
    ]);
    if (!crease.ok) throw crease.error;
    const check = (blend: NurbsSurface) => {
      const report = checkSurfaceQuality(
        {
          surfaces: trimmedSet(a, b, { ...result.value, blend }),
          curves: [{ name: 'crease', curve: crease.value, continuity: 'G0' }],
        },
        // Dense samples reach the run-out tips, where the band is narrower than the position limit.
        { continuity: 'G2', samples: 128 },
      );
      if (!report.ok) throw report.error;
      return report.value;
    };
    const clean = check(result.value.blend);
    expect(clean.issues.filter((i) => i.code === 'surface-continuity')).toEqual([]);
    const edges = clean.edges.map((e) => `${e.a}|${e.b}:${e.achieved}/${e.required}`);
    // The crease outside the range is measured as built, the contacts along the trims.
    expect(edges).toContain('a|b:G0/G0');
    expect(
      edges.filter((e) => e.startsWith('a|roll:G2') || e.startsWith('b|roll:G2')),
    ).toHaveLength(2);
    // Falsifier: a kink inside the range (the blend's second row lifted mid-range) still fails.
    const blend = result.value.blend;
    const mid = Math.floor(blend.points.length / 2);
    const kinked: NurbsSurface = {
      ...blend,
      points: blend.points.map((column, i) =>
        i === mid
          ? column.map((p, j): Tuple3 => (j === 1 ? [p[0], p[1] - 0.002, p[2] + 0.002] : p))
          : column,
      ),
    };
    const bad = check(kinked).issues.filter((i) => i.code === 'surface-continuity');
    expect(bad.length).toBeGreaterThan(0);
  });

  it('reports no false continuity at a curved run-out tip, even densely sampled', () => {
    // Regression: below the position limit the tip's band paired with its own far side and
    // with b's side (G0 at 13-25 degrees), and fit noise read as a 13 degree kink.
    for (const radius of [
      [
        [0, 0.012],
        [0.55, 0.012],
        [1, 0],
      ],
      [
        [0, 0],
        [0.45, 0.012],
        [1, 0.012],
      ],
    ] as const) {
      const result = blendSurfaces(hood, fender, { radius, continuity: 'G2', stations: 33 });
      if (!result.ok) throw result.error;
      const report = checkSurfaceQuality(
        { surfaces: trimmedSet(hood, fender, result.value) },
        { samples: 128 },
      );
      if (!report.ok) throw report.error;
      expect(report.value.issues.filter((i) => i.code === 'surface-continuity')).toEqual([]);
      const edges = report.value.edges.map((e) => `${e.a}|${e.b}`).sort();
      expect(edges).toEqual(['a|roll', 'b|roll']);
      // The tip's samples are left out, and counted.
      expect(report.value.edges.every((e) => e.skipped > 0)).toBe(true);
    }
  });

  it('holds G2 at both contacts up to the tip zone of a run-out between curved patches', () => {
    // Regression: six knot spans per run-out lost the cross curvature carried by the sections
    // just outside the tip zone (G1 on the fender contact, 0.93 1/m against a 5 % limit).
    const result = blendSurfaces(hood, fender, {
      radius: [
        [0, 0.012],
        [0.55, 0.012],
        [1, 0],
      ],
      continuity: 'G2',
      stations: 33,
    });
    if (!result.ok) throw result.error;
    const [onA, roll, onB] = trimmedSet(hood, fender, result.value);
    const report = checkSurfaceQuality(
      {
        surfaces: [
          onA,
          { ...roll, transition: { kind: 'blend' as const, continuity: 'G2' as const } },
          onB,
        ] as never,
      },
      { samples: 256 },
    );
    if (!report.ok) throw report.error;
    expect(report.value.issues.filter((i) => i.code === 'surface-continuity')).toEqual([]);
    expect(edgeList(report.value.edges)).toEqual(['a:trim|roll:G2', 'b:trim|roll:G2']);
  });

  it('skips only a declared run-out tip, and only where the band lies flat (audit A5)', () => {
    const surfaces = (result: {
      trimA: readonly Point2[];
      trimB: readonly Point2[];
      blend: NurbsSurface;
    }) =>
      trimmedSet(a, b, result).map((x) =>
        x.transition === undefined
          ? x
          : { ...x, transition: { kind: 'blend' as const, continuity: 'G2' as const } },
      );
    // A ramp from 0.5 to 60 mm never reaches zero: nothing is a tip, however narrow (the
    // ramp itself is a hard fit: what fails there is measured, never skipped).
    const ramp = blendSurfaces(a, b, {
      radius: [
        [0, 0.0005],
        [0.5, 0.0005],
        [1, 0.06],
      ],
      continuity: 'G2',
    });
    if (!ramp.ok) throw ramp.error;
    const rampReport = checkSurfaceQuality({ surfaces: surfaces(ramp.value) }, { samples: 128 });
    if (!rampReport.ok) throw rampReport.error;
    expect(rampReport.value.edges.length).toBeGreaterThan(0);
    expect(rampReport.value.edges.every((e) => e.skipped === 0)).toBe(true);
    // A real run-out skips its tip at G2, but a bulge of the band there is a defect.
    const runOut = blendSurfaces(a, b, {
      radius: [
        [0, r],
        [0.4, r],
        [1, 0],
      ],
      continuity: 'G2',
    });
    if (!runOut.ok) throw runOut.error;
    const clean = checkSurfaceQuality(
      { surfaces: surfaces(runOut.value) },
      { samples: 128, continuity: 'G2' },
    );
    if (!clean.ok) throw clean.error;
    expect(clean.value.issues.filter((i) => i.code === 'surface-continuity')).toEqual([]);
    expect(clean.value.edges.some((e) => e.skipped > 0)).toBe(true);
    const blend = runOut.value.blend;
    const tip =
      Math.abs(nurbs.surfacePoint(blend, 0, 0)[0] - 1) < 1e-9 ? 1 : blend.points.length - 2;
    const lifted: NurbsSurface = {
      ...blend,
      points: blend.points.map((column, i) =>
        i === tip
          ? column.map((p, j): Tuple3 => (j === 2 ? [p[0], p[1] - 0.0004, p[2] + 0.0004] : p))
          : column,
      ),
    };
    const bulged = checkSurfaceQuality(
      { surfaces: surfaces({ ...runOut.value, blend: lifted }) },
      { samples: 128, continuity: 'G2' },
    );
    if (!bulged.ok) throw bulged.error;
    expect(
      bulged.value.issues.filter((i) => i.code === 'surface-continuity').length,
    ).toBeGreaterThan(0);
  });

  it('reports a shared part lying wholly at a run-out tip as nothing-checked, never a pass', () => {
    const result = blendSurfaces(a, b, {
      radius: [
        [0, r],
        [0.7, r],
        [1, 0],
      ],
    });
    if (!result.ok) throw result.error;
    // The last 2 % of b along the crease (to the tip at x = 1) meets only the tip, where the
    // band is under 1 % of its width.
    const split = nurbs.surface.split(b, 'u', 0.98);
    if (!split.ok) throw split.error;
    const report = checkSurfaceQuality({
      surfaces: [
        { name: 'tip', surface: split.value[1] },
        {
          name: 'roll',
          surface: result.value.blend,
          transition: { kind: 'blend' as const, continuity: 'G1' as const },
        },
      ],
    });
    if (!report.ok) throw report.error;
    expect(report.value.pass).toBe(false);
    expect(report.value.edges).toEqual([]);
    expect(report.value.issues.filter((i) => i.code === 'nothing-checked').length).toBeGreaterThan(
      0,
    );
  });

  it('tessellates run-outs and sub-ranges watertight, with no hole at the tips', {
    timeout: 60_000,
  }, () => {
    for (const radius of [
      [
        [0, r],
        [0.6, r],
        [1, 0],
      ],
      [
        [0.2, 0],
        [0.4, r],
        [0.6, r],
        [0.8, 0],
      ],
    ] as const) {
      const m = model();
      const report = m.surface({
        patches: [
          { name: 'a', surface: a },
          { name: 'b', surface: b },
        ],
        blends: [{ between: ['a', 'b'], radius, continuity: 'G2', name: 'roll' }],
        chord: 0.0005,
      });
      expect(report.status).toBe('ok');
      const check = m.validate();
      expect(check.issues.filter((i) => i.severity !== 'info').map((i) => i.code)).toEqual([]);
      // One disc: Euler characteristic 1 (a hole at a tip would make it 0).
      expect(check.vertices - check.edges + check.faces).toBe(1);
      expect(m.finish({ key: 'roll' }).ok).toBe(true);
    }
  });
});

describe('blend trims composed with other trims', () => {
  it('chains two blends on one face: two trims, the face as designed', { timeout: 60_000 }, () => {
    // A three-face channel: floor, wall, top; the wall is blended to both.
    const floor = quad([0, 0, 0], [0, -0.2, 0], [1, 0, 0], [1, -0.2, 0]);
    const wall = quad([0, 0, 0.2], [0, 0, 0], [1, 0, 0.2], [1, 0, 0]);
    const top = quad([0, -0.2, 0.2], [0, 0, 0.2], [1, -0.2, 0.2], [1, 0, 0.2]);
    const patches = [
      { name: 'floor', surface: floor },
      { name: 'wall', surface: wall },
      { name: 'top', surface: top },
    ];
    const m = model();
    const report = m.surface({
      patches,
      blends: [
        { between: ['floor', 'wall'], radius: 0.01, continuity: 'G2', name: 'low' },
        { between: ['wall', 'top'], radius: 0.01, continuity: 'G2', name: 'high' },
      ],
      chord: 0.0005,
    });
    expect(report.status).toBe('ok');
    const surfaces = m.diagnostics().surfaces;
    for (const [k, p] of patches.entries()) expect(surfaces[k]?.surface).toBe(p.surface);
    expect(surfaces.map((s) => s.trims?.length ?? 0)).toEqual([1, 2, 1, 0, 0]);
    const check = m.validate();
    expect(check.issues.filter((i) => i.severity !== 'info').map((i) => i.code)).toEqual([]);
    expect(check.vertices - check.edges + check.faces).toBe(1);
    const quality = m.validate({ surfaceQuality: { continuity: 'G2' } });
    expect(
      quality.issues.filter((i) => (i.detail as { check?: string }).check === 'surface-continuity'),
    ).toEqual([]);
  });

  it('keeps a shut line across a blended face at its gap up to the contact curve', {
    timeout: 60_000,
  }, () => {
    const gap = 0.004;
    const resolved = resolveBlends(
      [
        { name: 'hood', surface: hood },
        { name: 'fender', surface: fender },
      ],
      [{ between: ['hood', 'fender'], radius: 0.004, name: 'shoulder' }],
    );
    if (!resolved.ok) throw resolved.error;
    const [blended, side, roll] = resolved.value.patches as [
      (typeof resolved.value.patches)[number],
      (typeof resolved.value.patches)[number],
      (typeof resolved.value.patches)[number],
    ];
    // The shut line runs across the hood at y = 0, from its far side over the crease: each half
    // keeps the hood's surface and trims the blend strip and the other half (overlapping).
    const halves = splitAlong(
      blended,
      { curve: isoparm(hood, 'u', 0.5) },
      { gap, names: ['front', 'rear'] },
    );
    if (!halves.ok) throw halves.error;
    const m = model();
    expect(
      m.surface({ patches: [halves.value.a, halves.value.b, side, roll], chord: 0.0005 }).status,
    ).toBe('ok');
    const surfaces = m.diagnostics().surfaces;
    expect(surfaces[0]?.surface).toBe(hood);
    expect(surfaces[1]?.surface).toBe(hood);
    // The overlapping trims are recorded as their union: one outline per half.
    expect(surfaces[0]?.trims).toHaveLength(1);
    const check = m.validate();
    for (const i of check.issues)
      if (i.code === 't-junction')
        console.log(
          'TJ',
          JSON.stringify(
            ((i.detail as { vertices?: number[] }).vertices ?? []).map((v: number) =>
              m.editMesh.position(v),
            ),
          ),
        );
    expect(check.issues.filter((i) => i.severity !== 'info').map((i) => i.code)).toEqual([]);
    // Every open vertex of the front half (left of the cut in the domain: y > 0) beside the
    // shut line lies on it (y = gap / 2), right up to the contact curve: the gap stays
    // constant across the blend's trim.
    const mesh = m.editMesh;
    const front = mesh.tagIndex('front', false);
    const onShut = new Set<number>();
    for (const e of mesh.edges()) {
      if (!mesh.isBoundaryEdge(e)) continue;
      for (const v of mesh.edgeVertices(e)) {
        const p = mesh.position(v);
        if (Math.abs(p[1] - gap / 2) < 0.001) onShut.add(v);
      }
    }
    const faces = mesh.faces().filter((f) => mesh.hasTag(f, front));
    const used = new Set(faces.flatMap((f) => mesh.faceVertices(f)));
    const shut = [...onShut].filter((v) => used.has(v));
    expect(shut.length).toBeGreaterThanOrEqual(2);
    for (const v of shut)
      expect(Math.abs((mesh.position(v)[1] as number) - gap / 2)).toBeLessThan(2e-5);
    const reach = Math.max(...shut.map((v) => mesh.position(v)[0] as number));
    expect(reach).toBeGreaterThan(-0.001);
  });
});
