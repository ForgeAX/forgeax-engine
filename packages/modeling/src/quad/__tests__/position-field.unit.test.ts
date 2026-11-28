import { describe, expect, it } from 'vitest';
import {
  type CrossField,
  latticeCoordinates,
  matchPosition,
  middlePoint,
  type PositionField,
  positionRound,
  rotateQuarter,
} from '../field';

type V = [number, number, number];

function unit(v: V): V {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** A two-vertex vertex-site field; the mesh triangle is only a carrier for positions. */
function pair(p: [V, V], n: [V, V], q: [V, V], o: [V, V], scale: number): PositionField {
  const orientation: CrossField = {
    site: 'vertex',
    mesh: {
      positions: new Float64Array([...p[0], ...p[1], 0, 0, 0]),
      triangles: new Uint32Array([0, 1, 2]),
    },
    normal: new Float64Array([...n[0], ...n[1]]),
    direction: new Float64Array([...q[0], ...q[1]]),
    fixed: new Uint8Array(2),
    singularities: [],
  };
  return {
    orientation,
    scale,
    origin: new Float64Array([...o[0], ...o[1]]),
    vertexSource: new Uint32Array([0, 1]),
  };
}

function worldOffset(field: PositionField, offset: readonly [number, number]): V {
  const q = Array.from(field.orientation.direction.subarray(0, 3)) as V;
  const n = Array.from(field.orientation.normal.subarray(0, 3)) as V;
  const t = rotateQuarter(q, n, 1);
  const s = field.scale;
  return [
    s * (offset[0] * q[0] + offset[1] * t[0]),
    s * (offset[0] * q[1] + offset[1] * t[1]),
    s * (offset[0] * q[2] + offset[1] * t[2]),
  ];
}

describe('middlePoint', () => {
  it('is the plain midpoint for coplanar points with one normal', () => {
    const m = middlePoint([0, 0, 0], [0, 0, 1], [2, 4, 0], [0, 0, 1]);
    expect(m[0]).toBeCloseTo(1, 12);
    expect(m[1]).toBeCloseTo(2, 12);
    expect(m[2]).toBeCloseTo(0, 12);
  });

  it('moves toward both tangent planes on a curved surface', () => {
    // Two points on the unit sphere: the chord midpoint lies inside, below both tangent planes.
    const p0 = unit([1, 0, 0.3]);
    const p1 = unit([0.3, 0, 1]);
    const m = middlePoint(p0, p0, p1, p1);
    const plane = (p: V, x: V) =>
      p[0] * (x[0] - p[0]) + p[1] * (x[1] - p[1]) + p[2] * (x[2] - p[2]);
    const chord: V = [0.5 * (p0[0] + p1[0]), 0.5 * (p0[1] + p1[1]), 0.5 * (p0[2] + p1[2])];
    expect(Math.abs(plane(p0, m))).toBeLessThan(0.05 * Math.abs(plane(p0, chord)));
    expect(Math.abs(plane(p1, m))).toBeLessThan(0.05 * Math.abs(plane(p1, chord)));
  });
});

describe('positionRound', () => {
  it('returns the nearest lattice point and is idempotent', () => {
    const o: V = [0.1, 0.2, 0];
    const q = unit([1, 1, 0]);
    const n: V = [0, 0, 1];
    for (let k = 0; k < 20; k++) {
      const p: V = [0.37 * k - 3, 0.53 * ((k * 7) % 11) - 2, 0];
      const r = positionRound(o, q, n, p, 0.5);
      const d = Math.sqrt((r[0] - p[0]) * (r[0] - p[0]) + (r[1] - p[1]) * (r[1] - p[1]));
      expect(d).toBeLessThanOrEqual(0.5 * Math.SQRT1_2 + 1e-12);
      const again = positionRound(o, q, n, r, 0.5);
      expect(again[0]).toBeCloseTo(r[0], 12);
      expect(again[1]).toBeCloseTo(r[1], 12);
    }
  });
});

describe('matchPosition', () => {
  const s = 0.25;
  const cases: { name: string; n: [V, V]; q: [V, V] }[] = [
    {
      name: 'flat, aligned',
      n: [
        [0, 0, 1],
        [0, 0, 1],
      ],
      q: [unit([1, 0.2, 0]), unit([1, 0.2, 0])],
    },
    {
      name: 'flat, j turned',
      n: [
        [0, 0, 1],
        [0, 0, 1],
      ],
      q: [unit([1, 0.2, 0]), unit([-0.2, 1, 0])],
    },
    // Tilted j: the best match pairs i's second axis with j's first (turn a = 1).
    {
      name: 'tilted, a = 1',
      n: [[0, 0, 1], unit([0.6, 0, 0.8])],
      q: [
        [1, 0, 0],
        [0, 1, 0],
      ],
    },
  ];
  for (const c of cases) {
    it(`recovers integer origin offsets in i's stored frame (${c.name})`, () => {
      for (const [a, b] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 1],
      ] as const) {
        for (let k = 0; k < 4; k++) {
          // The stored representative of i is any of its four turns; the world offset must not change.
          const qi = rotateQuarter(c.q[0], c.n[0], k);
          const ti = rotateQuarter(c.q[0], c.n[0], 1);
          const oi: V = [0.01, -0.02, 0];
          const oj: V = [
            oi[0] + s * (a * c.q[0][0] + b * ti[0]),
            oi[1] + s * (a * c.q[0][1] + b * ti[1]),
            oi[2] + s * (a * c.q[0][2] + b * ti[2]),
          ];
          const field = pair(
            [
              [0, 0, 0],
              [0.3 * s, 0.2 * s, 0],
            ],
            c.n,
            [qi, c.q[1]],
            [oi, oj],
            s,
          );
          const m = matchPosition(field, 0, 1);
          const w = worldOffset(field, m.offset);
          const want: V = [oj[0] - oi[0], oj[1] - oi[1], oj[2] - oi[2]];
          if (c.name.startsWith('flat')) {
            expect(m.error).toBeLessThan(1e-20);
            for (let x = 0; x < 3; x++) expect(w[x]).toBeCloseTo(want[x] as number, 12);
          } else {
            // Out-of-plane origins only agree in i's tangent plane: compare that projection.
            expect(w[2]).toBeCloseTo(0, 12);
            expect(w[0]).toBeCloseTo(want[0], 12);
            expect(w[1]).toBeCloseTo(want[1], 12);
          }
        }
      }
    });
  }

  it('reports a nonzero error when the lattices disagree', () => {
    const n: [V, V] = [
      [0, 0, 1],
      [0, 0, 1],
    ];
    const q: [V, V] = [
      [1, 0, 0],
      [1, 0, 0],
    ];
    const field = pair(
      [
        [0, 0, 0],
        [0.1, 0, 0],
      ],
      n,
      q,
      [
        [0, 0, 0],
        [0.5 * s, 0.5 * s, 0],
      ],
      s,
    );
    expect(matchPosition(field, 0, 1).error).toBeCloseTo(0.5 * s * s, 12);
  });
});

describe('latticeCoordinates', () => {
  it('inverts the lattice parametrization', () => {
    const q = unit([1, 2, 0]);
    const n: [V, V] = [
      [0, 0, 1],
      [0, 0, 1],
    ];
    const field = pair(
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      n,
      [q, q],
      [
        [1, 1, 0],
        [0, 0, 0],
      ],
      0.5,
    );
    const t = rotateQuarter(q, [0, 0, 1], 1);
    const p: V = [1 + 0.5 * (3 * q[0] - 2 * t[0]), 1 + 0.5 * (3 * q[1] - 2 * t[1]), 0];
    const [a, b] = latticeCoordinates(field, 0, p);
    expect(a).toBeCloseTo(3, 12);
    expect(b).toBeCloseTo(-2, 12);
  });
});
