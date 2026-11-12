import { minOf } from './arrays';

/**
 * Robust orientation predicates (design §5.9). Each returns an approximate value
 * whose sign is exact: a floating-point filter with Shewchuk's error bounds answers
 * almost every call, and the rest are evaluated exactly with BigInt arithmetic.
 * Every finite double is a dyadic rational m * 2^e, so the exact determinant needs
 * no rounding at all.
 */

/** 2^-53, the unit roundoff of f64. */
const EPSILON = 1.1102230246251565e-16;
const CCW_ERR_BOUND = (3 + 16 * EPSILON) * EPSILON;
const O3D_ERR_BOUND = (7 + 56 * EPSILON) * EPSILON;

const view = new DataView(new ArrayBuffer(8));

function dyadic(x: number): { m: bigint; e: number } {
  if (x === 0) return { m: 0n, e: 0 };
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const exponent = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e = -1074;
  if (exponent !== 0) {
    mantissa |= 1n << 52n;
    e = exponent - 1075;
  }
  return { m: hi >>> 31 === 1 ? -mantissa : mantissa, e };
}

/** Scale all values to integers sharing one power of two (sign-preserving for determinants). */
function integers(values: readonly number[]): bigint[] {
  const parts = values.map(dyadic);
  const base = Math.min(minOf(parts.filter((p) => p.m !== 0n).map((p) => p.e)), 0);
  return parts.map((p) => (p.m === 0n ? 0n : p.m << BigInt(p.e - base)));
}

function sign(x: bigint): number {
  return x > 0n ? 1 : x < 0n ? -1 : 0;
}

/** Positive when a, b, c turn counter-clockwise, negative clockwise, zero when collinear. */
export function orient2d(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const left = (ax - cx) * (by - cy);
  const right = (ay - cy) * (bx - cx);
  const det = left - right;
  if (Math.abs(det) > CCW_ERR_BOUND * (Math.abs(left) + Math.abs(right))) return det;
  // A shared coordinate or a repeated point makes the determinant exactly zero.
  if ((ax === cx && bx === cx) || (ay === cy && by === cy)) return 0;
  if ((ax === cx && ay === cy) || (bx === cx && by === cy) || (ax === bx && ay === by)) return 0;
  const [iax, iay, ibx, iby, icx, icy] = integers([ax, ay, bx, by, cx, cy]) as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  const exact = sign((iax - icx) * (iby - icy) - (iay - icy) * (ibx - icx));
  return exact === 0 ? 0 : exact * Math.max(Math.abs(det), Number.MIN_VALUE);
}

type Point = readonly [number, number, number];

function same(p: Point, q: Point): boolean {
  return p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
}

/**
 * Exact zeros the filter cannot certify, answered without BigInt: four points sharing
 * one coordinate (a zero column) or a repeated point (a zero or repeated row). Both are
 * the common cases of axis-aligned faces and triangles of one polygon.
 */
function exactlyCoplanar(a: Point, b: Point, c: Point, d: Point): boolean {
  for (let k = 0; k < 3; k++) {
    const x = d[k];
    if (a[k] === x && b[k] === x && c[k] === x) return true;
  }
  return same(a, d) || same(b, d) || same(c, d) || same(a, b) || same(b, c) || same(a, c);
}

// ---- floating-point expansions (Shewchuk), for determinants of exact differences ----

const SPLITTER = 134217729;
/** 2^-250 and 2^250: triple products and their error terms stay normal and finite. */
const STAGE_MIN = 5.527147875260445e-76;
const STAGE_MAX = 1.8092513943330656e75;

/** Whether `a - b` is exact (its Two-Diff tail is zero) and within the staged range. */
function stagedDifference(a: number, b: number): boolean {
  const x = a - b;
  const bvirt = a - x;
  const tail = a - (x + bvirt) + (bvirt - b);
  if (tail !== 0) return false;
  const m = Math.abs(x);
  return m === 0 || (m >= STAGE_MIN && m <= STAGE_MAX);
}

/** Scratch expansions (Shewchuk): one minor, one scaled minor and the running sum. */
const MINOR = new Float64Array(8);
const SCALED = new Float64Array(16);
const TOTAL = new Float64Array(64);

/** The exact product a * b: its head is `a * b`, the returned value its tail. */
function productTail(a: number, b: number): number {
  const x = a * b;
  let c = SPLITTER * a;
  const ahi = c - (c - a);
  const alo = a - ahi;
  c = SPLITTER * b;
  const bhi = c - (c - b);
  const blo = b - bhi;
  return alo * blo - (x - ahi * bhi - alo * bhi - ahi * blo);
}

/**
 * h = e + b for a nonoverlapping expansion `e` of length n in increasing magnitude,
 * zero-eliminated (Grow-Expansion); `h` may be `e`. Returns the length of h.
 */
function grow(e: Float64Array, n: number, b: number, h: Float64Array): number {
  let q = b;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const enow = e[i] as number;
    const x = q + enow;
    const bvirt = x - q;
    const tail = q - (x - bvirt) + (enow - bvirt);
    if (tail !== 0) h[m++] = tail;
    q = x;
  }
  if (q !== 0 || m === 0) h[m++] = q;
  return m;
}

/** h = e * b (Scale-Expansion, zero-eliminated); `h` is not `e`. Returns the length of h. */
function scale(e: Float64Array, n: number, b: number, h: Float64Array): number {
  let m = 0;
  let tail = productTail(e[0] as number, b);
  if (tail !== 0) h[m++] = tail;
  let q = (e[0] as number) * b;
  for (let i = 1; i < n; i++) {
    const product0 = productTail(e[i] as number, b);
    const product1 = (e[i] as number) * b;
    let x = q + product0;
    let bvirt = x - q;
    tail = q - (x - bvirt) + (product0 - bvirt);
    if (tail !== 0) h[m++] = tail;
    const sum = x;
    x = product1 + sum;
    bvirt = x - product1;
    tail = sum - bvirt;
    if (tail !== 0) h[m++] = tail;
    q = x;
  }
  if (q !== 0 || m === 0) h[m++] = q;
  return m;
}

/** MINOR = p * q - r * s exactly; returns its length. */
function minor(p: number, q: number, r: number, s: number): number {
  MINOR[0] = productTail(p, q);
  MINOR[1] = p * q;
  const n = grow(MINOR, 2, productTail(-r, s), MINOR);
  return grow(MINOR, n, -r * s, MINOR);
}

/** TOTAL += SCALED (the first n components); returns the new length of TOTAL. */
function accumulate(length: number, n: number): number {
  let out = length;
  for (let i = 0; i < n; i++) out = grow(TOTAL, out, SCALED[i] as number, TOTAL);
  return out;
}

/**
 * Exact sign of the orientation determinant when every coordinate difference is exact
 * and in range (Shewchuk's stage B, evaluated to the end in expansions); undefined
 * otherwise, for the BigInt evaluation.
 */
function exactDifferencesSign(
  adx: number,
  ady: number,
  adz: number,
  bdx: number,
  bdy: number,
  bdz: number,
  cdx: number,
  cdy: number,
  cdz: number,
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): number | undefined {
  for (const p of [a, b, c]) {
    for (let k = 0; k < 3; k++)
      if (!stagedDifference(p[k] as number, d[k] as number)) return undefined;
  }
  let length = scale(MINOR, minor(bdx, cdy, cdx, bdy), adz, TOTAL);
  length = accumulate(length, scale(MINOR, minor(cdx, ady, adx, cdy), bdz, SCALED));
  length = accumulate(length, scale(MINOR, minor(adx, bdy, bdx, ady), cdz, SCALED));
  return Math.sign(TOTAL[length - 1] as number);
}

/**
 * Positive when d lies below the plane through a, b, c (a, b, c counter-clockwise
 * seen from above), negative above, zero when the four points are coplanar.
 */
export function orient3d(a: Point, b: Point, c: Point, d: Point): number {
  const adx = a[0] - d[0];
  const ady = a[1] - d[1];
  const adz = a[2] - d[2];
  const bdx = b[0] - d[0];
  const bdy = b[1] - d[1];
  const bdz = b[2] - d[2];
  const cdx = c[0] - d[0];
  const cdy = c[1] - d[1];
  const cdz = c[2] - d[2];
  const bc = bdx * cdy - cdx * bdy;
  const ca = cdx * ady - adx * cdy;
  const ab = adx * bdy - bdx * ady;
  const det = adz * bc + bdz * ca + cdz * ab;
  const permanent =
    (Math.abs(bdx * cdy) + Math.abs(cdx * bdy)) * Math.abs(adz) +
    (Math.abs(cdx * ady) + Math.abs(adx * cdy)) * Math.abs(bdz) +
    (Math.abs(adx * bdy) + Math.abs(bdx * ady)) * Math.abs(cdz);
  if (Math.abs(det) > O3D_ERR_BOUND * permanent) return det;
  if (exactlyCoplanar(a, b, c, d)) return 0;
  const staged = exactDifferencesSign(adx, ady, adz, bdx, bdy, bdz, cdx, cdy, cdz, a, b, c, d);
  if (staged !== undefined) {
    return staged === 0 ? 0 : staged * Math.max(Math.abs(det), Number.MIN_VALUE);
  }
  const v = integers([...a, ...b, ...c, ...d]);
  const at = (i: number) => v[i] as bigint;
  const [ex, ey, ez] = [at(0) - at(9), at(1) - at(10), at(2) - at(11)];
  const [fx, fy, fz] = [at(3) - at(9), at(4) - at(10), at(5) - at(11)];
  const [gx, gy, gz] = [at(6) - at(9), at(7) - at(10), at(8) - at(11)];
  const exact = sign(
    ez * (fx * gy - gx * fy) + fz * (gx * ey - ex * gy) + gz * (ex * fy - fx * ey),
  );
  return exact === 0 ? 0 : exact * Math.max(Math.abs(det), Number.MIN_VALUE);
}

/**
 * Whether two counter-clockwise 2D triangles overlap with positive area: a vertex or
 * centroid strictly inside the other, or two edges crossing properly. Shared vertices
 * and shared edges alone do not count, so neighbors in one UV island never do.
 */
export function trianglesOverlap2d(
  a: readonly (readonly number[])[],
  b: readonly (readonly number[])[],
): boolean {
  const o = (p: readonly number[], q: readonly number[], r: readonly number[]) =>
    Math.sign(
      orient2d(
        p[0] as number,
        p[1] as number,
        q[0] as number,
        q[1] as number,
        r[0] as number,
        r[1] as number,
      ),
    );
  const strictlyInside = (p: readonly number[], t: readonly (readonly number[])[]) =>
    [0, 1, 2].every(
      (k) => o(t[k] as readonly number[], t[(k + 1) % 3] as readonly number[], p) > 0,
    );
  const centroid = (t: readonly (readonly number[])[]) =>
    [0, 1].map((k) => t.reduce((sum, p) => sum + (p[k] as number), 0) / 3);
  if (strictlyInside(centroid(a), b) || strictlyInside(centroid(b), a)) return true;
  for (let k = 0; k < 3; k++) {
    if (
      strictlyInside(a[k] as readonly number[], b) ||
      strictlyInside(b[k] as readonly number[], a)
    )
      return true;
    for (let l = 0; l < 3; l++) {
      const [p, q] = [a[k] as readonly number[], a[(k + 1) % 3] as readonly number[]];
      const [r, t] = [b[l] as readonly number[], b[(l + 1) % 3] as readonly number[]];
      if (o(p, q, r) * o(p, q, t) < 0 && o(r, t, p) * o(r, t, q) < 0) return true;
    }
  }
  return false;
}
