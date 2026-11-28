export type P3 = readonly [number, number, number];
export type P2 = readonly [number, number];

export const TWO_PI = 2 * Math.PI;
export const HALF_PI = Math.PI / 2;

export function add3(a: P3, b: P3): P3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: P3, b: P3): P3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: P3, s: number): P3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** a + b * s */
export function madd3(a: P3, b: P3, s: number): P3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

export function dot3(a: P3, b: P3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: P3, b: P3): P3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function len3(a: P3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function unit3(a: P3): P3 {
  const l = len3(a);
  return l === 0 ? a : [a[0] / l, a[1] / l, a[2] / l];
}

export function dist3(a: P3, b: P3): number {
  return len3(sub3(a, b));
}

export function neg3(a: P3): P3 {
  return [-a[0], -a[1], -a[2]];
}
