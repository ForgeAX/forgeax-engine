import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type NurbsSurface, nurbs, solve } from '../nurbs';
import { type Fairing, forEachFairing } from '../nurbs-fit';

function clamped(p: number, count: number): number[] {
  const inner = count - p - 1;
  return [
    ...new Array<number>(p + 1).fill(0),
    ...Array.from({ length: inner }, (_, i) => (i + 1) / (inner + 1)),
    ...new Array<number>(p + 1).fill(1),
  ];
}

/** Greville abscissae: where a linear function's control points sit exactly. */
function greville(knots: readonly number[], p: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    let s = 0;
    for (let k = 1; k <= p; k++) s += knots[i + k] as number;
    return s / p;
  });
}

function surface(
  n: number,
  z: (u: number, v: number, i: number, j: number) => number,
): NurbsSurface {
  const U = clamped(3, n);
  const g = greville(U, 3, n);
  return {
    degreeU: 3,
    degreeV: 3,
    knotsU: U,
    knotsV: [...U],
    points: g.map((u, i) => g.map((v, j): Tuple3 => [u, v, z(u, v, i, j)])),
  };
}

/** A crumpled panel: a smooth dome plus a deterministic interior ripple. */
const crumpled = (n: number) =>
  surface(n, (u, v, i, j) => {
    const inside = i > 0 && j > 0 && i < n - 1 && j < n - 1;
    return 0.2 * u * (1 - u) * v * (1 - v) + (inside ? 0.01 * (((i * 7 + j * 3) % 5) - 2) : 0);
  });

function energy(s: NurbsSurface, fair: Fairing): number {
  const nv = (s.points[0] as readonly Tuple3[]).length;
  const at = (k: number) => (s.points[Math.floor(k / nv)] as readonly Tuple3[])[k % nv] as Tuple3;
  let e = 0;
  forEachFairing(s.degreeU, s.knotsU, s.degreeV, s.knotsV, fair, (ki, kj, g) => {
    const [a, b] = [at(ki), at(kj)];
    e += g * (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
  });
  return e;
}

const BEND: Fairing = { stretch: 0, bend: 1, rate: 0 };

describe('nurbs.surface.fair', () => {
  it('returns an already fair (planar, linearly spaced) net unchanged', () => {
    const flat = surface(7, (u, v) => 0.3 * u - 0.2 * v + 0.05);
    const out = nurbs.surface.fair(flat, { fair: { bend: 1, rate: 0.5 } });
    if (!out.ok) throw out.error;
    for (const [i, row] of out.value.points.entries())
      for (const [j, p] of row.entries()) {
        const q = (flat.points[i] as readonly Tuple3[])[j] as Tuple3;
        for (let c = 0; c < 3; c++)
          expect(Math.abs((p[c] as number) - (q[c] as number))).toBeLessThan(1e-12);
      }
  });

  it('lowers the bending energy monotonically as the bend weight grows', () => {
    const input = crumpled(9);
    let previous = energy(input, BEND);
    for (const bend of [1e-4, 1e-3, 1e-2, 1e-1, 1]) {
      const out = nurbs.surface.fair(input, { fair: { bend } });
      if (!out.ok) throw out.error;
      const e = energy(out.value, BEND);
      expect(e).toBeLessThan(previous);
      previous = e;
    }
  });

  it('keeps the four boundary rows byte-identical by default', () => {
    const input = crumpled(8);
    const out = nurbs.surface.fair(input, { fair: { bend: 0.1 } });
    if (!out.ok) throw out.error;
    const n = input.points.length;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (i === 0 || j === 0 || i === n - 1 || j === n - 1)
          expect(out.value.points[i]?.[j]).toEqual(input.points[i]?.[j]);
      }
    const free = nurbs.surface.fair(input, { fair: { bend: 0.1 }, keep: 'none' });
    if (!free.ok) throw free.error;
    expect(free.value.points[0]?.[0]).not.toEqual(input.points[0]?.[0]);
  });

  it('agrees with a dense solve of the same normal equations on a 6 x 6 net', () => {
    const input = crumpled(6);
    const fair: Fairing = { stretch: 0.01, bend: 0.05, rate: 0.002 };
    const out = nurbs.surface.fair(input, { fair });
    if (!out.ok) throw out.error;
    const n = 6;
    const index = new Int32Array(n * n).fill(-1);
    let unknowns = 0;
    for (let i = 1; i < n - 1; i++) for (let j = 1; j < n - 1; j++) index[i * n + j] = unknowns++;
    const at = (k: number) => input.points[Math.floor(k / n)]?.[k % n] as Tuple3;
    const A = new Float64Array(unknowns * unknowns);
    const B = new Float64Array(unknowns * 3);
    for (let k = 0; k < n * n; k++) {
      const f = index[k] as number;
      if (f < 0) continue;
      A[f * unknowns + f] = 1 / unknowns;
      for (let c = 0; c < 3; c++) B[3 * f + c] = (at(k)[c] as number) / unknowns;
    }
    forEachFairing(3, input.knotsU, 3, input.knotsV, fair, (ki, kj, g) => {
      const fi = index[ki] as number;
      if (fi < 0) return;
      const fj = index[kj] as number;
      if (fj >= 0) A[fi * unknowns + fj] = (A[fi * unknowns + fj] as number) + g;
      else
        for (let c = 0; c < 3; c++)
          B[3 * fi + c] = (B[3 * fi + c] as number) - g * (at(kj)[c] as number);
    });
    const dense = solve(A, B, unknowns, 3);
    if (!dense.ok) throw dense.error;
    for (let k = 0; k < n * n; k++) {
      const f = index[k] as number;
      if (f < 0) continue;
      const p = out.value.points[Math.floor(k / n)]?.[k % n] as Tuple3;
      for (let c = 0; c < 3; c++)
        expect(Math.abs((p[c] as number) - (dense.value[3 * f + c] as number))).toBeLessThan(1e-10);
    }
  });

  it('rejects rational surfaces and bad weights', () => {
    const input = crumpled(5);
    const rational: NurbsSurface = {
      ...input,
      weights: input.points.map((row, i) => row.map((_, j) => (i === 2 && j === 2 ? 2 : 1))),
    };
    const r = nurbs.surface.fair(rational, { fair: { bend: 1 } });
    expect(!r.ok && r.error.code).toBe('model-precondition');
    const bad = nurbs.surface.fair(input, { fair: { bend: -1 } });
    expect(!bad.ok && bad.error.code).toBe('model-invalid-argument');
  });
});
