import { err, ok, type Result } from '@forgeax/engine-types';
import { type RayReferenceError, rayReferenceFailure } from './scene';

const UNIT = 1n << 298n;
const F32_UNIT = 1n << 149n;
const scratch = new DataView(new ArrayBuffer(4));
const sourceBits = new DataView(new ArrayBuffer(8));
const F64_UNIT = 1n << 1074n;
const WORLD_UNIT = F32_UNIT * F64_UNIT;

/** Bounds of canonical forward * authored local box, not a geometry certificate. */
export interface SdfPlacementBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

function matrixWords(matrix: ArrayLike<number>): Result<readonly number[], RayReferenceError> {
  if (matrix.length !== 16)
    return rayReferenceFailure('transform certificate requires two canonical affine f32 matrices');
  const words: number[] = [];
  for (let i = 0; i < 16; i++) {
    const value = matrix[i];
    if (value === undefined || !Number.isFinite(value) || Math.fround(value) !== value)
      return rayReferenceFailure(
        'transform certificate requires finite canonical f32 source values',
      );
    if ((i === 3 || i === 7 || i === 11) && value !== 0)
      return rayReferenceFailure('transform certificate requires affine matrices');
    if (i === 15 && value !== 1)
      return rayReferenceFailure('transform certificate requires affine homogeneous one');
    scratch.setFloat32(0, value, true);
    words.push(scratch.getUint32(0, true));
  }
  return ok(Object.freeze(words));
}

/** Exact integer representation x * 2^149 of a finite binary32 input. */
function integer(word: number): bigint {
  const exponent = (word >>> 23) & 255;
  const significand = BigInt((word & 0x007fffff) | (exponent ? 0x00800000 : 0));
  const value = exponent ? significand << BigInt(exponent - 1) : significand;
  return word >>> 31 ? -value : value;
}
const absolute = (x: bigint) => (x < 0n ? -x : x);
const at = (a: readonly bigint[], i: number) => a[i] ?? 0n;

/** Exact x * 2^1074; the source bounds need not be representable as binary32. */
function sourceInteger(value: number): bigint {
  sourceBits.setFloat64(0, value, true);
  const bits = sourceBits.getBigUint64(0, true),
    exponent = Number((bits >> 52n) & 2047n),
    fraction = bits & ((1n << 52n) - 1n),
    significand = exponent ? fraction | (1n << 52n) : fraction,
    magnitude = exponent ? significand << BigInt(exponent - 1) : significand;
  return bits >> 63n ? -magnitude : magnitude;
}

function worldRange(forward: readonly bigint[], bounds: SdfPlacementBounds, axis: number) {
  let lower = at(forward, 12 + axis) * F64_UNIT,
    upper = lower;
  for (let column = 0; column < 3; column++) {
    const coefficient = at(forward, column * 4 + axis),
      a = coefficient * sourceInteger(bounds.min[column] ?? NaN),
      b = coefficient * sourceInteger(bounds.max[column] ?? NaN);
    lower += a < b ? a : b;
    upper += a < b ? b : a;
  }
  return { lower, upper };
}

/** Signed directed rounding over {zero, normal finite binary32}. */
function worldEndpoint(value: bigint, up: boolean): Result<number, RayReferenceError> {
  const magnitude = absolute(value),
    ceiling = upperCoefficient(magnitude, WORLD_UNIT);
  if (!ceiling.ok) return rayReferenceFailure('canonical placement envelope exceeds finite f32');
  scratch.setFloat32(0, ceiling.value, true);
  const word = scratch.getUint32(0, true),
    exact = integer(word) * WORLD_UNIT === magnitude * F32_UNIT;
  const towardMagnitude = value < 0n ? !up : up;
  if (!towardMagnitude && !exact) scratch.setUint32(0, word === 0x00800000 ? 0 : word - 1, true);
  const rounded = scratch.getFloat32(0, true);
  return ok(value < 0n ? -rounded : rounded);
}

function placementBounds(forward: readonly number[], bounds: SdfPlacementBounds) {
  if (
    bounds.min.length !== 3 ||
    bounds.max.length !== 3 ||
    ![...bounds.min, ...bounds.max].every(Number.isFinite) ||
    bounds.min.some((value, axis) => value > (bounds.max[axis] ?? -Infinity))
  )
    return rayReferenceFailure('placement bounds require a finite ordered authored box');
  const min: [number, number, number] = [0, 0, 0],
    max: [number, number, number] = [0, 0, 0],
    matrix = forward.map(integer);
  for (let axis = 0; axis < 3; axis++) {
    const range = worldRange(matrix, bounds, axis),
      lower = worldEndpoint(range.lower, false),
      upper = worldEndpoint(range.upper, true);
    if (!lower.ok) return lower;
    if (!upper.ok) return upper;
    min[axis] = lower.value;
    max[axis] = upper.value;
  }
  return ok(Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) }));
}

/** R=I-A*M and r=A*t+ti, exactly on the common 2^-298 product grid. */
function residual(forward: readonly number[], inverse: readonly number[]) {
  const m = forward.map(integer),
    a = inverse.map(integer);
  let rho = 0n,
    translation = 0n;
  for (let row = 0; row < 3; row++) {
    let sum = 0n;
    for (let column = 0; column < 3; column++) {
      let product = 0n;
      for (let k = 0; k < 3; k++) product += at(a, k * 4 + row) * at(m, column * 4 + k);
      sum += absolute((row === column ? UNIT : 0n) - product);
    }
    if (sum > rho) rho = sum;
    let r = at(a, 12 + row) * F32_UNIT;
    for (let k = 0; k < 3; k++) r += at(a, k * 4 + row) * at(m, 12 + k);
    if (absolute(r) > translation) translation = absolute(r);
  }
  return { rho, translation };
}

/** Least normal f32 >= numerator/denominator, or exact zero. No approximate
 * division is trusted: monotone encoding search uses only integer comparisons.
 * Positive subnormal coefficients round outward to min-normal for GPU FTZ. */
function upperCoefficient(
  numerator: bigint,
  denominator: bigint,
): Result<number, RayReferenceError> {
  if (numerator === 0n) return ok(0);
  const target = numerator * F32_UNIT;
  const covers = (word: number) => integer(word) * denominator >= target;
  if (!covers(0x7f7fffff))
    return rayReferenceFailure('transform residual coefficient exceeds finite f32 range');
  let low = 0x00800000,
    high = 0x7f7fffff;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (covers(mid)) high = mid;
    else low = mid + 1;
  }
  scratch.setUint32(0, low, true);
  return ok(scratch.getFloat32(0, true));
}

/** CPU proof relative to the actual canonical forward and stored inverse.
 * It does not certify GPU arithmetic. For v=A*p+ti and true local q:
 * ||q-v||_inf <= localRelative * ||v||_inf + localAbsolute.
 * Source words stay private so an edited matrix cannot inherit the certificate. */
export class SdfTransformCertificate {
  readonly #forward: readonly number[];
  readonly #inverse: readonly number[];
  private constructor(
    forward: readonly number[],
    inverse: readonly number[],
    readonly localRelative: number,
    readonly localAbsolute: number,
  ) {
    this.#forward = forward;
    this.#inverse = inverse;
    Object.freeze(this);
  }

  static create(
    forward: ArrayLike<number>,
    inverse: ArrayLike<number>,
  ): Result<SdfTransformCertificate, RayReferenceError> {
    const m = matrixWords(forward);
    if (!m.ok) return m;
    const a = matrixWords(inverse);
    if (!a.ok) return a;
    const exact = residual(m.value, a.value);
    if (exact.rho >= UNIT)
      return rayReferenceFailure('forward/inverse residual does not prove invertibility');
    const denominator = UNIT - exact.rho;
    const relative = upperCoefficient(exact.rho, denominator);
    if (!relative.ok) return relative;
    const absolute = upperCoefficient(exact.translation, denominator);
    if (!absolute.ok) return absolute;
    return ok(new SdfTransformCertificate(m.value, a.value, relative.value, absolute.value));
  }

  /** Derive from the admitted forward, never by inverting the stored inverse.
   * Failure disables only this candidate proof; it does not invalidate geometry.
   * The caller still owns the authored-box/source and scene-generation closure. */
  encloseBounds(
    forward: ArrayLike<number>,
    inverse: ArrayLike<number>,
    bounds: SdfPlacementBounds,
  ): Result<SdfPlacementBounds, RayReferenceError> {
    const current = this.validate(forward, inverse);
    if (!current.ok) return current;
    return placementBounds(this.#forward, bounds);
  }

  validate(
    forward: ArrayLike<number>,
    inverse: ArrayLike<number>,
  ): Result<void, RayReferenceError> {
    const m = matrixWords(forward);
    if (!m.ok) return m;
    const a = matrixWords(inverse);
    if (!a.ok) return a;
    if (
      m.value.some((word, i) => word !== this.#forward[i]) ||
      a.value.some((word, i) => word !== this.#inverse[i])
    )
      return err({
        code: 'ray-reference-stale',
        expected: 'the exact canonical matrix pair used by this transform certificate',
        hint: 'Recertify the edited forward and inverse before publishing query data.',
        detail: { cause: 'transform certificate source changed' },
      });
    return ok(undefined);
  }
}
