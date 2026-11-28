// Compressed sparse row matrices and the Jacobi-preconditioned conjugate gradient method
// (Hestenes and Stiefel 1952; preconditioned form as in Saad, Iterative Methods, algorithm 9.1).
// Symmetric positive definite systems only; the caller checks the returned residual.

import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';

export interface Csr {
  readonly n: number;
  readonly rowStart: Uint32Array;
  readonly col: Uint32Array;
  readonly value: Float64Array;
}

/** Accumulates (row, col, value) entries; duplicates are summed when built. */
export class Triplets {
  readonly rows: number[] = [];
  readonly cols: number[] = [];
  readonly values: number[] = [];
  readonly n: number;
  constructor(n: number) {
    this.n = n;
  }

  add(row: number, col: number, value: number): void {
    this.rows.push(row);
    this.cols.push(col);
    this.values.push(value);
  }

  build(): Csr {
    const n = this.n;
    const count = new Uint32Array(n + 1);
    for (const r of this.rows) count[r + 1] = (count[r + 1] as number) + 1;
    for (let i = 0; i < n; i++) count[i + 1] = (count[i + 1] as number) + (count[i] as number);
    const order = new Uint32Array(this.rows.length);
    const fill = count.slice(0, n);
    for (let k = 0; k < this.rows.length; k++) {
      const r = this.rows[k] as number;
      order[fill[r] as number] = k;
      fill[r] = (fill[r] as number) + 1;
    }
    const rowStart = new Uint32Array(n + 1);
    const col: number[] = [];
    const value: number[] = [];
    for (let r = 0; r < n; r++) {
      const entries = Array.from(order.subarray(count[r], count[r + 1])).sort(
        (a, b) => (this.cols[a] as number) - (this.cols[b] as number) || a - b,
      );
      rowStart[r] = col.length;
      for (const k of entries) {
        const c = this.cols[k] as number;
        if (col.length > (rowStart[r] as number) && col[col.length - 1] === c)
          value[value.length - 1] =
            (value[value.length - 1] as number) + (this.values[k] as number);
        else {
          col.push(c);
          value.push(this.values[k] as number);
        }
      }
    }
    rowStart[n] = col.length;
    return { n, rowStart, col: new Uint32Array(col), value: new Float64Array(value) };
  }
}

export function multiply(a: Csr, x: Float64Array, out: Float64Array): void {
  for (let r = 0; r < a.n; r++) {
    let s = 0;
    for (let k = a.rowStart[r] as number; k < (a.rowStart[r + 1] as number); k++)
      s += (a.value[k] as number) * (x[a.col[k] as number] as number);
    out[r] = s;
  }
}

export function dotN(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

export interface CgOptions {
  /** Stop when ||b - A x|| <= tolerance * ||b|| (default 1e-12). */
  readonly tolerance?: number;
  readonly maxIterations?: number;
  /** Initial guess (copied). */
  readonly x0?: Float64Array;
}

export interface CgResult {
  readonly x: Float64Array;
  readonly iterations: number;
  /** Relative residual ||b - A x|| / ||b||, recomputed from scratch after the iteration. */
  readonly residual: number;
}

export function conjugateGradient(
  a: Csr,
  b: Float64Array,
  options: CgOptions = {},
): Result<CgResult, ModelingError> {
  const n = a.n;
  const tolerance = options.tolerance ?? 1e-12;
  const maxIterations = options.maxIterations ?? 20 * n + 100;
  const inv = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    let d = 0;
    for (let k = a.rowStart[r] as number; k < (a.rowStart[r + 1] as number); k++)
      if (a.col[k] === r) d += a.value[k] as number;
    if (!(d > 0))
      return err(
        modelingError('model-solver-diverged', 'a positive diagonal (SPD system)', {
          method: 'pcg',
          reason: 'non-positive-diagonal',
          row: r,
        }),
      );
    inv[r] = 1 / d;
  }
  const bNorm = Math.sqrt(dotN(b, b));
  const x = options.x0 === undefined ? new Float64Array(n) : Float64Array.from(options.x0);
  if (bNorm === 0) return ok({ x: new Float64Array(n), iterations: 0, residual: 0 });
  const r = new Float64Array(n);
  multiply(a, x, r);
  for (let i = 0; i < n; i++) r[i] = (b[i] as number) - (r[i] as number);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = (r[i] as number) * (inv[i] as number);
  const p = Float64Array.from(z);
  const ap = new Float64Array(n);
  let rz = dotN(r, z);
  let iterations = 0;
  while (iterations < maxIterations && Math.sqrt(dotN(r, r)) > tolerance * bNorm) {
    multiply(a, p, ap);
    const pap = dotN(p, ap);
    if (!(pap > 0))
      return err(
        modelingError('model-solver-diverged', 'p^T A p > 0 (SPD system)', {
          method: 'pcg',
          reason: 'not-positive-definite',
          iterations,
        }),
      );
    const alpha = rz / pap;
    for (let i = 0; i < n; i++) {
      x[i] = (x[i] as number) + alpha * (p[i] as number);
      r[i] = (r[i] as number) - alpha * (ap[i] as number);
      z[i] = (r[i] as number) * (inv[i] as number);
    }
    const next = dotN(r, z);
    const beta = next / rz;
    rz = next;
    for (let i = 0; i < n; i++) p[i] = (z[i] as number) + beta * (p[i] as number);
    iterations++;
  }
  multiply(a, x, r);
  for (let i = 0; i < n; i++) r[i] = (b[i] as number) - (r[i] as number);
  const residual = Math.sqrt(dotN(r, r)) / bNorm;
  // The recurrence residual drifts from the true one; accept a small factor before failing.
  if (!(residual <= 100 * tolerance))
    return err(
      modelingError('model-solver-diverged', `relative residual <= ${100 * tolerance}`, {
        method: 'pcg',
        reason: 'no-convergence',
        iterations,
        residual,
      }),
    );
  return ok({ x, iterations, residual });
}
