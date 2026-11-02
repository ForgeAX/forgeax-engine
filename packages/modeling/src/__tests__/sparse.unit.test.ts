import { describe, expect, it } from 'vitest';
import { runComputeJob, WorkMeter } from '../compute/job';
import {
  type CsrMatrix,
  decodeCsr,
  decodeVector,
  encodeCsr,
  encodeVector,
  leastSquaresCholesky,
  multiply,
  solveSparse,
  TripletList,
} from '../compute/sparse';
import { tsUvBackend } from '../compute/uv-backend';

/** 1D Poisson matrix tridiag(-1, 2, -1) (SPD). */
function laplacian(n: number): CsrMatrix {
  const t = new TripletList(n, n);
  for (let i = 0; i < n; i++) {
    t.add(i, i, 2);
    if (i > 0) t.add(i, i - 1, -1);
    if (i + 1 < n) t.add(i, i + 1, -1);
  }
  return t.toCsr();
}

function apply(a: CsrMatrix, x: Float64Array): Float64Array {
  const y = new Float64Array(a.rows);
  multiply(a, x, y);
  return y;
}

const work = () => new WorkMeter(1e9);

describe('solve.sparse', () => {
  it('TripletList sums duplicates in insertion order and sorts columns', () => {
    const t = new TripletList(2, 3);
    t.add(1, 2, 1);
    t.add(0, 1, 2);
    t.add(1, 0, 3);
    t.add(1, 2, 0.5);
    t.add(0, 0, 0);
    const a = t.toCsr();
    expect(Array.from(a.rowPtr)).toEqual([0, 1, 3]);
    expect(Array.from(a.colIdx)).toEqual([1, 0, 2]);
    expect(Array.from(a.values)).toEqual([2, 3, 1.5]);
    const round = decodeCsr(encodeCsr(a));
    if (!round.ok) throw round.error;
    expect(encodeCsr(round.value)).toEqual(encodeCsr(a));
    expect(decodeCsr(new Uint8Array(20)).ok).toBe(false);
  });

  it('CG solves an SPD system to the requested relative residual', () => {
    const a = laplacian(60);
    const exact = Float64Array.from({ length: 60 }, (_, i) => Math.sin(i / 7) + i / 60);
    const b = apply(a, exact);
    const r = solveSparse(a, b, { method: 'cg', tolerance: 1e-12 }, work());
    if (!r.ok) throw r.error;
    expect(r.value.residual).toBeLessThanOrEqual(1e-12);
    expect(r.value.iterations).toBeLessThanOrEqual(60 + 5);
    for (let i = 0; i < 60; i++) expect(r.value.x[i]).toBeCloseTo(exact[i] as number, 8);
  });

  it('Jacobi preconditioning helps a badly scaled system (falsified by plain CG)', () => {
    // A weak coupling over a diagonal spread across four decades.
    const t = new TripletList(80, 80);
    for (let i = 0; i < 80; i++) {
      t.add(i, i, 0.2 + 10 ** ((4 * i) / 79));
      if (i > 0) t.add(i, i - 1, -0.1);
      if (i < 79) t.add(i, i + 1, -0.1);
    }
    const a = t.toCsr();
    const b = apply(a, new Float64Array(80).fill(1));
    const plain = solveSparse(
      a,
      b,
      { method: 'cg', tolerance: 1e-10, maxIterations: 4000 },
      work(),
    );
    const jacobi = solveSparse(a, b, { method: 'pcg-jacobi', tolerance: 1e-10 }, work());
    if (!plain.ok || !jacobi.ok) throw new Error('both converge');
    expect(jacobi.value.iterations).toBeLessThan(plain.value.iterations / 2);
    for (const x of jacobi.value.x) expect(x).toBeCloseTo(1, 6);
  });

  it('CGLS solves an overdetermined least-squares fit (line through noisy points)', () => {
    const xs = [0, 1, 2, 3, 4, 5];
    const ys = [1.1, 2.9, 5.2, 7.1, 8.8, 11.2];
    const t = new TripletList(xs.length, 2);
    for (const [i, x] of xs.entries()) {
      t.add(i, 0, x);
      t.add(i, 1, 1);
    }
    const r = solveSparse(
      t.toCsr(),
      Float64Array.from(ys),
      { method: 'cgls', tolerance: 1e-13 },
      work(),
    );
    if (!r.ok) throw r.error;
    // Normal equations of the line fit, solved in closed form.
    const n = xs.length;
    const sx = xs.reduce((s, x) => s + x, 0);
    const sy = ys.reduce((s, y) => s + y, 0);
    const sxx = xs.reduce((s, x) => s + x * x, 0);
    const sxy = xs.reduce((s, x, i) => s + x * (ys[i] as number), 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    expect(r.value.x[0]).toBeCloseTo(slope, 10);
    expect(r.value.x[1]).toBeCloseTo((sy - slope * sx) / n, 10);
    const unscaled = solveSparse(
      t.toCsr(),
      Float64Array.from(ys),
      { method: 'cgls', tolerance: 1e-13, precondition: 'none' },
      work(),
    );
    if (!unscaled.ok) throw unscaled.error;
    expect(unscaled.value.x[0]).toBeCloseTo(slope, 10);
  });

  it('the direct least-squares solve matches CGLS on a scattered system, and declines a singular one', () => {
    // A 2D grid Laplacian with one pinned corner, columns in a scrambled order, plus a
    // badly scaled row: the profile solve reorders it and agrees with a tight CGLS.
    const side = 12;
    const n = side * side;
    const scramble = (k: number) => (k * 37) % n;
    const t = new TripletList(2 * n + 1, n);
    let row = 0;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const k = y * side + x;
        if (x + 1 < side) {
          t.add(row, scramble(k), 1);
          t.add(row, scramble(k + 1), -1);
        }
        row++;
        if (y + 1 < side) {
          t.add(row, scramble(k), 1e3);
          t.add(row, scramble(k + side), -1e3);
        }
        row++;
      }
    }
    t.add(row, scramble(0), 1);
    const a = t.toCsr();
    const b = Float64Array.from({ length: a.rows }, (_, i) => Math.sin(i));
    const direct = leastSquaresCholesky(a, b, work());
    if (direct === undefined || !direct.ok) throw new Error('direct solve declined');
    const iterative = solveSparse(
      a,
      b,
      { method: 'cgls', tolerance: 1e-14, maxIterations: 100000 },
      work(),
    );
    if (!iterative.ok) throw iterative.error;
    for (let c = 0; c < n; c++) {
      expect(direct.value.x[c]).toBeCloseTo(iterative.value.x[c] as number, 6);
    }
    expect(direct.value.residual).toBeLessThan(1e-9);
    // Without the pin the normal matrix is singular: no positive pivot, the caller falls back.
    const free = new TripletList(2, 2);
    free.add(0, 0, 1);
    free.add(0, 1, -1);
    free.add(1, 0, -1);
    free.add(1, 1, 1);
    expect(leastSquaresCholesky(free.toCsr(), Float64Array.from([1, 1]), work())).toBeUndefined();
    expect(leastSquaresCholesky(a, b, new WorkMeter(10))?.ok).toBe(false);
  });

  it('indefinite matrices, iteration caps and non-finite input fail model-solver-diverged', () => {
    const t = new TripletList(2, 2);
    t.add(0, 0, 1);
    t.add(1, 1, -1);
    const indefinite = solveSparse(t.toCsr(), Float64Array.from([1, 1]), { method: 'cg' }, work());
    expect(indefinite.ok ? undefined : indefinite.error.code).toBe('model-solver-diverged');
    const negativeDiagonal = solveSparse(
      t.toCsr(),
      Float64Array.from([1, 1]),
      { method: 'pcg-jacobi' },
      work(),
    );
    expect(negativeDiagonal.ok ? undefined : negativeDiagonal.error.code).toBe(
      'model-solver-diverged',
    );
    const a = laplacian(200);
    const capped = solveSparse(
      a,
      apply(a, new Float64Array(200).fill(1)),
      { method: 'cg', tolerance: 1e-12, maxIterations: 5 },
      work(),
    );
    expect(capped.ok ? undefined : capped.error.code).toBe('model-solver-diverged');
    expect(capped.ok ? undefined : capped.error.detail).toMatchObject({
      method: 'cg',
      iterations: 5,
    });
    const empty = new TripletList(2, 2);
    empty.add(0, 0, 1);
    const singular = solveSparse(
      empty.toCsr(),
      Float64Array.from([1, 1]),
      { method: 'cgls' },
      work(),
    );
    expect(singular.ok ? undefined : singular.error.code).toBe('model-solver-diverged');
    const wrong = solveSparse(a, new Float64Array(3), { method: 'cg' }, work());
    expect(wrong.ok ? undefined : wrong.error.code).toBe('model-invalid-argument');
    const rectangular = solveSparse(
      new TripletList(3, 2).toCsr(),
      new Float64Array(3),
      { method: 'cg' },
      work(),
    );
    expect(rectangular.ok ? undefined : rectangular.error.code).toBe('model-invalid-argument');
  });

  it('runs as a compute job: report, cache key, budget and native policy', () => {
    const a = laplacian(40);
    const b = apply(a, new Float64Array(40).fill(2));
    const request = {
      kind: 'solve.sparse' as const,
      inputs: [encodeCsr(a), encodeVector(b)],
      params: { method: 'pcg-jacobi' as const, tolerance: 1e-12 },
    };
    const first = runComputeJob(request, tsUvBackend);
    const second = runComputeJob(request, tsUvBackend);
    if (!first.ok || !second.ok) throw new Error('solve');
    expect(first.value.report).toMatchObject({ backend: 'ts', quality: 'baseline' });
    expect(first.value.report.metrics).toMatchObject({ rows: 40, cols: 40, nnz: 118 });
    expect(first.value.report.metrics.residual).toBeLessThanOrEqual(1e-12);
    expect(first.value.outputs[0]).toEqual(second.value.outputs[0]);
    expect(first.value.report.cacheKey).toBe(second.value.report.cacheKey);
    for (const x of decodeVector(first.value.outputs[0] as Uint8Array)) expect(x).toBeCloseTo(2, 9);
    const other = runComputeJob({ ...request, params: { method: 'cg' as const } }, tsUvBackend);
    expect(other.ok && other.value.report.cacheKey).not.toBe(first.value.report.cacheKey);
    const tight = runComputeJob(request, tsUvBackend, { budget: 100 });
    expect(tight.ok ? undefined : tight.error.code).toBe('model-work-budget');
    const native = runComputeJob(request, tsUvBackend, { policy: 'native' });
    expect(native.ok ? undefined : native.error.code).toBe('model-capability-unavailable');
    const aborted = runComputeJob(request, tsUvBackend, { signal: { aborted: true } });
    expect(aborted.ok ? undefined : aborted.error.code).toBe('model-cancelled');
    const missing = runComputeJob({ ...request, inputs: [encodeCsr(a)] }, tsUvBackend);
    expect(missing.ok ? undefined : missing.error.code).toBe('model-invalid-argument');
  });
});
