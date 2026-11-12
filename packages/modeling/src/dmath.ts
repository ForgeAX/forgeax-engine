/**
 * Realm-independent transcendental functions. ECMAScript leaves Math.sin, cos,
 * atan2, hypot and friends implementation-approximated, and Chromium and Node
 * already disagree on them in the last bit, which changes exported normals and
 * positions. These ports of FreeBSD msun (fdlibm) use only IEEE-exact operations
 * (+ - * /, sqrt, round), so every realm computes the same bits. Accuracy is about
 * one ulp (up to 1.06 ulp near multiples of pi/2, since only two Cody-Waite rounds
 * run) for |x| <= 1e6; larger arguments are first reduced by an inexact 2 pi
 * remainder and lose accuracy, and atan2 omits fdlibm's huge-ratio branch. The
 * kernel reduces degrees modulo 360 before converting, so its arguments stay small.
 */

const S1 = -0.16666666666666632;
const S2 = 0.00833333333332249;
const S3 = -0.0001984126982985795;
const S4 = 2.7557313707070068e-6;
const S5 = -2.5050760253406863e-8;
const S6 = 1.58969099521155e-10;

const C1 = 0.0416666666666666;
const C2 = -0.001388888888887411;
const C3 = 2.480158728947673e-5;
const C4 = -2.7557314351390663e-7;
const C5 = 2.087572321298175e-9;
const C6 = -1.1359647557788195e-11;

const INV_PIO2 = 0.6366197723675814;
const PIO2_1 = 1.5707963267341256;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_2T = 2.0222662487959506e-21;
const PIO4 = 0.7853981633974483;
/** Beyond this the Cody-Waite reduction loses bits; reduce by an exact remainder first. */
const MEDIUM = 1.0e6;
const TWO_PI = 6.283185307179586;

function kernelSin(x: number, y: number): number {
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

function kernelCos(x: number, y: number): number {
  const z = x * x;
  const w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const one = 1 - hz;
  return one + (1 - one - hz + (z * r - x * y));
}

/** x = n * pi/2 + (y0 + y1) with |y0 + y1| <= pi/4. */
function reduce(input: number): [number, number, number] {
  const x = Math.abs(input) > MEDIUM ? input % TWO_PI : input;
  if (Math.abs(x) <= PIO4) return [0, x, 0];
  const fn = Math.round(x * INV_PIO2);
  // fdlibm's second Cody-Waite round: pi/2 = PIO2_1 + PIO2_2 + PIO2_2T.
  const t = x - fn * PIO2_1;
  let w = fn * PIO2_2;
  const r = t - w;
  w = fn * PIO2_2T - (t - r - w);
  const y0 = r - w;
  const y1 = r - y0 - w;
  return [((fn % 4) + 4) % 4, y0, y1];
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const [n, y0, y1] = reduce(x);
  switch (n) {
    case 0:
      return kernelSin(y0, y1);
    case 1:
      return kernelCos(y0, y1);
    case 2:
      return -kernelSin(y0, y1);
    default:
      return -kernelCos(y0, y1);
  }
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const [n, y0, y1] = reduce(x);
  switch (n) {
    case 0:
      return kernelCos(y0, y1);
    case 1:
      return -kernelSin(y0, y1);
    case 2:
      return -kernelCos(y0, y1);
    default:
      return kernelSin(y0, y1);
  }
}

const ATAN_HI = [
  0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966,
] as const;
const ATAN_LO = [
  2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17,
] as const;
const AT = [
  0.3333333333333293, -0.19999999999876483, 0.14285714272503466, -0.11111110405462356,
  0.09090887133436507, -0.0769187620504483, 0.06661073137387531, -0.058335701337905735,
  0.049768779946159324, -0.036531572744216916, 0.016285820115365782,
] as const;

export function atan(input: number): number {
  if (Number.isNaN(input)) return input;
  const ax = Math.abs(input);
  if (ax >= 7.378697629483821e19)
    return input > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3];
  let id: number;
  let x: number;
  if (ax < 0.4375) {
    if (ax < 7.450580596923828e-9) return input;
    id = -1;
    x = ax;
  } else if (ax < 1.1875) {
    if (ax < 0.6875) {
      id = 0;
      x = (2 * ax - 1) / (2 + ax);
    } else {
      id = 1;
      x = (ax - 1) / (ax + 1);
    }
  } else if (ax < 2.4375) {
    id = 2;
    x = (ax - 1.5) / (1 + 1.5 * ax);
  } else {
    id = 3;
    x = -1 / ax;
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return input < 0 ? -(x - x * (s1 + s2)) : x - x * (s1 + s2);
  const r = (ATAN_HI[id] as number) - (x * (s1 + s2) - (ATAN_LO[id] as number) - x);
  return input < 0 ? -r : r;
}

const PI = Math.PI;
const PI_LO = 1.2246467991473532e-16;

export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  const negativeX = x < 0 || Object.is(x, -0);
  if (y === 0) return negativeX ? (Object.is(y, -0) ? -PI : PI) : y;
  if (x === 0) return y > 0 ? PI / 2 : -PI / 2;
  if (!Number.isFinite(x)) {
    if (!Number.isFinite(y)) {
      const a = negativeX ? (3 * PI) / 4 : PI / 4;
      return y > 0 ? a : -a;
    }
    return negativeX ? (y > 0 ? PI : -PI) : y > 0 ? 0 : -0;
  }
  if (!Number.isFinite(y)) return y > 0 ? PI / 2 : -PI / 2;
  const z = atan(Math.abs(y / x));
  if (!negativeX) return y > 0 ? z : -z;
  return y > 0 ? PI - (z - PI_LO) : z - PI_LO - PI;
}

/** sqrt(x^2 + y^2 + z^2); IEEE sqrt is exact, unlike the approximated Math.hypot. */
export function hypot3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function hypot2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
