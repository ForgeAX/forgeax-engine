// Test-only exact rational oracle. Binary64 input decoding and Gauss-Jordan
// inversion are independent of the production f32 fixed-grid residual proof.
type R = readonly [bigint, bigint];
export type ExactVector = readonly [R, R, R];
const ZERO: R = [0n, 1n],
  ONE: R = [1n, 1n];
function fraction(n: bigint, d: bigint): R {
  if (!d) throw Error('Singular exact affine oracle');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b) {
    const r = a % b;
    a = b;
    b = r;
  }
  return [n / a, d / a];
}
export const sum = (a: R, b: R) => fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
export const difference = (a: R, b: R) => sum(a, [-b[0], b[1]]);
export const product = (a: R, b: R) => fraction(a[0] * b[0], a[1] * b[1]);
const quotient = (a: R, b: R) => fraction(a[0] * b[1], a[1] * b[0]);
export const compare = (a: R, b: R) => a[0] * b[1] - b[0] * a[1];
export const absolute = (a: R): R => [a[0] < 0n ? -a[0] : a[0], a[1]];
export function rational(value: number): R {
  if (!Number.isFinite(value)) throw Error('Finite exact oracle input required');
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, value, true);
  const bits = v.getBigUint64(0, true),
    e = Number((bits >> 52n) & 2047n),
    m = (bits & ((1n << 52n) - 1n)) | (e ? 1n << 52n : 0n),
    p = e ? e - 1075 : -1074,
    n = bits >> 63n ? -m : m;
  return p >= 0 ? fraction(n << BigInt(p), 1n) : fraction(n, 1n << BigInt(-p));
}
function entry(rows: readonly R[][], r: number, c: number): R {
  const x = rows[r]?.[c];
  if (!x) throw Error('Missing exact matrix entry');
  return x;
}
function matrixRow(rows: readonly R[][], i: number): R[] {
  const row = rows[i];
  if (!row) throw Error('Missing exact matrix row');
  return row;
}
export function coordinate(values: readonly R[], i: number): R {
  const value = values[i];
  if (!value) throw Error('Missing exact vector coordinate');
  return value;
}
/** Independent rational infinity norm of I-A*M, using the actual two inputs. */
export function residualNorm(forward: ArrayLike<number>, inverse: ArrayLike<number>): R {
  let largest = ZERO;
  for (let row = 0; row < 3; row++) {
    let total = ZERO;
    for (let column = 0; column < 3; column++) {
      let value = ZERO;
      for (let k = 0; k < 3; k++)
        value = sum(
          value,
          product(rational(inverse[k * 4 + row] ?? NaN), rational(forward[column * 4 + k] ?? NaN)),
        );
      total = sum(total, absolute(difference(row === column ? ONE : ZERO, value)));
    }
    if (compare(total, largest) > 0n) largest = total;
  }
  return largest;
}
/** Exact inverse of the actual canonical forward, not of the supplied A. */
export function inverseForward(matrix: ArrayLike<number>) {
  const rows = Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: 6 }, (_, c) =>
      c < 3 ? rational(matrix[c * 4 + r] ?? NaN) : c - 3 === r ? ONE : ZERO,
    ),
  );
  for (let column = 0; column < 3; column++) {
    const pivot = rows.findIndex((row, i) => i >= column && (row[column]?.[0] ?? 0n) !== 0n);
    if (pivot < 0) throw Error('Singular exact forward');
    [rows[column], rows[pivot]] = [matrixRow(rows, pivot), matrixRow(rows, column)];
    const divisor = entry(rows, column, column);
    rows[column] = matrixRow(rows, column).map((x) => quotient(x, divisor));
    for (let row = 0; row < 3; row++)
      if (row !== column) {
        const factor = entry(rows, row, column);
        rows[row] = matrixRow(rows, row).map((x, c) =>
          difference(x, product(factor, entry(rows, column, c))),
        );
      }
  }
  return rows.map((row) => row.slice(3));
}
export function transformed(matrix: ArrayLike<number>, point: ExactVector): ExactVector {
  return [0, 1, 2].map((row) =>
    point.reduce(
      (v, p, column) => sum(v, product(rational(matrix[column * 4 + row] ?? NaN), p)),
      rational(matrix[12 + row] ?? NaN),
    ),
  ) as unknown as ExactVector;
}
export function trueLocal(forward: ArrayLike<number>, point: ExactVector): ExactVector {
  const inv = inverseForward(forward),
    p = point.map((v, i) => difference(v, rational(forward[12 + i] ?? NaN)));
  return inv.map((row) =>
    row.reduce((v, a, i) => sum(v, product(a, coordinate(p, i))), ZERO),
  ) as unknown as ExactVector;
}
export function transformedDirection(
  matrix: ArrayLike<number>,
  direction: ExactVector,
): ExactVector {
  return [0, 1, 2].map((row) =>
    direction.reduce(
      (v, p, column) => sum(v, product(rational(matrix[column * 4 + row] ?? NaN), p)),
      ZERO,
    ),
  ) as unknown as ExactVector;
}
export function trueLocalDirection(
  forward: ArrayLike<number>,
  direction: ExactVector,
): ExactVector {
  return inverseForward(forward).map((row) =>
    row.reduce((v, a, i) => sum(v, product(a, coordinate(direction, i))), ZERO),
  ) as unknown as ExactVector;
}
export const normInf = (point: ExactVector) =>
  point.map(absolute).reduce((a, b) => (compare(a, b) >= 0n ? a : b));
