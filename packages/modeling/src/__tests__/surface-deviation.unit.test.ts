import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type NurbsSurface, surfaceDerivatives, surfacePoint } from '../nurbs';
import { surfaceDeviation } from '../surface-deviation';

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

/** A rational quarter cylinder with axis along z. */
function cylinder(radius: number, z0: number, z1: number): NurbsSurface {
  const weight = Math.SQRT1_2;
  return {
    degreeU: 2,
    degreeV: 1,
    points: [
      [
        [radius, 0, z0],
        [radius, 0, z1],
      ],
      [
        [radius, radius, z0],
        [radius, radius, z1],
      ],
      [
        [0, radius, z0],
        [0, radius, z1],
      ],
    ],
    weights: [
      [1, 1],
      [weight, weight],
      [1, 1],
    ],
    knotsU: [0, 0, 0, 1, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

/** A curved, non-rational quadratic patch useful for exact point/normal checks. */
const curved: NurbsSurface = {
  degreeU: 2,
  degreeV: 2,
  points: [
    [
      [0, 0, 0],
      [0, 0.5, 0.15],
      [0, 1, 0],
    ],
    [
      [0.5, 0, 0.1],
      [0.5, 0.5, 0.45],
      [0.5, 1, 0.2],
    ],
    [
      [1, 0, 0],
      [1, 0.5, 0.1],
      [1, 1, 0],
    ],
  ],
  knotsU: [0, 0, 0, 1, 1, 1],
  knotsV: [0, 0, 0, 1, 1, 1],
};

function normalAt(surface: NurbsSurface, u: number, v: number): Tuple3 {
  const derivatives = surfaceDerivatives(surface, u, v, 1);
  const su = (derivatives[1] as Tuple3[])[0] as Tuple3;
  const sv = (derivatives[0] as Tuple3[])[1] as Tuple3;
  const n: Tuple3 = [
    su[1] * sv[2] - su[2] * sv[1],
    su[2] * sv[0] - su[0] * sv[2],
    su[0] * sv[1] - su[1] * sv[0],
  ];
  const magnitude = Math.hypot(...n);
  return [n[0] / magnitude, n[1] / magnitude, n[2] / magnitude];
}

function translate(surface: NurbsSurface, offset: Tuple3): NurbsSurface {
  return {
    ...surface,
    points: surface.points.map((row) =>
      row.map(
        (point) => [point[0] + offset[0], point[1] + offset[1], point[2] + offset[2]] as Tuple3,
      ),
    ),
  };
}

function unwrap<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

describe('surfaceDeviation', () => {
  it('reports zero deviation for points sampled directly on a curved patch', () => {
    const points = [0, 0.25, 0.5, 0.75, 1].flatMap((u) =>
      [0, 0.3, 0.7, 1].map((v) => surfacePoint(curved, u, v)),
    );
    const report = unwrap(surfaceDeviation([curved], { points }));
    expect(report.pass).toBe(true);
    expect(report.toSurfaces.count).toBe(points.length);
    expect(report.toSurfaces.max).toBeLessThan(1e-9);
    expect(Math.abs(report.toSurfaces.signed[0])).toBeLessThan(1e-15);
    expect(Math.abs(report.toSurfaces.signed[1])).toBeLessThan(1e-15);
    expect(report.toSurfaces.bands.map((band) => band.limit)).toEqual([2.5e-5, 5e-5, 1e-4, 2e-4]);
    expect(report.issues).toEqual([]);
  });

  it('keeps signed normal offsets and the original curved-surface foot point', () => {
    const distance = 0.003;
    const parameters = [
      [0.2, 0.3],
      [0.5, 0.5],
      [0.8, 0.7],
    ] as const;
    const original = parameters.map(([u, v]) => surfacePoint(curved, u, v));
    const points = parameters.flatMap(([u, v], index) => {
      const point = original[index] as Tuple3;
      const normal = normalAt(curved, u, v);
      return [-distance, distance].map(
        (sign): Tuple3 => [
          point[0] + sign * normal[0],
          point[1] + sign * normal[1],
          point[2] + sign * normal[2],
        ],
      );
    });
    const report = unwrap(surfaceDeviation([curved], { points }, { tolerance: 0.01 }));
    expect(report.toSurfaces.signed[0]).toBeCloseTo(-distance, 8);
    expect(report.toSurfaces.signed[1]).toBeCloseTo(distance, 8);
    expect(report.toSurfaces.max).toBeCloseTo(distance, 8);
    expect(report.toSurfaces.worst.patch).toBe(0);
    const originalFoot = original.find(
      (point) =>
        Math.hypot(
          point[0] - report.toSurfaces.worst.onSurface[0],
          point[1] - report.toSurfaces.worst.onSurface[1],
          point[2] - report.toSurfaces.worst.onSurface[2],
        ) < 1e-7,
    );
    expect(originalFoot).toBeDefined();
  });

  it('measures both directions for translated and partially covering surface targets', () => {
    const offset = 0.002;
    const translated = translate(plane, [0, 0, offset]);
    const translatedReport = unwrap(
      surfaceDeviation([plane], { surfaces: [translated] }, { samples: 5 }),
    );
    expect(translatedReport.toSurfaces.max).toBeCloseTo(offset, 10);
    expect(translatedReport.toTarget?.max).toBeCloseTo(offset, 10);

    const half: NurbsSurface = {
      ...plane,
      points: [
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
        [
          [0.5, 0, 0],
          [0.5, 1, 0],
        ],
      ],
    };
    const halfReport = unwrap(surfaceDeviation([plane], { surfaces: [half] }, { samples: 5 }));
    // Target-to-source samples are all covered; only source-to-target sees the missing half.
    expect(halfReport.toSurfaces.max).toBeLessThan(1e-9);
    expect(halfReport.toTarget?.max).toBeCloseTo(0.5, 10);
    expect(halfReport.pass).toBe(false);
    expect(halfReport.issues.map((issue) => issue.detail.side)).toContain('toTarget');
  });

  it('measures coarse cylinder triangle centroids by their analytic radial sagitta', () => {
    const radius = 0.4;
    const surface = cylinder(radius, 0, 1);
    const vertices = [
      surfacePoint(surface, 0, 0),
      surfacePoint(surface, 1, 0),
      surfacePoint(surface, 1, 1),
      surfacePoint(surface, 0, 1),
    ];
    const positions = vertices.flat();
    const indices = [0, 1, 2, 0, 2, 3];
    const expectedCentroidDistances: number[] = [];
    for (let index = 0; index < indices.length; index += 3) {
      const a = vertices[indices[index] as number] as Tuple3;
      const b = vertices[indices[index + 1] as number] as Tuple3;
      const c = vertices[indices[index + 2] as number] as Tuple3;
      const centroid: Tuple3 = [
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3,
      ];
      expectedCentroidDistances.push(radius - Math.hypot(centroid[0], centroid[1]));
    }
    const expected = Math.max(...expectedCentroidDistances);
    const report = unwrap(
      surfaceDeviation(
        [surface],
        { mesh: { positions, indices } },
        { samples: 2, tolerance: 1, bands: [0.001, 0.05, 0.2] },
      ),
    );
    expect(report.toSurfaces.count).toBe(6);
    expect(report.toSurfaces.max).toBeCloseTo(expected, 12);
    expect(report.toSurfaces.bands.slice(0, 2).every((band) => band.share === 4 / 6)).toBe(true);
    expect(report.toSurfaces.bands[2]?.share).toBe(1);
    expect(report.toSurfaces.max).toBeGreaterThan(0);
    expect(report.toSurfaces.max).toBeLessThan(radius);
    expect(Math.abs(report.toSurfaces.max - expected) / expected).toBeLessThan(0.02);
    expect(report.toTarget?.max).toBe(0);
    const verticesOnly = unwrap(surfaceDeviation([surface], { points: vertices }));
    expect(verticesOnly.toSurfaces.max).toBeLessThan(1e-9);
  });

  it('finds a local half-millimetre bump and reports monotone bands', () => {
    const bump: NurbsSurface = {
      degreeU: 2,
      degreeV: 2,
      points: [
        [
          [0, 0, 0],
          [0, 0.5, 0],
          [0, 1, 0],
        ],
        [
          [0.5, 0, 0],
          [0.5, 0.5, 0.002],
          [0.5, 1, 0],
        ],
        [
          [1, 0, 0],
          [1, 0.5, 0],
          [1, 1, 0],
        ],
      ],
      knotsU: [0, 0, 0, 1, 1, 1],
      knotsV: [0, 0, 0, 1, 1, 1],
    };
    const report = unwrap(
      surfaceDeviation([plane], { surfaces: [bump] }, { samples: 17, tolerance: 0.0001 }),
    );
    expect(report.pass).toBe(false);
    expect(report.toSurfaces.max).toBeCloseTo(0.0005, 8);
    expect(report.toTarget?.max).toBeCloseTo(report.toSurfaces.max, 10);
    expect(report.issues).toContainEqual({
      code: 'deviation-exceeded',
      severity: 'warn',
      detail: expect.objectContaining({ side: 'toSurfaces', tolerance: 0.0001 }),
    });
    expect(
      Math.hypot(report.toSurfaces.worst.point[0] - 0.5, report.toSurfaces.worst.point[1] - 0.5),
    ).toBeLessThan(0.003);
    const shares = report.toSurfaces.bands.map((band) => band.share);
    expect(
      shares.every((share, index) => index === 0 || share >= (shares[index - 1] as number)),
    ).toBe(true);
    expect(shares.every((share) => share >= 0 && share <= 1)).toBe(true);
    expect(shares[shares.length - 1]).toBeLessThan(1);
    expect(report.toTarget?.max).toBeCloseTo(0.0005, 8);
  });

  it('uses the nearest of multiple patches and reports that patch index', () => {
    const lower = translate(plane, [0, 0, 0.01]);
    const point: Tuple3 = [0.4, 0.6, 0.009];
    const report = unwrap(surfaceDeviation([plane, lower], { points: [point] }));
    expect(report.toSurfaces.worst.patch).toBe(1);
    expect(report.toSurfaces.max).toBeCloseTo(0.001, 12);
  });

  it('returns nothing-checked for empty target samples or no measured patches', () => {
    const emptyTarget = unwrap(surfaceDeviation([plane], { points: [] }));
    expect(emptyTarget.pass).toBe(false);
    expect(emptyTarget.toSurfaces.count).toBe(0);
    expect(emptyTarget.issues.map((issue) => issue.code)).toEqual(['nothing-checked']);
    const noPatches = unwrap(surfaceDeviation([], { points: [[0, 0, 0]] }));
    expect(noPatches.pass).toBe(false);
    expect(noPatches.toSurfaces.count).toBe(0);
    expect(noPatches.issues.map((issue) => issue.code)).toEqual(['nothing-checked']);
    const emptyMesh = unwrap(surfaceDeviation([plane], { mesh: { positions: [], indices: [] } }));
    expect(emptyMesh.pass).toBe(false);
    expect(emptyMesh.issues.map((issue) => issue.code)).toEqual(['nothing-checked']);
  });

  it('rejects invalid source and target surfaces, non-finite points and invalid mesh data', () => {
    const badSurface = { ...plane, points: [[[0, 0, 0]]] } as unknown as NurbsSurface;
    expect(surfaceDeviation([badSurface], { points: [] })).toMatchObject({ ok: false });
    const badTargetSurface = surfaceDeviation([plane], { surfaces: [badSurface] });
    expect(badTargetSurface).toMatchObject({
      ok: false,
      error: { code: 'model-invalid-argument' },
    });
    const nonFinitePoint = surfaceDeviation([plane], { points: [[Number.NaN, 0, 0]] });
    expect(nonFinitePoint).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    const malformedTarget = surfaceDeviation([plane], {} as never);
    expect(malformedTarget).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    const malformedMeshPositions = surfaceDeviation([plane], {
      mesh: { positions: [0, 0], indices: [] },
    });
    expect(malformedMeshPositions).toMatchObject({
      ok: false,
      error: { code: 'model-invalid-argument' },
    });
    const nonFiniteMesh = surfaceDeviation([plane], {
      mesh: { positions: [0, 0, Number.POSITIVE_INFINITY], indices: [0, 0, 0] },
    });
    expect(nonFiniteMesh).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    const incompleteMesh = surfaceDeviation([plane], {
      mesh: { positions: [0, 0, 0], indices: [0, 0] },
    });
    expect(incompleteMesh).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    const outOfRangeMesh = surfaceDeviation([plane], {
      mesh: { positions: [0, 0, 0], indices: [0, 0, 1] },
    });
    expect(outOfRangeMesh).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    const nonIntegerIndex = surfaceDeviation([plane], {
      mesh: { positions: [0, 0, 0], indices: [0, 0, 0.5] },
    });
    expect(nonIntegerIndex).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    const malformedPoints = surfaceDeviation([plane], { points: [[0, 0] as unknown as Tuple3] });
    expect(malformedPoints).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
  });

  it('rejects non-positive tolerance, samples below two and invalid bands', () => {
    for (const tolerance of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = surfaceDeviation([plane], { points: [[0, 0, 0]] }, { tolerance });
      expect(result).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    }
    for (const samples of [0, 1, 2.5, Number.NaN]) {
      const result = surfaceDeviation([plane], { points: [[0, 0, 0]] }, { samples });
      expect(result).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    }
    for (const bands of [
      [-1],
      [0.1, Number.NaN],
      [0.2, 0.1],
      [Number.POSITIVE_INFINITY],
      'invalid' as unknown as number[],
    ]) {
      const result = surfaceDeviation([plane], { points: [[0, 0, 0]] }, { bands });
      expect(result).toMatchObject({ ok: false, error: { code: 'model-invalid-argument' } });
    }
  });
});
