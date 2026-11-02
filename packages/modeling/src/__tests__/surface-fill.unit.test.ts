import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type NurbsSurface, nurbs, surfacePoint } from '../nurbs';
import { type FillBoundary, type FillResidual, fillQuads } from '../surface-fill';
import { measureEdge } from '../surface-quality';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

const bezier = (n: number) => [
  ...new Array<number>(n + 1).fill(0),
  ...new Array<number>(n + 1).fill(1),
];

/** Exact biquadratic Bezier patch of a biquadratic polynomial map (interpolated at 0, 1/2, 1). */
function biquadratic(F: (u: number, v: number) => Tuple3): NurbsSurface {
  const t = [0, 0.5, 1];
  const solve1 = (f: readonly Tuple3[]): Tuple3[] => {
    const [a, m, b] = f as [Tuple3, Tuple3, Tuple3];
    return [
      a,
      [2 * m[0] - (a[0] + b[0]) / 2, 2 * m[1] - (a[1] + b[1]) / 2, 2 * m[2] - (a[2] + b[2]) / 2],
      b,
    ];
  };
  const grid = t.map((u) => t.map((v) => F(u, v)));
  const alongV = grid.map((row) => solve1(row));
  const points = [0, 1, 2].map(() => [] as Tuple3[]);
  for (let j = 0; j < 3; j++) {
    const column = solve1(alongV.map((row) => row[j] as Tuple3));
    for (let i = 0; i < 3; i++) (points[i] as Tuple3[]).push(column[i] as Tuple3);
  }
  return { degreeU: 2, degreeV: 2, points, knotsU: bezier(2), knotsV: bezier(2) };
}

/** A rotation (about a skew axis) and offset applied to a height field z = a (x^2 + y^2). */
const tilt = (p: Tuple3): Tuple3 => {
  const [x, y, z] = p;
  const c = Math.cos(0.4);
  const s = Math.sin(0.4);
  const y1 = c * y - s * z;
  const z1 = s * y + c * z;
  const c2 = Math.cos(0.7);
  const s2 = Math.sin(0.7);
  return [c2 * x + s2 * z1 + 0.3, y1 - 0.2, -s2 * x + c2 * z1 + 1.1];
};
const tiltNormal: Tuple3 = (() => {
  const o = tilt([0, 0, 0]);
  const z = tilt([0, 0, 1]);
  return [z[0] - o[0], z[1] - o[1], z[2] - o[2]];
})();

/**
 * Neighbour patches around a polygon hole in the height field z = a (x^2 + y^2): patch k
 * spans edge k (its side v0) and extends outward.
 */
function ring(
  polygon: readonly [number, number][],
  a: number,
  map: (p: Tuple3) => Tuple3 = (p) => p,
): FillBoundary[] {
  return polygon.map((A, k) => {
    const B = polygon[(k + 1) % polygon.length] as [number, number];
    const surface = biquadratic((u, v) => {
      const s = 1 + 0.5 * v;
      const x = s * ((1 - u) * A[0] + u * B[0]);
      const y = s * ((1 - u) * A[1] + u * B[1]);
      return map([x, y, a * (x * x + y * y)]);
    });
    return { surface, side: 'v0' };
  });
}

/**
 * The audit's fixture: strips around a polygon hole in z = a (x^2 + y^2), each widening with
 * the distance from the axis and bending with the paraboloid (biquadratic, side v0 on the edge).
 */
function strips(polygon: readonly [number, number][], a: number): FillBoundary[] {
  return polygon.map((A, k) => {
    const B = polygon[(k + 1) % polygon.length] as [number, number];
    const ex = B[0] - A[0];
    const ey = B[1] - A[1];
    const el = Math.hypot(ex, ey);
    const nx = ey / el;
    const ny = -ex / el;
    const surface = biquadratic((u, v) => {
      const x0 = (1 - u) * A[0] + u * B[0];
      const y0 = (1 - u) * A[1] + u * B[1];
      const w = 0.5 * v * Math.hypot(x0, y0);
      const x = x0 + nx * w;
      const y = y0 + ny * w;
      return [x, y, a * (x0 * x0 + y0 * y0) + a * 2 * (x0 * nx + y0 * ny) * w];
    });
    return { surface, side: 'v0' };
  });
}

const regular = (n: number, r = 1): [number, number][] =>
  Array.from({ length: n }, (_, k) => [
    r * Math.cos((2 * Math.PI * k) / n),
    r * Math.sin((2 * Math.PI * k) / n),
  ]);

/** Rational cylinder patch of radius 1 around an axis, quarter arc from axis b to axis c. */
function cylinder(axis: 0 | 1 | 2): NurbsSurface {
  const b = (axis + 1) % 3;
  const c = (axis + 2) % 3;
  const at = (pb: number, pc: number, pa: number): Tuple3 => {
    const p: Tuple3 = [0, 0, 0];
    p[b] = pb;
    p[c] = pc;
    p[axis] = pa;
    return p;
  };
  const arc: [number, number][] = [
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const w = Math.SQRT1_2;
  return {
    degreeU: 2,
    degreeV: 1,
    points: arc.map(([pb, pc]) => [at(pb, pc, -0.6), at(pb, pc, 0)]),
    weights: [
      [1, 1],
      [w, w],
      [1, 1],
    ],
    knotsU: bezier(2),
    knotsV: bezier(1),
  };
}

const octant = (): FillBoundary[] =>
  [0, 1, 2].map((a) => ({ surface: cylinder(a as 0 | 1 | 2), side: 'v1' }));

const worst = (
  r: readonly FillResidual[],
  edge: 'side' | 'spoke',
  key: 'angle' | 'curvatureRatio' | 'gap',
) => Math.max(...r.filter((x) => x.edge === edge).map((x) => x[key]));

const fill = nurbs.surface.fillN;

const normalAt = (q: NurbsSurface, u: number, v: number): Tuple3 => {
  const d = nurbs.surfaceDerivatives(q, u, v, 1);
  const a = (d[1] as Tuple3[])[0] as Tuple3;
  const b = (d[0] as Tuple3[])[1] as Tuple3;
  const c: Tuple3 = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const l = Math.hypot(...c);
  return [c[0] / l, c[1] / l, c[2] / l];
};
const degreesBetween = (a: Tuple3, b: Tuple3) =>
  (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;

describe('nurbs.surface.fillN', () => {
  it('fills a planar hexagon exactly in its plane', () => {
    const r = unwrap(fill({ boundaries: ring(regular(6), 0, tilt) }));
    expect(r.patches).toHaveLength(6);
    const o = tilt([0, 0, 0]);
    let off = 0;
    for (const q of r.patches)
      for (const row of q.points)
        for (const p of row)
          off = Math.max(
            off,
            Math.abs(
              (p[0] - o[0]) * tiltNormal[0] +
                (p[1] - o[1]) * tiltNormal[1] +
                (p[2] - o[2]) * tiltNormal[2],
            ),
          );
    expect(off).toBeLessThan(1e-9);
    expect(worst(r.residual, 'side', 'gap')).toBeLessThan(1e-12);
    expect(worst(r.residual, 'side', 'angle')).toBeLessThan(1e-6);
    expect(worst(r.residual, 'spoke', 'angle')).toBeLessThan(1e-6);
    expect(r.residual).toHaveLength(12);
  });

  it('fills the sphere octant between three cylinders with neither bulge nor flat spot', () => {
    const r = unwrap(fill({ boundaries: octant() }));
    expect(r.patches).toHaveLength(3);
    let radial = 0;
    for (const q of r.patches)
      for (let i = 0; i <= 10; i++)
        for (let j = 0; j <= 10; j++)
          radial = Math.max(radial, Math.abs(Math.hypot(...surfacePoint(q, i / 10, j / 10)) - 1));
    expect(radial).toBeLessThan(0.005);
    expect(worst(r.residual, 'side', 'angle')).toBeLessThanOrEqual(0.1);
    expect(worst(r.residual, 'spoke', 'angle')).toBeLessThanOrEqual(0.1);
    for (const a of r.patches)
      for (const b of r.patches)
        expect(degreesBetween(normalAt(a, 0, 0), normalAt(b, 0, 0))).toBeLessThan(0.1);
    expect(r.normalSpread).toBeLessThan(90);
    const diagonal: Tuple3 = [Math.sqrt(1 / 3), Math.sqrt(1 / 3), Math.sqrt(1 / 3)];
    expect(degreesBetween(normalAt(r.patches[0] as NurbsSurface, 0, 0), diagonal)).toBeLessThan(
      0.5,
    );
    expect(Math.hypot(...surfacePoint(r.patches[0] as NurbsSurface, 0, 0))).toBeCloseTo(1, 3);
  });

  it('closes n = 4 and n = 5 loops, planar and curved', () => {
    for (const [n, a] of [
      [4, 0],
      [5, 0],
      [4, 0.3],
      [5, 0.3],
    ] as const) {
      const r = unwrap(fill({ boundaries: ring(regular(n), a) }));
      expect(r.patches).toHaveLength(n);
      expect(worst(r.residual, 'side', 'angle')).toBeLessThanOrEqual(0.1);
      expect(worst(r.residual, 'spoke', 'angle')).toBeLessThanOrEqual(0.1);
      expect(worst(r.residual, 'side', 'gap')).toBeLessThan(1e-6);
    }
  });

  it('accepts reversed pieces, multi-piece sides, either loop direction and bare curves', () => {
    const hexagon = ring(regular(6), 0.2);
    const split = hexagon[2] as { surface: NurbsSurface; side: 'v0' };
    const flipped = hexagon[4] as { surface: NurbsSurface; side: 'v0' };
    const mixed: (FillBoundary | FillBoundary[])[] = [
      ...hexagon.slice(0, 2),
      [
        { ...split, range: [0, 0.4] },
        { ...split, range: [0.4, 1] },
      ],
      hexagon[3] as FillBoundary,
      {
        surface: { ...flipped.surface, points: [...flipped.surface.points].reverse() },
        side: 'v0',
      },
      hexagon[5] as FillBoundary,
    ];
    const reference = unwrap(fill({ boundaries: hexagon }));
    for (const boundaries of [
      mixed,
      [...mixed].reverse().map((b) => (Array.isArray(b) ? [...b].reverse() : b)),
    ]) {
      const r = unwrap(fill({ boundaries }));
      expect(worst(r.residual, 'side', 'angle')).toBeLessThanOrEqual(0.1);
      expect(worst(r.residual, 'spoke', 'angle')).toBeLessThanOrEqual(0.1);
      const up = normalAt(reference.patches[0] as NurbsSurface, 0, 0);
      expect(degreesBetween(normalAt(r.patches[0] as NurbsSurface, 0, 0), up)).toBeLessThan(0.01);
    }
    expect(normalAt(reference.patches[0] as NurbsSurface, 0, 0)[2]).toBeLessThan(0);
    const curves = octant().map((b) => {
      const s = (b as { surface: NurbsSurface }).surface;
      return {
        curve: {
          degree: 2,
          points: s.points.map((row) => row[1] as Tuple3),
          weights: [1, Math.SQRT1_2, 1],
          knots: bezier(2),
        },
      };
    });
    const bare = unwrap(fill({ boundaries: curves }));
    expect(worst(bare.residual, 'side', 'gap')).toBeLessThan(1e-4);
    expect(worst(bare.residual, 'spoke', 'angle')).toBeLessThanOrEqual(0.1);
  });

  it('rejects open loops and side counts outside 3..8', () => {
    const hexagon = ring(regular(6), 0);
    const moved = hexagon[3] as { surface: NurbsSurface; side: 'v0' };
    const gap = fill({
      boundaries: hexagon.map((b, k) =>
        k === 3
          ? {
              surface: {
                ...moved.surface,
                points: moved.surface.points.map((row) =>
                  row.map((p): Tuple3 => [p[0], p[1], p[2] + 1e-3]),
                ),
              },
              side: 'v0',
            }
          : b,
      ),
    });
    expect(gap.ok).toBe(false);
    if (!gap.ok) {
      expect(gap.error.code).toBe('model-precondition');
      expect(gap.error.detail?.gap).toBeGreaterThan(1e-6);
    }
    const loose = fill({ boundaries: hexagon, tolerance: 1e-6 });
    expect(loose.ok).toBe(true);
    for (const boundaries of [hexagon.slice(0, 2), [...ring(regular(9), 0)]]) {
      const r = fill({ boundaries });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
    }
    const range = fill({ boundaries: [{ ...moved, range: [0.6, 0.2] }, ...hexagon.slice(1)] });
    expect(!range.ok && range.error.code).toBe('model-invalid-argument');
  });

  it('needs the simultaneous solve: pairwise spoke matching leaves a G1 break', () => {
    const joint = unwrap(fill({ boundaries: octant() }));
    expect(worst(joint.residual, 'spoke', 'angle')).toBeLessThanOrEqual(0.1);
    const loose = unwrap(fillQuads({ boundaries: octant() }, false));
    expect(worst(loose.residual, 'spoke', 'angle')).toBeGreaterThan(1);
    const q = [...loose.patches];
    for (let k = 0; k < 3; k++)
      q[(k + 1) % 3] = unwrap(
        nurbs.match(q[(k + 1) % 3] as NurbsSurface, 'v0', q[k] as NurbsSurface, 'u0', {
          level: 'G1',
        }),
      ).a;
    const spokes = [0, 1, 2].map(
      (k) =>
        unwrap(measureEdge(q[k] as NurbsSurface, 'u0', q[(k + 1) % 3] as NurbsSurface, 'v0')).angle,
    );
    expect(Math.max(...spokes)).toBeGreaterThan(1);
  });

  it('fails a folded quad and fills a 1:6 triangle without a fold', () => {
    const thin = (h: number) =>
      strips(
        [
          [-0.6, -0.3],
          [0.6, -0.3],
          [0.6, -0.3 + h],
        ],
        0.3,
      );
    // Independent dense check: no sample turns more than 90 degrees from its quad's center normal.
    const flips = (patches: readonly NurbsSurface[]) => {
      let count = 0;
      for (const q of patches) {
        const ref = normalAt(q, 0, 0);
        for (let i = 0; i <= 40; i++)
          for (let j = 0; j <= 40; j++)
            if (degreesBetween(normalAt(q, i / 40, j / 40), ref) > 90) count++;
      }
      return count;
    };
    const r = unwrap(fill({ boundaries: thin(0.2) }));
    expect(flips(r.patches)).toBe(0);
    expect(r.normalSpread).toBeLessThan(90);
    expect(worst(r.residual, 'side', 'angle')).toBeLessThanOrEqual(0.1);
    const folded = fill({ boundaries: thin(0.12) });
    expect(folded.ok).toBe(false);
    if (!folded.ok) {
      expect(folded.error.code).toBe('model-degenerate');
      expect(folded.error.detail?.angle as number).toBeGreaterThan(90);
      expect(folded.error.detail).toHaveProperty('quad');
      expect(folded.error.detail).toHaveProperty('point');
    }
  });

  it('fails, not returns, a fill whose neighbours disagree at the corners', () => {
    // Square hole in a plane, each strip turned 5 degrees about its edge, alternately up
    // and down: the two normals at every corner differ, so no G1 fill exists.
    const kinked = ring(regular(4), 0).map((b, k) => {
      const { surface } = b as { surface: NurbsSurface; side: 'v0' };
      const A = surface.points[0]?.[0] as Tuple3;
      const B = surface.points[2]?.[0] as Tuple3;
      const axis = [B[0] - A[0], B[1] - A[1], B[2] - A[2]] as Tuple3;
      const l = Math.hypot(...axis);
      const [x, y, z] = [axis[0] / l, axis[1] / l, axis[2] / l];
      const a = ((k % 2 === 0 ? 5 : -5) * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const turn = (p: Tuple3): Tuple3 => {
        const d: Tuple3 = [p[0] - A[0], p[1] - A[1], p[2] - A[2]];
        const along = x * d[0] + y * d[1] + z * d[2];
        const q: Tuple3 = [y * d[2] - z * d[1], z * d[0] - x * d[2], x * d[1] - y * d[0]];
        return [0, 1, 2].map(
          (i) =>
            (A[i] as number) +
            (d[i] as number) * c +
            (q[i] as number) * s +
            ([x, y, z][i] as number) * along * (1 - c),
        ) as Tuple3;
      };
      return {
        surface: { ...surface, points: surface.points.map((row) => row.map(turn)) },
        side: 'v0' as const,
      };
    });
    const r = fill({ boundaries: kinked });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('model-precondition');
      expect(r.error.detail?.sideAngle as number).toBeGreaterThan(1);
      expect(Math.max(...(r.error.detail?.cornerMismatch as number[]))).toBeGreaterThan(1);
      expect(r.error.hint).toContain('inconsistent');
    }
  });

  it("matches the neighbours' curvature along the outer sides with 'G2'", () => {
    const boundaries = ring(regular(5), 0.3);
    const g2 = unwrap(fill({ boundaries, continuity: 'G2' }));
    expect(worst(g2.residual, 'side', 'curvatureRatio')).toBeLessThanOrEqual(0.05);
    expect(worst(g2.residual, 'side', 'angle')).toBeLessThanOrEqual(0.1);
    expect(worst(g2.residual, 'spoke', 'angle')).toBeLessThanOrEqual(0.1);
    expect(g2.patches[0]?.degreeU).toBe(5);
    const g1 = unwrap(fill({ boundaries }));
    expect(worst(g1.residual, 'side', 'curvatureRatio')).toBeGreaterThan(0.05);
  });
});
