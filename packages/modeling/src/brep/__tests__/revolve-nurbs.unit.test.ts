import { describe, expect, it } from 'vitest';
import { curvePoint, domain, type NurbsCurve } from '../../nurbs';
import { booleanSolids } from '../boolean';
import { box } from '../build';
import { measure } from '../measure';
import { circularPattern } from '../pattern';
import { quadrangulate } from '../quad';
import { sectionByPlane } from '../query/section';
import { nurbsSegment, type ProfileSegment, revolveProfile } from '../revolve-profile';
import { tessellate } from '../tessellate';
import { IDENTITY_PLACEMENT, transformShape } from '../transform';
import type { Shape } from '../types';
import { validate } from '../validate';
import { boundaryEdges } from './support';

const PI = Math.PI;

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** Vase body: an open profile from the base corner (0.4, 0) to the mouth corner (0.5, 2.4). */
const BODY: [number, number][] = [
  [0.4, 0],
  [0.7, 0.6],
  [0.7, 1.2],
  [0.7, 1.8],
  [0.5, 2.4],
];

function vase(): Shape {
  const body = must(nurbsSegment(BODY, { degree: 3 })) as ProfileSegment;
  return must(
    revolveProfile({
      start: [0, 0],
      segments: [{ kind: 'line', to: [0.4, 0] }, body, { kind: 'line', to: [0, 2.4] }],
    }),
  );
}

function bodyCurve(points: [number, number][] = BODY): NurbsCurve {
  return (must(nurbsSegment(points, { degree: 3 })) as { curve: NurbsCurve }).curve;
}

/** Simpson's rule for pi * int r(t)^2 z'(t) dt over the body curve: the solid's exact volume integral. */
function simpsonVolume(curve: NurbsCurve, n = 20000): number {
  const [a, b] = domain(curve);
  const h = 1e-7;
  const f = (t: number): number => {
    const p = curvePoint(curve, t);
    const lo = Math.max(a, t - h);
    const hi = Math.min(b, t + h);
    const r = curvePoint(curve, lo);
    const q = curvePoint(curve, hi);
    const dz = (q[1] - r[1]) / (hi - lo);
    return Math.PI * p[0] * p[0] * dz;
  };
  let sum = f(a) + f(b);
  for (let i = 1; i < n; i++) sum += (i % 2 === 1 ? 4 : 2) * f(a + ((b - a) * i) / n);
  return (sum * (b - a)) / n / 3;
}

describe('revolveProfile NURBS segments', () => {
  it('free-form vase is closed, valid, and watertight', () => {
    const shape = vase();
    const report = validate(shape);
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    expect(report.shells[0]?.euler).toBe(2);
    expect(boundaryEdges(must(tessellate(shape)))).toBe(0);
    expect(shape.faces.map((f) => shape.surfaces[f.surface]?.kind)).toEqual([
      'plane',
      'nurbs',
      'plane',
    ]);
  });

  it('vase volume matches the Simpson integral of pi r^2 dz within the measured quadrature bound', () => {
    // The kernel's NURBS-face volume is quadrature over the rational surface; the frustum check below
    // measures that bound (0.18 % on a straight NURBS line, 0.31 % on its area).
    const volume = must(measure(vase())).volume;
    const reference = simpsonVolume(bodyCurve());
    expect(Math.abs(volume - reference) / reference).toBeLessThan(5e-3);
  });

  it('a degree-1 NURBS line matches the analytic frustum volume within the quadrature bound', () => {
    const line = must(
      nurbsSegment(
        [
          [0.4, 0],
          [0.5, 2.4],
        ],
        { degree: 1 },
      ),
    ) as ProfileSegment;
    const nurbs = must(
      revolveProfile({
        start: [0, 0],
        segments: [{ kind: 'line', to: [0.4, 0] }, line, { kind: 'line', to: [0, 2.4] }],
      }),
    );
    const exact = (PI * 2.4 * (0.4 * 0.4 + 0.4 * 0.5 + 0.5 * 0.5)) / 3;
    const volume = must(measure(nurbs)).volume;
    expect(validate(nurbs).ok).toBe(true);
    expect(Math.abs(volume - exact) / exact).toBeLessThan(5e-3);
  });

  it('nurbsSegment passes the curve through its points, with the given parameters', () => {
    const params = [0, 0.2, 0.5, 0.8, 1];
    const seg = must(nurbsSegment(BODY, { parameters: params })) as { curve: NurbsCurve };
    params.forEach((t, i) => {
      const p = curvePoint(seg.curve, t);
      expect(p[0]).toBeCloseTo(BODY[i]?.[0] as number, 9);
      expect(p[1]).toBeCloseTo(BODY[i]?.[1] as number, 9);
    });
  });

  it('is deterministic: the same profile yields the same measure and digest', () => {
    const a = must(measure(vase())).volume;
    const b = must(measure(vase())).volume;
    expect(a).toBe(b);
  });

  it('refuses a profile whose end points do not match its segment', () => {
    const body = must(nurbsSegment(BODY, { degree: 3 })) as ProfileSegment;
    const r = revolveProfile({
      start: [0, 0],
      segments: [{ kind: 'line', to: [0.3, 0] }, body, { kind: 'line', to: [0, 2.4] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.detail).toMatchObject({ reason: 'nurbs-endpoint-mismatch' });
  });

  it('refuses a free-form profile that crosses the axis', () => {
    const crossing: [number, number][] = [
      [0.4, 0],
      [-0.6, 1.2],
      [0.5, 2.4],
    ];
    const body = must(nurbsSegment(crossing, { degree: 2 })) as ProfileSegment;
    const r = revolveProfile({
      start: [0, 0],
      segments: [{ kind: 'line', to: [0.4, 0] }, body, { kind: 'line', to: [0, 2.4] }],
    });
    expect(r.ok).toBe(false);
  });

  it('refuses a negative-radius control point', () => {
    const body = must(
      nurbsSegment(
        [
          [0.4, 0],
          [-0.2, 1.2],
          [0.5, 2.4],
        ],
        { degree: 2 },
      ),
    ) as ProfileSegment;
    const r = revolveProfile({
      start: [0, 0],
      segments: [{ kind: 'line', to: [0.4, 0] }, body, { kind: 'line', to: [0, 2.4] }],
    });
    expect(r.ok).toBe(false);
  });

  it('refuses a partial sweep for a NURBS profile segment', () => {
    const r = revolveProfile({
      start: [0, 0],
      angle: PI,
      segments: [
        { kind: 'line', to: [0.4, 0] },
        must(nurbsSegment(BODY, { degree: 3 })) as ProfileSegment,
        { kind: 'line', to: [0, 2.4] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.detail).toMatchObject({ reason: 'nurbs-partial-turn' });
  });

  it('mixed line, NURBS and arc profile stitches into one valid shape', () => {
    const body = must(
      nurbsSegment(
        [
          [1, 0],
          [1.2, 0.5],
          [1, 1],
        ],
        { degree: 2 },
      ),
    ) as ProfileSegment;
    const shape = must(
      revolveProfile({
        start: [0, 0],
        segments: [
          { kind: 'line', to: [1, 0] },
          body,
          { kind: 'arc', to: [0.5, 1.5], center: [1, 1.5] },
          { kind: 'line', to: [0, 1.5] },
        ],
      }),
    );
    const report = validate(shape);
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    expect(report.shells[0]?.euler).toBe(2);
    expect(shape.faces.map((f) => shape.surfaces[f.surface]?.kind).sort()).toEqual([
      'nurbs',
      'plane',
      'plane',
      'torus',
    ]);
  });

  it('quad conversion of the vase with the default source is all-quad, watertight, and pinned', () => {
    // Observed on this kernel: quads 64 / 162 / 430 at sizes 0.5 / 0.25 / 0.15, min scaled Jacobian 0.7071.
    const expected: [number, number][] = [
      [0.5, 64],
      [0.25, 162],
      [0.15, 430],
    ];
    for (const [size, quads] of expected) {
      const q = must(quadrangulate(vase(), { size }));
      const r = q.report;
      expect(r.triangles, `size ${size}`).toBe(0);
      expect(r.quads, `size ${size}`).toBe(quads);
      expect(r.openEdges, `size ${size}`).toBe(0);
      expect(r.nonManifoldEdges, `size ${size}`).toBe(0);
      expect(r.degenerate, `size ${size}`).toBe(0);
      expect(r.scaledJacobian.min, `size ${size}`).toBeGreaterThan(0.5);
      // Source face 1 is the revolved NURBS body: its mesh range must be all quads too.
      const [lo, hi] = q.faceRanges[1] ?? [0, 0];
      const bodyFaces = [];
      for (let f = lo; f < hi; f++)
        if (q.mesh.isFaceAlive(f)) bodyFaces.push(q.mesh.faceVertices(f));
      expect(bodyFaces.length, `size ${size}`).toBeGreaterThan(0);
      expect(
        bodyFaces.every((v) => v.length === 4),
        `size ${size}`,
      ).toBe(true);
    }
  });

  it('section through the axis and across the axis both return curves', () => {
    const through = sectionByPlane(vase(), {
      origin: [0, 0, 1.2],
      normal: [1, 0, 0],
    });
    const across = sectionByPlane(vase(), {
      origin: [0, 0, 1.2],
      normal: [0, 0, 1],
    });
    expect(through.ok, through.ok ? '' : JSON.stringify(through.error)).toBe(true);
    expect(across.ok, across.ok ? '' : JSON.stringify(across.error)).toBe(true);
  });

  it('rigid placement keeps the NURBS vase valid and its volume', () => {
    const shape = vase();
    const moved = must(transformShape(shape, { ...IDENTITY_PLACEMENT, t: [3, -2, 1] }));
    expect(validate(moved).ok).toBe(true);
    // Rigid motion preserves the exact volume; the NURBS face keeps the grid quadrature of measure.
    const before = must(measure(shape)).volume;
    expect(Math.abs(must(measure(moved)).volume - before) / before).toBeLessThan(5e-3);
  });

  it('circular pattern of the vase returns valid copies', () => {
    const copies = must(
      circularPattern(vase(), {
        axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
        count: 3,
      }),
    );
    expect(copies).toHaveLength(3);
    for (const c of copies) expect(validate(c).ok).toBe(true);
  });

  it('box boolean with the vase is refused for every operation by the NURBS clip (recorded)', () => {
    // Not an option effect: union, difference and intersect all refuse with the same NURBS-face reason.
    const b = must(box({ size: [1, 1, 1] }));
    for (const op of ['union', 'difference', 'intersect'] as const) {
      const result = booleanSolids(b, vase(), op);
      expect(result.ok, op).toBe(false);
      if (!result.ok) {
        expect(result.error.code, op).toBe('model-partial');
        expect(result.error.detail).toMatchObject({
          brep: 'brep-ssi-unsupported',
          reason: 'clip-crossing-count',
          count: 8,
        });
      }
    }
  });
});
