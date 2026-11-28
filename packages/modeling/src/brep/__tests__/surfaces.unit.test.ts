// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../__tests__/support/fuzz';
import { curvePoint, curveTangent, pcurveFor, pcurvePoint } from '../curves';
import {
  makeFrame,
  surfaceDerivatives,
  surfaceInverse,
  surfaceNormal,
  surfacePoint,
} from '../surfaces';
import type { Curve, Surface } from '../types';

type AnalyticSurface = Exclude<Surface, { kind: 'nurbs' }>;

import { cross3, dist3, dot3, len3, type P3 } from '../vec';

const frame = makeFrame([0.3, -1.2, 2.5], [1, 2, -0.5], [0.2, 0.1, 1]);

/** Independent oracle: local Cartesian coordinates through the frame matrix with Math.sin/Math.cos. */
function local(s: AnalyticSurface, u: number, v: number): P3 {
  switch (s.kind) {
    case 'plane':
      return [u, v, 0];
    case 'cylinder':
      return [s.radius * Math.cos(u), s.radius * Math.sin(u), v];
    case 'sphere':
      return [
        s.radius * Math.cos(v) * Math.cos(u),
        s.radius * Math.cos(v) * Math.sin(u),
        s.radius * Math.sin(v),
      ];
    case 'cone': {
      const r = s.radius + v * Math.sin(s.halfAngle);
      return [r * Math.cos(u), r * Math.sin(u), v * Math.cos(s.halfAngle)];
    }
    case 'torus': {
      const r = s.major + s.minor * Math.cos(v);
      return [r * Math.cos(u), r * Math.sin(u), s.minor * Math.sin(v)];
    }
  }
}

function toWorld(s: AnalyticSurface, l: P3): P3 {
  const f = s.frame;
  return [0, 1, 2].map(
    (i) => f.o[i]! + f.x[i]! * l[0] + f.y[i]! * l[1] + f.z[i]! * l[2],
  ) as unknown as P3;
}

const surfaces: AnalyticSurface[] = [
  { kind: 'plane', frame },
  { kind: 'cylinder', frame, radius: 1.7 },
  { kind: 'sphere', frame, radius: 2.3 },
  { kind: 'cone', frame, radius: 1.1, halfAngle: 0.45 },
  { kind: 'cone', frame, radius: 2.5, halfAngle: -0.3 },
  { kind: 'torus', frame, major: 3.1, minor: 0.8 },
];

function sample(s: AnalyticSurface, r: () => number): [number, number] {
  switch (s.kind) {
    case 'plane':
      return [(r() - 0.5) * 8, (r() - 0.5) * 8];
    case 'cylinder':
    case 'cone':
      return [r() * 2 * Math.PI, (r() - 0.5) * 2];
    case 'sphere':
      return [r() * 2 * Math.PI, (r() - 0.5) * Math.PI * 0.98];
    case 'torus':
      return [r() * 2 * Math.PI, (r() - 0.5) * 2 * Math.PI];
  }
}

function close(a: P3, b: P3, scale: number, tol = 1e-12): boolean {
  return dist3(a, b) <= tol * Math.max(1, scale);
}

describe('surfaces: closed-form oracles', () => {
  for (const s of surfaces) {
    const name = `${s.kind}${s.kind === 'cone' ? `(${(s as { halfAngle: number }).halfAngle})` : ''}`;
    it(`${name}: point within 1e-12 relative at 1000 seeded points`, () => {
      const r = mulberry32(7);
      for (let i = 0; i < 1000; i++) {
        const [u, v] = sample(s, r);
        const p = surfacePoint(s, u, v);
        const q = toWorld(s, local(s, u, v));
        expect(close(p, q, len3(q))).toBe(true);
      }
    });

    it(`${name}: derivatives match central differences and the normal is dp/du x dp/dv`, () => {
      const r = mulberry32(11);
      const h = 1e-5;
      for (let i = 0; i < 1000; i++) {
        const [u, v] = sample(s, r);
        if (s.kind === 'sphere' && Math.abs(v) > 1.4) continue;
        const { du, dv } = surfaceDerivatives(s, u, v);
        const fu = surfacePoint(s, u + h, v);
        const bu = surfacePoint(s, u - h, v);
        const fv = surfacePoint(s, u, v + h);
        const bv = surfacePoint(s, u, v - h);
        const ndu = [0, 1, 2].map((k) => (fu[k]! - bu[k]!) / (2 * h)) as unknown as P3;
        const ndv = [0, 1, 2].map((k) => (fv[k]! - bv[k]!) / (2 * h)) as unknown as P3;
        expect(dist3(du, ndu)).toBeLessThan(1e-6 * Math.max(1, len3(du)));
        expect(dist3(dv, ndv)).toBeLessThan(1e-6 * Math.max(1, len3(dv)));
        const c = cross3(du, dv);
        const n = surfaceNormal(s, u, v);
        expect(len3(n)).toBeCloseTo(1, 12);
        expect(dot3(c, n) / len3(c)).toBeGreaterThan(1 - 1e-12);
      }
    });

    it(`${name}: inverse recovers the point (distance 0, parameters round-trip)`, () => {
      const r = mulberry32(13);
      for (let i = 0; i < 1000; i++) {
        const [u, v] = sample(s, r);
        if (s.kind === 'cone' && Math.abs(s.radius + v * Math.sin(s.halfAngle)) < 1e-3) continue;
        const p = surfacePoint(s, u, v);
        const inv = surfaceInverse(s, p);
        expect(inv.dist).toBeLessThan(1e-11);
        expect(close(surfacePoint(s, inv.u, inv.v), p, len3(p), 1e-11)).toBe(true);
      }
    });

    it(`${name}: falsifier - a wrong radius is detected by the oracle`, () => {
      if (s.kind === 'plane') return;
      const wrong = {
        ...s,
        ...('radius' in s
          ? { radius: s.radius * 1.001 }
          : { major: (s as { major: number }).major * 1.001 }),
      } as Surface;
      const [u, v] = [0.7, 0.2];
      expect(close(surfacePoint(wrong, u, v), toWorld(s, local(s, u, v)), 3)).toBe(false);
    });
  }

  it('surfaceInverse puts a point off the surface at its distance', () => {
    const s: Surface = { kind: 'sphere', frame, radius: 2 };
    const p = surfacePoint({ ...s, radius: 2.5 } as Surface, 1.1, 0.4);
    expect(surfaceInverse(s, p).dist).toBeCloseTo(0.5, 12);
  });
});

describe('curves and pcurves', () => {
  const circle: Curve = { kind: 'circle', frame, radius: 1.7 };
  const cyl: Surface = { kind: 'cylinder', frame, radius: 1.7 };

  it('circle point and tangent agree with a difference quotient', () => {
    const h = 1e-6;
    for (const t of [0.1, 1.3, 4.2]) {
      const a = curvePoint(circle, t + h);
      const b = curvePoint(circle, t - h);
      const d = curveTangent(circle, t);
      for (let k = 0; k < 3; k++) expect((a[k]! - b[k]!) / (2 * h)).toBeCloseTo(d[k]!, 6);
    }
  });

  it('pcurveFor puts the curve on the surface: surface(pcurve(t)) = curve(t)', () => {
    const cases: [Surface, Curve, number, number][] = [
      [cyl, circle, 0, 2 * Math.PI],
      [
        { kind: 'sphere', frame, radius: 2 },
        { kind: 'circle', frame: { ...frame, o: [0.3, -1.2, 2.5] }, radius: 2 },
        0,
        2 * Math.PI,
      ],
      [{ kind: 'plane', frame }, { kind: 'circle', frame, radius: 1.5 }, 0, 2 * Math.PI],
      [
        cyl,
        {
          kind: 'line',
          o: [0.3 + frame.x[0] * 1.7, -1.2 + frame.x[1] * 1.7, 2.5 + frame.x[2] * 1.7],
          d: frame.z,
        },
        0,
        2,
      ],
    ];
    for (const [s, c, t0, t1] of cases) {
      const pc = pcurveFor(s, c, t0, t1);
      if (!pc.ok) throw new Error(JSON.stringify(pc.error));
      for (let i = 0; i <= 16; i++) {
        const t = t0 + ((t1 - t0) * i) / 16;
        const [u, v] = pcurvePoint(pc.value, t);
        expect(dist3(surfacePoint(s, u, v), curvePoint(c, t))).toBeLessThan(1e-9);
      }
    }
  });

  it('pcurveFor reports brep-pcurve-unsupported for an oblique section', () => {
    const oblique: Curve = {
      kind: 'ellipse',
      frame,
      a: 2,
      b: 1,
    };
    const r = pcurveFor(cyl, oblique, 0, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('model-partial');
      expect((r.error.detail as { brep: string }).brep).toBe('brep-pcurve-unsupported');
    }
  });
});
