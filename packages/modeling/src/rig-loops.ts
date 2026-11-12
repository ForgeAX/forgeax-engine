import { type Affine, applyPoint } from './affine';
import type { Axis, Tuple3 } from './geom';

/**
 * How two bodies of a rig meet where a closed loop is cut: `pin` (a revolute closure,
 * coincident points and parallel axes), `ball` (coincident points) or `slide` (a prismatic
 * closure: the point stays on the axis line and the bodies keep their relative orientation).
 */
export type LoopClosure = 'pin' | 'ball' | 'slide';

/**
 * One closed loop: joint `b`'s body meets joint `a`'s body at `at` (rest model space), where
 * the tree is cut. At rest the closure holds by construction; joints on the two chains up to
 * the bodies' common ancestor that a pose does not name are solved to keep it.
 */
export interface LoopSpec {
  readonly name: string;
  readonly a: string;
  readonly b: string;
  readonly kind: LoopClosure;
  readonly at: Tuple3;
  /** `pin` and `slide`: the closure axis in rest model space. */
  readonly axis?: Axis | Tuple3;
}

/** @internal A compiled closure with two fixed unit vectors across its axis. */
export interface ClosureRecord {
  readonly name: string;
  readonly a: number;
  readonly b: number;
  readonly kind: LoopClosure;
  readonly at: Tuple3;
  readonly axis: Tuple3;
  readonly across: readonly [Tuple3, Tuple3];
}

/** Constraint rows a closure removes in space; a planar closure removes 2 (pin, slide). */
export const CLOSURE_ROWS: Readonly<Record<LoopClosure, number>> = { pin: 5, ball: 3, slide: 5 };

function cross(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

function normalize(v: Tuple3): Tuple3 {
  const l = Math.sqrt(dot(v, v));
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** @internal Two unit vectors perpendicular to unit `axis` and to each other. */
export function acrossOf(axis: Tuple3): [Tuple3, Tuple3] {
  const seed: Tuple3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(axis, seed));
  return [u, cross(axis, u)];
}

function rotate(m: Affine, v: Tuple3): Tuple3 {
  return [
    (m[0] as number) * v[0] + (m[1] as number) * v[1] + (m[2] as number) * v[2],
    (m[4] as number) * v[0] + (m[5] as number) * v[1] + (m[6] as number) * v[2],
    (m[8] as number) * v[0] + (m[9] as number) * v[1] + (m[10] as number) * v[2],
  ];
}

/**
 * @internal Closure error rows of one loop, given the two bodies' rest-to-posed transforms:
 * meters for positions, sines for directions. All zero when the loop is closed.
 */
export function closureRows(loop: ClosureRecord, deltaA: Affine, deltaB: Affine): number[] {
  const pa = applyPoint(deltaA, loop.at);
  const pb = applyPoint(deltaB, loop.at);
  const d: Tuple3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  if (loop.kind === 'ball') return d;
  const ua = rotate(deltaA, loop.across[0]);
  const wa = rotate(deltaA, loop.across[1]);
  if (loop.kind === 'pin') {
    const ab = rotate(deltaB, loop.axis);
    return [...d, dot(ua, ab), dot(wa, ab)];
  }
  // slide: the point stays on A's axis line, and B keeps A's orientation.
  const aa = rotate(deltaA, loop.axis);
  const ub = rotate(deltaB, loop.across[0]);
  const wb = rotate(deltaB, loop.across[1]);
  return [dot(ua, d), dot(wa, d), dot(wa, ub), dot(aa, ub), dot(aa, wb)];
}

/** Symmetric eigen-decomposition by cyclic Jacobi rotations (sqrt and division only). */
export function symmetricEigen(input: readonly (readonly number[])[]): {
  readonly values: number[];
  /** Column k of `vectors` belongs to `values[k]`; values descend. */
  readonly vectors: number[][];
} {
  const n = input.length;
  const a = input.map((row) => [...row]);
  const v = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  const at = (m: number[][], i: number, j: number) => (m[i] as number[])[j] as number;
  const set = (m: number[][], i: number, j: number, x: number) => {
    (m[i] as number[])[j] = x;
  };
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    let scale = 0;
    for (let p = 0; p < n; p++) {
      scale += at(a, p, p) * at(a, p, p);
      for (let q = p + 1; q < n; q++) off += at(a, p, q) * at(a, p, q);
    }
    if (off <= 1e-30 * (scale + 1e-300)) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = at(a, p, q);
        if (apq === 0) continue;
        const theta = (at(a, q, q) - at(a, p, p)) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = at(a, k, p);
          const akq = at(a, k, q);
          set(a, k, p, c * akp - s * akq);
          set(a, k, q, s * akp + c * akq);
        }
        for (let k = 0; k < n; k++) {
          const apk = at(a, p, k);
          const aqk = at(a, q, k);
          set(a, p, k, c * apk - s * aqk);
          set(a, q, k, s * apk + c * aqk);
        }
        for (let k = 0; k < n; k++) {
          const vkp = at(v, k, p);
          const vkq = at(v, k, q);
          set(v, k, p, c * vkp - s * vkq);
          set(v, k, q, s * vkp + c * vkq);
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => at(a, y, y) - at(a, x, x));
  return {
    values: order.map((i) => at(a, i, i)),
    vectors: v.map((row) => order.map((i) => row[i] as number)),
  };
}

/** `a^T a` for rows of length `cols`. */
export function gram(a: readonly (readonly number[])[], cols: number): number[][] {
  const out = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
  for (const row of a) {
    for (let i = 0; i < cols; i++) {
      const ri = row[i] as number;
      if (ri === 0) continue;
      const o = out[i] as number[];
      for (let j = 0; j < cols; j++) o[j] = (o[j] as number) + ri * (row[j] as number);
    }
  }
  return out;
}

/** Relative singular value floor of the rank tests. */
export const RANK_TOLERANCE = 1e-7;

/**
 * Singular values (descending), numerical rank and a null-space basis (columns) of a matrix
 * with `cols` columns.
 */
export function analyze(
  a: readonly (readonly number[])[],
  cols: number,
): {
  readonly singular: number[];
  readonly rank: number;
  readonly nullSpace: number[][];
  /** Right singular vectors: column k belongs to `singular[k]`. */
  readonly vectors: number[][];
} {
  if (cols === 0) return { singular: [], rank: 0, nullSpace: [], vectors: [] };
  const { values, vectors } = symmetricEigen(gram(a, cols));
  const singular = values.map((e) => Math.sqrt(Math.max(0, e)));
  const top = singular[0] ?? 0;
  const floor = Math.max(RANK_TOLERANCE * top, 1e-12);
  const rank = singular.filter((s) => s > floor).length;
  const nullSpace: number[][] = [];
  for (let k = rank; k < cols; k++) nullSpace.push(vectors.map((row) => row[k] as number));
  return { singular, rank, nullSpace, vectors };
}

/** Solve `m x = b` by Gaussian elimination with partial pivoting (undefined when singular). */
export function solveLinear(
  m: readonly (readonly number[])[],
  b: readonly number[],
): number[] | undefined {
  const n = b.length;
  const a = m.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (
        Math.abs((a[r] as number[])[col] as number) >
        Math.abs((a[pivot] as number[])[col] as number)
      ) {
        pivot = r;
      }
    }
    const pr = a[pivot] as number[];
    if (Math.abs(pr[col] as number) < 1e-300) return undefined;
    a[pivot] = a[col] as number[];
    a[col] = pr;
    for (let r = col + 1; r < n; r++) {
      const other = a[r] as number[];
      const f = (other[col] as number) / (pr[col] as number);
      if (f === 0) continue;
      for (let k = col; k <= n; k++) other[k] = (other[k] as number) - f * (pr[k] as number);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = a[r] as number[];
    let s = row[n] as number;
    for (let k = r + 1; k < n; k++) s -= (row[k] as number) * (x[k] as number);
    x[r] = s / (row[r] as number);
  }
  return x;
}

/** Central-difference Jacobian of `f` at `x` (rows of f by columns of x). */
export function jacobian(
  f: (x: readonly number[]) => number[],
  x: readonly number[],
  step = 1e-6,
): number[][] {
  const columns = x.map((_, k) => {
    const up = [...x];
    const down = [...x];
    up[k] = (up[k] as number) + step;
    down[k] = (down[k] as number) - step;
    const fu = f(up);
    const fd = f(down);
    return fu.map((v, i) => (v - (fd[i] as number)) / (2 * step));
  });
  const rows = columns[0]?.length ?? f(x).length;
  return Array.from({ length: rows }, (_, i) => columns.map((c) => c[i] as number));
}

function norm(v: readonly number[]): number {
  let m = 0;
  for (const x of v) m = Math.max(m, Math.abs(x));
  return m;
}

/**
 * Levenberg-Marquardt on `f(x) = 0` from `x0`: the largest row below `tolerance`, or the best
 * point found after `limit` iterations.
 */
export function leastSquares(
  f: (x: readonly number[]) => number[],
  x0: readonly number[],
  tolerance: number,
  limit = 100,
): { readonly x: number[]; readonly residual: number; readonly iterations: number } {
  let x = [...x0];
  let r = f(x);
  let error = norm(r);
  let lambda = 1e-6;
  let iterations = 0;
  while (error > tolerance && iterations < limit && x.length > 0) {
    iterations++;
    const j = jacobian(f, x);
    const g = gram(j, x.length);
    const rhs = x.map(
      (_, k) => -j.reduce((s, row, i) => s + (row[k] as number) * (r[i] as number), 0),
    );
    let improved = false;
    for (let attempt = 0; attempt < 12 && !improved; attempt++) {
      const damped = g.map((row, i) =>
        row.map((v, k) => (i === k ? v + lambda * Math.max(v, 1e-12) : v)),
      );
      const step = solveLinear(damped, rhs);
      if (step !== undefined) {
        const next = x.map((v, k) => v + (step[k] as number));
        const rn = f(next);
        const en = norm(rn);
        if (en < error) {
          x = next;
          r = rn;
          error = en;
          lambda = Math.max(lambda / 10, 1e-12);
          improved = true;
          continue;
        }
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { x, residual: error, iterations };
}

/** Determinant of a small square matrix (Gaussian elimination with partial pivoting). */
export function determinant(m: readonly (readonly number[])[]): number {
  const n = m.length;
  const a = m.map((row) => [...row]);
  let det = 1;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (
        Math.abs((a[r] as number[])[col] as number) >
        Math.abs((a[pivot] as number[])[col] as number)
      ) {
        pivot = r;
      }
    }
    const pr = a[pivot] as number[];
    const p = pr[col] as number;
    if (p === 0) return 0;
    if (pivot !== col) {
      a[pivot] = a[col] as number[];
      a[col] = pr;
      det = -det;
    }
    det *= p;
    for (let r = col + 1; r < n; r++) {
      const other = a[r] as number[];
      const f = (other[col] as number) / p;
      for (let k = col; k < n; k++) other[k] = (other[k] as number) - f * (pr[k] as number);
    }
  }
  return det;
}

/**
 * Orientation of `j` (rows x n) in the column space of `reference`: the sign of
 * det(U^T j) with U the reference's n leading left singular vectors. Along a branch it keeps
 * its sign; the other assembly mode at the same drivers has the opposite one. 0 when the
 * reference is singular.
 */
export function orientation(
  reference: readonly (readonly number[])[],
  j: readonly (readonly number[])[],
  n: number,
): number {
  const { singular, vectors, rank } = analyze(reference, n);
  if (rank < n) return 0;
  const u = Array.from({ length: n }, (_, k) =>
    reference.map(
      (row) =>
        row.reduce((sum, v, c) => sum + v * ((vectors[c] as number[])[k] as number), 0) /
        (singular[k] as number),
    ),
  );
  const m = u.map((uk) =>
    Array.from({ length: n }, (_, c) =>
      j.reduce((sum, row, r) => sum + (uk[r] as number) * (row[c] as number), 0),
    ),
  );
  return Math.sign(determinant(m));
}
