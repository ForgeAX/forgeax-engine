/**
 * Solve the dense `n x n` system `a x = b` (row-major rows, copied) by Gaussian elimination with
 * partial pivoting; `undefined` when a pivot is below `1e-300` relative to the largest row entry.
 */
export function solveSmall(
  a: readonly (readonly number[])[],
  b: readonly number[],
): number[] | undefined {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs((m[col] as number[])[col] as number);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs((m[r] as number[])[col] as number);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    let scale = 0;
    for (let c = 0; c < n; c++)
      scale = Math.max(scale, Math.abs((m[pivot] as number[])[c] as number));
    if (!(best > 1e-14 * scale) || !Number.isFinite(best)) return undefined;
    if (pivot !== col) {
      const t = m[col] as number[];
      m[col] = m[pivot] as number[];
      m[pivot] = t;
    }
    const rowC = m[col] as number[];
    for (let r = col + 1; r < n; r++) {
      const row = m[r] as number[];
      const f = (row[col] as number) / (rowC[col] as number);
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c] = (row[c] as number) - f * (rowC[c] as number);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = m[r] as number[];
    let s = row[n] as number;
    for (let k = r + 1; k < n; k++) s -= (row[k] as number) * (x[k] as number);
    x[r] = s / (row[r] as number);
  }
  return x;
}

/**
 * Solve the symmetric positive definite banded system `A x = B` for `d` right-hand sides by
 * Cholesky: `band[i][k]` holds `A[i][i - k]` for `k = 0..w` (lower half-bandwidth `w`), `rhs[i]` a
 * row of `d` values. `undefined` when the matrix is not positive definite.
 */
export function solveBand(
  band: readonly (readonly number[])[],
  rhs: readonly (readonly number[])[],
  w: number,
): number[][] | undefined {
  const n = band.length;
  const L = band.map((row) => [...row]);
  for (let i = 0; i < n; i++) {
    const Li = L[i] as number[];
    for (let k = Math.min(w, i); k >= 0; k--) {
      const j = i - k;
      const Lj = L[j] as number[];
      let s = Li[k] as number;
      for (let t = 1; t <= w; t++) {
        const c = j - t;
        if (c < 0 || i - c > w) continue;
        s -= (Li[i - c] as number) * (Lj[t] as number);
      }
      if (k === 0) {
        if (!(s > 0) || !Number.isFinite(s)) return undefined;
        Li[0] = Math.sqrt(s);
      } else {
        Li[k] = s / (Lj[0] as number);
      }
    }
  }
  const d = (rhs[0] as readonly number[]).length;
  const y = rhs.map((row) => [...row]);
  for (let i = 0; i < n; i++) {
    const Li = L[i] as number[];
    const yi = y[i] as number[];
    for (let k = 1; k <= Math.min(w, i); k++) {
      const yj = y[i - k] as number[];
      for (let c = 0; c < d; c++) yi[c] = (yi[c] as number) - (Li[k] as number) * (yj[c] as number);
    }
    for (let c = 0; c < d; c++) yi[c] = (yi[c] as number) / (Li[0] as number);
  }
  for (let i = n - 1; i >= 0; i--) {
    const yi = y[i] as number[];
    for (let k = 1; k <= Math.min(w, n - 1 - i); k++) {
      const yj = y[i + k] as number[];
      const l = (L[i + k] as number[])[k] as number;
      for (let c = 0; c < d; c++) yi[c] = (yi[c] as number) - l * (yj[c] as number);
    }
    const l0 = (L[i] as number[])[0] as number;
    for (let c = 0; c < d; c++) yi[c] = (yi[c] as number) / l0;
  }
  return y;
}
