import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import {
  type NurbsSurface,
  nurbs,
  type SurfaceCurvature,
  surfaceCurvature,
  surfacePoint,
} from '../nurbs';
import { offsetSurface } from '../nurbs-offset';

const unwrap = <T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error },
): T => {
  if (!result.ok) throw result.error;
  return result.value;
};

const dist = (a: Tuple3, b: Tuple3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

const plane: NurbsSurface = {
  degreeU: 1,
  degreeV: 1,
  points: [
    [
      [0, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 0],
    ],
  ],
  knotsU: [0, 0, 1, 1],
  knotsV: [0, 0, 1, 1],
};

function cylinder(radius: number): NurbsSurface {
  const w = Math.SQRT1_2;
  const section: readonly Tuple3[] = [
    [radius, 0, 0],
    [radius, radius, 0],
    [0, radius, 0],
  ];
  return {
    degreeU: 2,
    degreeV: 1,
    points: section.map((p) => [p, [p[0], p[1], 1]]),
    weights: [
      [1, 1],
      [w, w],
      [1, 1],
    ],
    knotsU: [0, 0, 0, 1, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

function paraboloid(): NurbsSurface {
  const rows = Array.from({ length: 9 }, (_, i) =>
    Array.from({ length: 8 }, (_, j): Tuple3 => {
      const x = -0.3 + (0.6 * i) / 8;
      const y = -0.25 + (0.5 * j) / 7;
      return [x, y, 0.08 * x * x + 0.05 * y * y];
    }),
  );
  return unwrap(nurbs.grid(rows));
}

function principalAt(s: NurbsSurface, u: number, v: number): SurfaceCurvature {
  const curvature = surfaceCurvature(s, u, v);
  if (curvature === undefined) throw new Error(`singular surface at (${u}, ${v})`);
  return curvature;
}

describe('offsetSurface', () => {
  it('translates a bilinear plane exactly along its normal and reports infinite radius', () => {
    const d = 0.137;
    const offset = unwrap(offsetSurface(plane, d, { tolerance: 1e-12 }));
    expect(offset.minRadius).toBe(Infinity);
    expect(offset.converged).toBe(true);
    expect(offset.max).toBeLessThanOrEqual(1e-12);
    for (let i = 0; i <= 12; i++)
      for (let j = 0; j <= 12; j++) {
        const u = i / 12;
        const v = j / 12;
        const source = surfacePoint(plane, u, v);
        const target = surfacePoint(offset.surface, u, v);
        expect(dist(target, [source[0], source[1], source[2] + d])).toBeLessThanOrEqual(1e-12);
      }
  });

  it('offsets an exact rational quarter cylinder outward and inward without changing parameter correspondence', () => {
    const radius = 1.25;
    const source = cylinder(radius);
    const tolerance = 2e-5;
    const outward = unwrap(offsetSurface(source, 0.2, { tolerance, maxNet: [32, 8] }));
    const inward = unwrap(offsetSurface(source, -0.2, { tolerance, maxNet: [32, 8] }));
    expect(outward.converged, JSON.stringify({ max: outward.max, net: outward.net })).toBe(true);
    expect(inward.converged, JSON.stringify({ max: inward.max, net: inward.net })).toBe(true);
    expect(outward.minRadius).toBe(Infinity);
    expect(inward.minRadius).toBeCloseTo(radius, 6);
    const random = rng(641);
    for (let i = 0; i < 400; i++) {
      const u = random();
      const v = random();
      const pOut = surfacePoint(outward.surface, u, v);
      const pIn = surfacePoint(inward.surface, u, v);
      expect(Math.abs(Math.hypot(pOut[0], pOut[1]) - (radius + 0.2))).toBeLessThanOrEqual(
        tolerance,
      );
      expect(Math.abs(Math.hypot(pIn[0], pIn[1]) - (radius - 0.2))).toBeLessThanOrEqual(tolerance);
      const c = principalAt(source, u, v);
      expect(
        dist(pOut, [c.point[0] + 0.2 * c.normal[0], c.point[1] + 0.2 * c.normal[1], c.point[2]]),
      ).toBeLessThanOrEqual(tolerance);
    }

    // Moving away from the cylinder axis has no focal radius, even far beyond its diameter.
    const farOutward = offsetSurface(source, 4 * radius, { tolerance: 1e-3, maxNet: [32, 8] });
    expect(farOutward.ok).toBe(true);
    if (farOutward.ok) expect(farOutward.value.minRadius).toBe(Infinity);

    for (const d of [-radius, -radius - 0.4]) {
      const rejected = offsetSurface(source, d, { tolerance, maxNet: [16, 4] });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('model-precondition');
        expect(rejected.error.detail?.radius as number).toBeCloseTo(radius, 6);
      }
    }
  });

  it('fits a doubly curved paraboloid with independent point and closest-distance checks', () => {
    const source = paraboloid();
    const tolerance = 2e-4;
    const offset = unwrap(offsetSurface(source, 0.035, { tolerance, maxNet: [12, 12] }));
    expect(offset.max).toBeLessThanOrEqual(tolerance);
    expect(offset.converged).toBe(true);
    for (let i = 1; i < 6; i++)
      for (let j = 1; j < 5; j++) {
        const u = i / 6;
        const v = j / 6;
        const c = principalAt(source, u, v);
        const expected: Tuple3 = [
          c.point[0] + 0.035 * c.normal[0],
          c.point[1] + 0.035 * c.normal[1],
          c.point[2] + 0.035 * c.normal[2],
        ];
        const fitted = surfacePoint(offset.surface, u, v);
        expect(dist(fitted, expected)).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(nurbs.closest(source, fitted).distance - 0.035)).toBeLessThanOrEqual(
          tolerance,
        );
      }
  });

  it('rejects an offset past the sampled focal radius in a concave wavy region', () => {
    const rows = Array.from({ length: 17 }, (_, i) =>
      Array.from({ length: 7 }, (_, j): Tuple3 => {
        const x = i / 16;
        const y = j / 6;
        return [x, y, 0.1 * Math.sin(2 * Math.PI * x)];
      }),
    );
    const source = unwrap(nurbs.grid(rows));
    const result = offsetSurface(source, -0.32, { maxNet: [12, 8] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('model-precondition');
      const { u, v, radius, point } = result.error.detail as {
        readonly u: number;
        readonly v: number;
        readonly radius: number;
        readonly point: Tuple3;
      };
      expect(radius).toBeLessThan(0.32);
      expect(point[0]).toBeGreaterThan(0.1);
      expect(point[0]).toBeLessThan(0.4);
      expect(principalAt(source, u, v).k2).toBeLessThan(0);
    }
  });

  it('reports an unconverged fit at a tiny net, preserves zero offsets, and validates arguments', () => {
    const source = paraboloid();
    const capped = unwrap(offsetSurface(source, 0.06, { tolerance: 1e-12, maxNet: [4, 4] }));
    expect(capped.converged).toBe(false);
    expect(capped.net).toEqual([4, 4]);

    const zero = unwrap(offsetSurface(source, 0));
    expect(zero.surface).toBe(source);
    expect(zero.max).toBe(0);
    expect(zero.rms).toBe(0);
    expect(zero.converged).toBe(true);

    const malformed: NurbsSurface = { ...plane, knotsU: [0, 0, 0, 1] };
    const invalids = [
      offsetSurface(malformed, 0.1),
      offsetSurface(plane, Number.NaN),
      offsetSurface(plane, Number.POSITIVE_INFINITY),
      offsetSurface(plane, 0.1, { tolerance: 0 }),
      offsetSurface(plane, 0.1, { tolerance: -1 }),
      offsetSurface(plane, 0.1, { tolerance: Number.NaN }),
      offsetSurface(plane, 0.1, { maxNet: [1, 2] }),
      offsetSurface(plane, 0.1, { maxNet: [2] as unknown as readonly [number, number] }),
      offsetSurface(plane, 0.1, { maxNet: [2.5, 2] }),
      offsetSurface(plane, 0, { maxNet: [1, 2] }),
    ];
    expect(invalids.every((r) => !r.ok && r.error.code === 'model-invalid-argument')).toBe(true);
  });

  it('reports a singular normal with its parameter location', () => {
    const singular: NurbsSurface = {
      ...plane,
      points: [plane.points[0] as readonly Tuple3[], plane.points[0] as readonly Tuple3[]],
    };
    const result = offsetSurface(singular, 0.1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('model-degenerate');
      expect(result.error.detail).toHaveProperty('u');
      expect(result.error.detail).toHaveProperty('v');
    }
  });

  it('approximately reverses a small curved offset after flipping its sign', () => {
    const source = paraboloid();
    const tolerance = 3e-4;
    const first = unwrap(offsetSurface(source, 0.018, { tolerance, maxNet: [16, 16] }));
    const back = unwrap(offsetSurface(first.surface, -0.018, { tolerance, maxNet: [16, 16] }));
    for (let i = 0; i <= 8; i++)
      for (let j = 0; j <= 8; j++)
        expect(
          dist(surfacePoint(back.surface, i / 8, j / 8), surfacePoint(source, i / 8, j / 8)),
        ).toBeLessThanOrEqual(2 * tolerance);
  });
});
