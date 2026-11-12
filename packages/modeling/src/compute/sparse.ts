import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';
import type { BackendOutput, SolveSparseParams, WorkMeter } from './job';

/** Compressed sparse rows: columns ascend within each row and duplicates are summed. */
export interface CsrMatrix {
  readonly rows: number;
  readonly cols: number;
  readonly rowPtr: Int32Array;
  readonly colIdx: Int32Array;
  readonly values: Float64Array;
}

/** Coordinate triplets collected by an assembler before compression. */
export class TripletList {
  readonly rowsOf: number[] = [];
  readonly colsOf: number[] = [];
  readonly valuesOf: number[] = [];
  readonly rows: number;
  readonly cols: number;

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
  }

  add(row: number, col: number, value: number): void {
    if (value === 0) return;
    this.rowsOf.push(row);
    this.colsOf.push(col);
    this.valuesOf.push(value);
  }

  /** Compress to CSR; duplicates are summed in `add` order, so equal call sequences give equal bits. */
  toCsr(): CsrMatrix {
    const n = this.valuesOf.length;
    const counts = new Int32Array(this.rows + 1);
    for (let k = 0; k < n; k++) {
      const r = (this.rowsOf[k] as number) + 1;
      counts[r] = (counts[r] as number) + 1;
    }
    const start = new Int32Array(this.rows + 1);
    for (let i = 0; i < this.rows; i++) {
      start[i + 1] = (start[i] as number) + (counts[i + 1] as number);
    }
    const order = new Int32Array(n);
    const fill = start.slice(0, this.rows);
    for (let k = 0; k < n; k++) {
      const r = this.rowsOf[k] as number;
      order[fill[r] as number] = k;
      fill[r] = (fill[r] as number) + 1;
    }
    const rowPtr = new Int32Array(this.rows + 1);
    const colIdx: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < this.rows; i++) {
      const slice = Array.from(order.subarray(start[i] as number, start[i + 1] as number));
      // Stable by column, then by insertion, so duplicate sums are history-defined.
      slice.sort((a, b) => (this.colsOf[a] as number) - (this.colsOf[b] as number) || a - b);
      for (const k of slice) {
        const c = this.colsOf[k] as number;
        const v = this.valuesOf[k] as number;
        if (colIdx.length > (rowPtr[i] as number) && colIdx[colIdx.length - 1] === c) {
          values[values.length - 1] = (values[values.length - 1] as number) + v;
        } else {
          colIdx.push(c);
          values.push(v);
        }
      }
      rowPtr[i + 1] = colIdx.length;
    }
    return {
      rows: this.rows,
      cols: this.cols,
      rowPtr,
      colIdx: Int32Array.from(colIdx),
      values: Float64Array.from(values),
    };
  }
}

/** y = A x */
export function multiply(a: CsrMatrix, x: Float64Array, y: Float64Array): void {
  for (let i = 0; i < a.rows; i++) {
    let sum = 0;
    for (let k = a.rowPtr[i] as number; k < (a.rowPtr[i + 1] as number); k++) {
      sum += (a.values[k] as number) * (x[a.colIdx[k] as number] as number);
    }
    y[i] = sum;
  }
}

/** y = A^T x */
export function multiplyTransposed(a: CsrMatrix, x: Float64Array, y: Float64Array): void {
  y.fill(0);
  for (let i = 0; i < a.rows; i++) {
    const xi = x[i] as number;
    if (xi === 0) continue;
    for (let k = a.rowPtr[i] as number; k < (a.rowPtr[i + 1] as number); k++) {
      const c = a.colIdx[k] as number;
      y[c] = (y[c] as number) + (a.values[k] as number) * xi;
    }
  }
}

function dotOf(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

const CSR_MAGIC = 0x53435846; // "FXCS" little-endian
const CSR_HEADER = 16;

/**
 * Canonical CSR bytes of a solve.sparse input: header (magic, rows, cols, nnz as
 * little-endian int32), rowPtr and colIdx (int32), values (float64), all little-endian.
 */
export function encodeCsr(a: CsrMatrix): Uint8Array {
  const nnz = a.values.length;
  const bytes = new Uint8Array(CSR_HEADER + (a.rows + 1 + nnz) * 4 + nnz * 8);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, CSR_MAGIC, true);
  view.setInt32(4, a.rows, true);
  view.setInt32(8, a.cols, true);
  view.setInt32(12, nnz, true);
  let o = CSR_HEADER;
  for (const v of a.rowPtr) {
    view.setInt32(o, v, true);
    o += 4;
  }
  for (const v of a.colIdx) {
    view.setInt32(o, v, true);
    o += 4;
  }
  for (const v of a.values) {
    view.setFloat64(o, v, true);
    o += 8;
  }
  return bytes;
}

export function encodeVector(v: Float64Array): Uint8Array {
  const bytes = new Uint8Array(v.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < v.length; i++) view.setFloat64(i * 8, v[i] as number, true);
  return bytes;
}

export function decodeVector(bytes: Uint8Array): Float64Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(bytes.byteLength >> 3);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat64(i * 8, true);
  return out;
}

function invalid(expected: string, detail: Record<string, unknown>): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

export function decodeCsr(bytes: Uint8Array): Result<CsrMatrix, ModelingError> {
  if (bytes.byteLength < CSR_HEADER) return err(invalid('a CSR input of at least 16 bytes', {}));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [magic, rows, cols, nnz] = [0, 4, 8, 12].map((o) => view.getInt32(o, true)) as [
    number,
    number,
    number,
    number,
  ];
  if (magic !== CSR_MAGIC || rows < 0 || cols < 0 || nnz < 0) {
    return err(invalid('the input starts with the FXCS header', { rows, cols, nnz }));
  }
  if (bytes.byteLength !== CSR_HEADER + (rows + 1 + nnz) * 4 + nnz * 8) {
    return err(invalid('the CSR byte length matches its header', { rows, cols, nnz }));
  }
  const rowPtr = new Int32Array(rows + 1);
  const colIdx = new Int32Array(nnz);
  const values = new Float64Array(nnz);
  let o = CSR_HEADER;
  for (let i = 0; i <= rows; i++, o += 4) rowPtr[i] = view.getInt32(o, true);
  for (let i = 0; i < nnz; i++, o += 4) colIdx[i] = view.getInt32(o, true);
  for (let i = 0; i < nnz; i++, o += 8) values[i] = view.getFloat64(o, true);
  if (rowPtr[0] !== 0 || rowPtr[rows] !== nnz) {
    return err(invalid('rowPtr runs from 0 to nnz', { rows, nnz }));
  }
  for (let i = 0; i < rows; i++) {
    if ((rowPtr[i + 1] as number) < (rowPtr[i] as number)) {
      return err(invalid('rowPtr does not decrease', { row: i }));
    }
  }
  for (let k = 0; k < nnz; k++) {
    const c = colIdx[k] as number;
    if (c < 0 || c >= cols || !Number.isFinite(values[k] as number)) {
      return err(invalid('column indices are in range and values are finite', { entry: k }));
    }
  }
  return ok({ rows, cols, rowPtr, colIdx, values });
}

export interface SolveOutcome {
  readonly x: Float64Array;
  readonly iterations: number;
  /** Relative residual: ||b - Ax|| / ||b|| (CG), ||A^T(b - Ax)|| / ||A^T b|| (CGLS). */
  readonly residual: number;
}

export const DEFAULT_SOLVE_TOLERANCE = 1e-10;

function diverged(
  method: string,
  iterations: number,
  residual: number,
  why: string,
  hint: string,
): ModelingError {
  return modelingError(
    'model-solver-diverged',
    `the ${method} iteration converges (${why})`,
    { method, iterations, residual },
    hint,
  );
}

/**
 * Solve A x = b (SPD A) by conjugate gradients, optionally Jacobi-preconditioned,
 * or min ||A x - b|| by CGLS (CG on the normal equations without forming A^T A;
 * Jacobi scaling uses the column norms). Every iteration spends work units for its
 * matrix products; all sums run in a fixed order, so results are bit-reproducible.
 */
export function solveSparse(
  a: CsrMatrix,
  b: Float64Array,
  params: SolveSparseParams,
  work: WorkMeter,
  initial?: Float64Array,
): Result<SolveOutcome, ModelingError> {
  const { method } = params;
  const tolerance = params.tolerance ?? DEFAULT_SOLVE_TOLERANCE;
  if (!(tolerance > 0 && tolerance < 1)) {
    return err(invalid('tolerance is in (0, 1)', { tolerance }));
  }
  if (b.length !== a.rows) {
    return err(
      invalid('the right-hand side has one value per row', { rows: a.rows, rhs: b.length }),
    );
  }
  const square = method !== 'cgls';
  if (square && a.rows !== a.cols) {
    return err(invalid(`${method} takes a square matrix`, { rows: a.rows, cols: a.cols }));
  }
  if (initial !== undefined && initial.length !== a.cols) {
    return err(invalid('the initial guess has one value per column', { cols: a.cols }));
  }
  const bad = nonFinite(a, b, initial);
  if (bad !== undefined) return err(invalid(`${bad} holds only finite values`, { input: bad }));
  const maxIterations = params.maxIterations ?? Math.max(100, 4 * a.cols);
  if (!(Number.isInteger(maxIterations) && maxIterations >= 1)) {
    return err(invalid('maxIterations is an integer >= 1', { maxIterations }));
  }
  return square
    ? conjugateGradient(a, b, method === 'pcg-jacobi', tolerance, maxIterations, work, initial)
    : cgls(a, b, params.precondition !== 'none', tolerance, maxIterations, work, initial);
}

function nonFinite(a: CsrMatrix, b: Float64Array, initial?: Float64Array): string | undefined {
  const all = (v: ArrayLike<number>) => {
    for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i] as number)) return false;
    return true;
  };
  if (!all(a.values)) return 'the matrix';
  if (!all(b)) return 'the right-hand side';
  if (initial !== undefined && !all(initial)) return 'the initial guess';
  return undefined;
}

function failed(work: WorkMeter): ModelingError {
  return work.failure as ModelingError;
}

function conjugateGradient(
  a: CsrMatrix,
  b: Float64Array,
  jacobi: boolean,
  tolerance: number,
  maxIterations: number,
  work: WorkMeter,
  initial?: Float64Array,
): Result<SolveOutcome, ModelingError> {
  const n = a.rows;
  const method = jacobi ? 'pcg-jacobi' : 'cg';
  const inverse = new Float64Array(n).fill(1);
  if (jacobi) {
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let k = a.rowPtr[i] as number; k < (a.rowPtr[i + 1] as number); k++) {
        if (a.colIdx[k] === i) d += a.values[k] as number;
      }
      if (!(d > 0)) {
        return err(
          diverged(
            method,
            0,
            Number.NaN,
            `diagonal ${i} is positive`,
            'the matrix is not positive definite; check the assembly',
          ),
        );
      }
      inverse[i] = 1 / d;
    }
  }
  const x = initial === undefined ? new Float64Array(n) : initial.slice();
  const r = new Float64Array(n);
  const q = new Float64Array(n);
  multiply(a, x, q);
  for (let i = 0; i < n; i++) r[i] = (b[i] as number) - (q[i] as number);
  const norm = Math.sqrt(dotOf(b, b));
  if (norm === 0) return ok({ x: new Float64Array(n), iterations: 0, residual: 0 });
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = (r[i] as number) * (inverse[i] as number);
  const p = z.slice();
  let rz = dotOf(r, z);
  let residual = Math.sqrt(dotOf(r, r)) / norm;
  let iterations = 0;
  while (!(residual <= tolerance)) {
    if (iterations >= maxIterations) {
      return err(
        diverged(
          method,
          iterations,
          residual,
          `relative residual <= ${tolerance} within ${maxIterations} iterations`,
          'raise maxIterations or loosen tolerance; an ill-conditioned system may need the native backend',
        ),
      );
    }
    if (!work.spend(a.values.length + 4 * n)) return err(failed(work));
    multiply(a, p, q);
    const pq = dotOf(p, q);
    if (!(pq > 0)) {
      return err(
        diverged(
          method,
          iterations,
          residual,
          'p^T A p stays positive',
          'the matrix is not positive definite (or is singular); check the assembly and constraints',
        ),
      );
    }
    const alpha = rz / pq;
    for (let i = 0; i < n; i++) {
      x[i] = (x[i] as number) + alpha * (p[i] as number);
      r[i] = (r[i] as number) - alpha * (q[i] as number);
      z[i] = (r[i] as number) * (inverse[i] as number);
    }
    const next = dotOf(r, z);
    const beta = next / rz;
    rz = next;
    for (let i = 0; i < n; i++) p[i] = (z[i] as number) + beta * (p[i] as number);
    residual = Math.sqrt(dotOf(r, r)) / norm;
    iterations++;
    if (!Number.isFinite(residual)) {
      return err(
        diverged(
          method,
          iterations,
          residual,
          'the residual stays finite',
          'check the assembly for NaN or huge values',
        ),
      );
    }
  }
  return ok({ x, iterations, residual });
}

function cgls(
  a: CsrMatrix,
  b: Float64Array,
  jacobi: boolean,
  tolerance: number,
  maxIterations: number,
  work: WorkMeter,
  initial?: Float64Array,
): Result<SolveOutcome, ModelingError> {
  const method = 'cgls';
  const n = a.cols;
  const m = a.rows;
  // Column scaling D = diag(A^T A)^(-1/2): CGLS runs on A D, then x = D y.
  const scale = new Float64Array(n).fill(1);
  if (jacobi) {
    const squares = new Float64Array(n);
    for (let k = 0; k < a.values.length; k++) {
      const c = a.colIdx[k] as number;
      squares[c] = (squares[c] as number) + (a.values[k] as number) * (a.values[k] as number);
    }
    for (let c = 0; c < n; c++) {
      const s = squares[c] as number;
      if (!(s > 0)) {
        return err(
          diverged(
            method,
            0,
            Number.NaN,
            `column ${c} is not empty`,
            'an unknown appears in no equation; the system is singular',
          ),
        );
      }
      scale[c] = 1 / Math.sqrt(s);
    }
  }
  const y = new Float64Array(n);
  if (initial !== undefined)
    for (let c = 0; c < n; c++) y[c] = (initial[c] as number) / (scale[c] as number);
  const scaled = new Float64Array(n);
  const r = new Float64Array(m);
  const q = new Float64Array(m);
  const apply = (v: Float64Array, out: Float64Array) => {
    for (let c = 0; c < n; c++) scaled[c] = (v[c] as number) * (scale[c] as number);
    multiply(a, scaled, out);
  };
  const applyT = (v: Float64Array, out: Float64Array) => {
    multiplyTransposed(a, v, out);
    for (let c = 0; c < n; c++) out[c] = (out[c] as number) * (scale[c] as number);
  };
  apply(y, q);
  for (let i = 0; i < m; i++) r[i] = (b[i] as number) - (q[i] as number);
  const s = new Float64Array(n);
  applyT(b, s);
  const norm = Math.sqrt(dotOf(s, s));
  const finish = (iterations: number, residual: number) => {
    const x = new Float64Array(n);
    for (let c = 0; c < n; c++) x[c] = (y[c] as number) * (scale[c] as number);
    return ok({ x, iterations, residual });
  };
  if (norm === 0) {
    y.fill(0);
    return finish(0, 0);
  }
  applyT(r, s);
  const p = s.slice();
  let gamma = dotOf(s, s);
  let residual = Math.sqrt(gamma) / norm;
  let iterations = 0;
  while (!(residual <= tolerance)) {
    if (iterations >= maxIterations) {
      return err(
        diverged(
          method,
          iterations,
          residual,
          `relative normal residual <= ${tolerance} within ${maxIterations} iterations`,
          'raise maxIterations or loosen tolerance; an ill-conditioned system may need the native backend',
        ),
      );
    }
    if (!work.spend(2 * a.values.length + 4 * (n + m))) return err(failed(work));
    apply(p, q);
    const qq = dotOf(q, q);
    if (!(qq > 0)) {
      return err(
        diverged(
          method,
          iterations,
          residual,
          '||A p|| stays positive',
          'the least-squares system is rank deficient; add constraints (pins)',
        ),
      );
    }
    const alpha = gamma / qq;
    for (let c = 0; c < n; c++) y[c] = (y[c] as number) + alpha * (p[c] as number);
    for (let i = 0; i < m; i++) r[i] = (r[i] as number) - alpha * (q[i] as number);
    applyT(r, s);
    const next = dotOf(s, s);
    const beta = next / gamma;
    gamma = next;
    for (let c = 0; c < n; c++) p[c] = (s[c] as number) + beta * (p[c] as number);
    residual = Math.sqrt(gamma) / norm;
    iterations++;
    if (!Number.isFinite(residual)) {
      return err(
        diverged(
          method,
          iterations,
          residual,
          'the residual stays finite',
          'check the assembly for NaN or huge values',
        ),
      );
    }
  }
  return finish(iterations, residual);
}

/** Job entry: inputs [CSR, rhs, initial?]; output [solution]. */
export function runSolveJob(
  inputs: readonly Uint8Array[],
  params: SolveSparseParams,
  work: WorkMeter,
): Result<BackendOutput<'solve.sparse'>, ModelingError> {
  if (inputs.length < 2 || inputs.length > 3) {
    return err(
      invalid('solve.sparse takes [CSR, rhs] or [CSR, rhs, initial]', { inputs: inputs.length }),
    );
  }
  const a = decodeCsr(inputs[0] as Uint8Array);
  if (!a.ok) return a;
  const solved = solveSparse(
    a.value,
    decodeVector(inputs[1] as Uint8Array),
    params,
    work,
    inputs[2] === undefined ? undefined : decodeVector(inputs[2]),
  );
  if (!solved.ok) return solved;
  return ok({
    status: 'ok',
    outputs: [encodeVector(solved.value.x)],
    provenance: null,
    metrics: {
      rows: a.value.rows,
      cols: a.value.cols,
      nnz: a.value.values.length,
      iterations: solved.value.iterations,
      residual: solved.value.residual,
    },
    locations: [],
  });
}

/** Largest envelope (stored lower-triangle entries) the direct least-squares solve takes on. */
const ENVELOPE_LIMIT = 16_000_000;
/** A pivot below this fraction of its diagonal entry means a (numerically) singular system. */
const PIVOT_FLOOR = 1e-14;

/**
 * Direct least squares: Cholesky of the normal matrix A^T A in envelope (profile)
 * storage under a reverse Cuthill-McKee column order. Exact up to rounding where CGLS
 * on an ill-conditioned system (slivers next to large triangles) needs on the order
 * of n iterations. Returns undefined when the envelope exceeds ENVELOPE_LIMIT or a
 * pivot falls below PIVOT_FLOOR of its diagonal (the caller falls back to CGLS).
 */
export function leastSquaresCholesky(
  a: CsrMatrix,
  b: Float64Array,
  work: WorkMeter,
): Result<SolveOutcome, ModelingError> | undefined {
  const n = a.cols;
  if (n === 0) return undefined;
  // Column graph: columns that share a row.
  const neighbors: number[][] = Array.from({ length: n }, () => []);
  if (!work.spend(a.values.length * 4)) return err(failed(work));
  for (let r = 0; r < a.rows; r++) {
    for (let p = a.rowPtr[r] as number; p < (a.rowPtr[r + 1] as number); p++) {
      for (let q = p + 1; q < (a.rowPtr[r + 1] as number); q++) {
        (neighbors[a.colIdx[p] as number] as number[]).push(a.colIdx[q] as number);
        (neighbors[a.colIdx[q] as number] as number[]).push(a.colIdx[p] as number);
      }
    }
  }
  for (const [c, list] of neighbors.entries()) {
    const unique = [...new Set(list)].sort((x, y) => x - y);
    neighbors[c] = unique;
  }
  const order = reverseCuthillMcKee(neighbors);
  const position = new Int32Array(n);
  for (const [i, c] of order.entries()) position[c] = i;
  const first = new Int32Array(n);
  const offset = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    let f = i;
    for (const c of neighbors[order[i] as number] as number[])
      f = Math.min(f, position[c] as number);
    first[i] = f;
    offset[i + 1] = (offset[i] as number) + (i - f + 1);
  }
  const size = offset[n] as number;
  if (size > ENVELOPE_LIMIT) return undefined;
  // Row i holds columns first[i]..i at env[offset[i] + (j - first[i])].
  const env = new Float64Array(size);
  const at = (i: number, j: number) => (offset[i] as number) + j - (first[i] as number);
  const rhs = new Float64Array(n);
  for (let r = 0; r < a.rows; r++) {
    const from = a.rowPtr[r] as number;
    const to = a.rowPtr[r + 1] as number;
    for (let p = from; p < to; p++) {
      const i = position[a.colIdx[p] as number] as number;
      const vp = a.values[p] as number;
      rhs[i] = (rhs[i] as number) + vp * (b[r] as number);
      for (let q = from; q < to; q++) {
        const j = position[a.colIdx[q] as number] as number;
        if (j > i) continue;
        const k = at(i, j);
        env[k] = (env[k] as number) + vp * (a.values[q] as number);
      }
    }
  }
  let norm = 0;
  for (let i = 0; i < n; i++) norm += (rhs[i] as number) * (rhs[i] as number);
  norm = Math.sqrt(norm);
  for (let i = 0; i < n; i++) {
    const fi = first[i] as number;
    const oi = (offset[i] as number) - fi;
    if (!work.spend(1 + ((i - fi) * (i - fi + 1)) / 2)) return err(failed(work));
    for (let j = fi; j < i; j++) {
      const fj = first[j] as number;
      const oj = (offset[j] as number) - fj;
      let s = env[oi + j] as number;
      for (let k = Math.max(fi, fj); k < j; k++)
        s -= (env[oi + k] as number) * (env[oj + k] as number);
      env[oi + j] = s / (env[oj + j] as number);
    }
    const diagonal = env[oi + i] as number;
    let d = diagonal;
    for (let k = fi; k < i; k++) d -= (env[oi + k] as number) * (env[oi + k] as number);
    if (!(d > PIVOT_FLOOR * diagonal) || !Number.isFinite(d)) return undefined;
    env[oi + i] = Math.sqrt(d);
  }
  const y = rhs.slice();
  for (let i = 0; i < n; i++) {
    const fi = first[i] as number;
    const oi = (offset[i] as number) - fi;
    let s = y[i] as number;
    for (let k = fi; k < i; k++) s -= (env[oi + k] as number) * (y[k] as number);
    y[i] = s / (env[oi + i] as number);
  }
  for (let i = n - 1; i >= 0; i--) {
    const fi = first[i] as number;
    const oi = (offset[i] as number) - fi;
    const v = (y[i] as number) / (env[oi + i] as number);
    y[i] = v;
    for (let k = fi; k < i; k++) y[k] = (y[k] as number) - (env[oi + k] as number) * v;
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[order[i] as number] = y[i] as number;
  if (!work.spend(2 * size + 4 * a.values.length)) return err(failed(work));
  // Normal residual ||A^T (b - A x)|| / ||A^T b||, as CGLS reports it.
  const r = new Float64Array(a.rows);
  multiply(a, x, r);
  for (let i = 0; i < a.rows; i++) r[i] = (b[i] as number) - (r[i] as number);
  const g = new Float64Array(n);
  multiplyTransposed(a, r, g);
  const residual = norm > 0 ? Math.sqrt(dotOf(g, g)) / norm : 0;
  return ok({ x, iterations: 0, residual });
}

/** Reverse Cuthill-McKee order of a symmetric graph, each component from a low-degree peripheral node. */
function reverseCuthillMcKee(neighbors: readonly (readonly number[])[]): number[] {
  const n = neighbors.length;
  const placed = new Uint8Array(n);
  const order: number[] = [];
  const degree = (v: number) => (neighbors[v] as readonly number[]).length;
  const levels = (start: number, seen: Int32Array, stamp: number) => {
    let frontier = [start];
    seen[start] = stamp;
    let last = frontier;
    while (frontier.length > 0) {
      last = frontier;
      const next: number[] = [];
      for (const v of frontier) {
        for (const w of neighbors[v] as readonly number[]) {
          if (seen[w] === stamp || placed[w] === 1) continue;
          seen[w] = stamp;
          next.push(w);
        }
      }
      frontier = next;
    }
    let best = last[0] as number;
    for (const v of last)
      if (degree(v) < degree(best) || (degree(v) === degree(best) && v < best)) best = v;
    return best;
  };
  const seen = new Int32Array(n).fill(-1);
  let stamp = 0;
  for (let s = 0; s < n; s++) {
    if (placed[s] === 1) continue;
    const start = levels(levels(s, seen, stamp++), seen, stamp++);
    const queue = [start];
    placed[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head] as number;
      order.push(v);
      const next = (neighbors[v] as readonly number[])
        .filter((w) => placed[w] === 0)
        .sort((x, y) => degree(x) - degree(y) || x - y);
      for (const w of next) {
        placed[w] = 1;
        queue.push(w);
      }
    }
  }
  return order.reverse();
}
