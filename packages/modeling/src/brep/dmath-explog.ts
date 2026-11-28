/**
 * Realm-independent log, exp and tan for the kernel, next to the dmath.ts sin/cos/atan ports. log and exp are
 * FreeBSD msun (fdlibm) ports built only from IEEE-exact operations (+ - * /, comparisons, exact bit access), so
 * every realm computes the same bits; accuracy is within two ulps of the host on the swept range (measured). tan is sin / cos of the dmath
 * ports (about two ulp): it is deterministic, not correctly rounded, and has no pole handling beyond the quotient.
 */
import { cos, sin } from '../dmath';

const LN2_HI = 6.9314718036912382e-1;
const LN2_LO = 1.9082149292705877e-10;
const LG1 = 6.666666666666735e-1;
const LG2 = 3.999999999940942e-1;
const LG3 = 2.857142874366239e-1;
const LG4 = 2.222219843214978e-1;
const LG5 = 1.818357216161805e-1;
const LG6 = 1.5313837699209373e-1;
const LG7 = 1.4798198605116586e-1;

const INV_LN2 = Math.LOG2E;
const O_THRESHOLD = 7.09782712893384e2;
const U_THRESHOLD = -7.451332191019411e2;
const P1 = 1.6666666666666019e-1;
const P2 = -2.7777777777015593e-3;
const P3 = 6.613756321437934e-5;
const P4 = -1.6533902205465252e-6;
const P5 = 4.1381367970572385e-8;

const word = new DataView(new ArrayBuffer(8));
const TWO_54 = 18014398509481984;

/** 2^k for an integer k in [-1022, 1023], built from its exponent field. */
function pow2(k: number): number {
  word.setUint32(0, (k + 1023) * 0x100000);
  word.setUint32(4, 0);
  return word.getFloat64(0);
}

/** Natural logarithm: -Infinity at 0, NaN below 0, NaN and +Infinity pass through. */
export function log(input: number): number {
  let x = input;
  if (Number.isNaN(x) || x < 0) return Number.NaN;
  if (x === 0) return Number.NEGATIVE_INFINITY;
  if (x === Number.POSITIVE_INFINITY) return x;
  let k = 0;
  if (x < 2.2250738585072014e-308) {
    k -= 54;
    x *= TWO_54;
  }
  word.setFloat64(0, x);
  const hi = word.getUint32(0);
  k += (hi >>> 20) - 1023;
  // Mantissa f in [1, 2); fold it into [sqrt(2)/2, sqrt(2)) by one exponent step.
  word.setUint32(0, (hi & 0x000fffff) | 0x3ff00000);
  let f = word.getFloat64(0);
  if (f > Math.SQRT2) {
    f *= 0.5;
    k += 1;
  }
  f -= 1;
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1;
  const hfsq = 0.5 * f * f;
  if (k === 0) return f - (hfsq - s * (hfsq + r));
  return k * LN2_HI - (hfsq - (s * (hfsq + r) + k * LN2_LO) - f);
}

/** e^x: Infinity above ln(DBL_MAX), 0 below the subnormal range, NaN passes through. */
export function exp(x: number): number {
  if (Number.isNaN(x)) return x;
  if (x > O_THRESHOLD) return Number.POSITIVE_INFINITY;
  if (x < U_THRESHOLD) return 0;
  let hi = x;
  let lo = 0;
  let k = 0;
  if (Math.abs(x) > 0.5 * Math.LN2) {
    if (Math.abs(x) < 1.5 * Math.LN2) {
      k = x > 0 ? 1 : -1;
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    } else {
      k = Math.trunc(INV_LN2 * x + (x < 0 ? -0.5 : 0.5));
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    }
  } else if (Math.abs(x) < 3.725290298461914e-9) {
    return 1 + x;
  }
  const r = hi - lo;
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((r * c) / (c - 2) - r);
  const y = 1 - (lo - (r * c) / (2 - c) - hi);
  // Two exact power-of-two factors keep each inside the normal exponent range for every k in [-1075, 1024].
  const half = Math.trunc(k / 2);
  return y * pow2(half) * pow2(k - half);
}

/** tan x as sin x / cos x of the dmath ports. */
export function tan(x: number): number {
  return sin(x) / cos(x);
}
