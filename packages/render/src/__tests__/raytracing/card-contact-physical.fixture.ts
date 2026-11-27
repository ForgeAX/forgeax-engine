import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';

export type V3 = readonly [number, number, number];
export interface ShadowRay {
  readonly origin: V3;
  readonly direction: V3;
  readonly tMin: number;
  readonly tMax: number;
}
export interface ShadowCase {
  readonly name: string;
  readonly kind: number;
  readonly light: V3;
  readonly receiver?: V3;
  readonly bias?: number;
  readonly triangle: readonly [V3, V3, V3];
  readonly energy?: V3;
  readonly expectedMask: number;
  readonly expectedComplete: boolean;
}
const xTriangle = (x: number, z: number): readonly [V3, V3, V3] => [
  [x, -0.125, z - 0.03125],
  [x, 0.125, z - 0.03125],
  [x, 0, z + 0.0625],
];
export const CARD_SHADOW_ORIGIN: V3 = [0, 0, 0.25];
export const CARD_SHADOW_CASES: readonly ShadowCase[] = [
  {
    name: 'point-oblique-blocker',
    kind: 2,
    light: [1, 0, 1],
    triangle: xTriangle(0.5, 0.625),
    expectedMask: 0,
    expectedComplete: true,
  },
  {
    name: 'spot-oblique-blocker',
    kind: 3,
    light: [1, 0, 1],
    triangle: xTriangle(0.5, 0.625),
    expectedMask: 0,
    expectedComplete: true,
  },
  {
    name: 'near-light-before-offset',
    kind: 2,
    light: [0.125, 0, 0.125],
    triangle: xTriangle(0.0625, 0.1875),
    expectedMask: 0,
    expectedComplete: true,
  },
  {
    name: 'near-light-end-blocker',
    kind: 2,
    light: [1, 0, 1],
    triangle: xTriangle(63 / 64, 253 / 256),
    expectedMask: 0,
    expectedComplete: true,
  },
  {
    name: 'beyond-light-clear',
    kind: 2,
    light: [1, 0, 1],
    triangle: xTriangle(65 / 64, 259 / 256),
    expectedMask: 1,
    expectedComplete: true,
  },
  {
    name: 'old-direction-false-shadow',
    kind: 2,
    light: [1, 0, 1],
    triangle: xTriangle(0.5, 0.75),
    expectedMask: 1,
    expectedComplete: true,
  },
  {
    name: 'directional-unchanged',
    kind: 1,
    light: [1, 0, 1],
    triangle: [
      [-1, -1, 1],
      [1, -1, 1],
      [0, 1, 1],
    ],
    expectedMask: 0,
    expectedComplete: true,
  },
  {
    name: 'zero-energy-invalid-position',
    kind: 2,
    light: [Number.NaN, 0, 1],
    energy: [0, 0, 0],
    triangle: xTriangle(0.5, 0.625),
    expectedMask: 0,
    expectedComplete: true,
  },
  {
    name: 'coincident-surface-no-contribution',
    kind: 2,
    light: [0, 0, 0],
    triangle: xTriangle(0.5, 0.625),
    expectedMask: 0,
    expectedComplete: true,
  },
  {
    name: 'coincident-offset-empty-segment',
    kind: 2,
    light: CARD_SHADOW_ORIGIN,
    triangle: xTriangle(0.5, 0.625),
    expectedMask: 1,
    expectedComplete: true,
  },
  {
    name: 'nonfinite-light-unknown',
    kind: 2,
    light: [Number.NaN, 0, 1],
    triangle: xTriangle(0.5, 0.625),
    expectedMask: 0,
    expectedComplete: false,
  },
  {
    name: 'tiny-positive-segment',
    kind: 2,
    light: [1e-9, 0, 0.25],
    triangle: xTriangle(5e-10, 0.25),
    expectedMask: 0,
    expectedComplete: true,
  },
  {
    name: 'nonempty-no-length-required',
    kind: 2,
    light: [1e-30, 0, 0.25],
    triangle: xTriangle(0.5, 0.625),
    expectedMask: 1,
    expectedComplete: true,
  },
  {
    name: 'translated-receiver-opposite-sign-blocker',
    kind: 2,
    receiver: [1, 0, 0],
    light: [-1, 0, 0.25],
    triangle: xTriangle(0, 0.25),
    expectedMask: 0,
    expectedComplete: true,
  },
];
export const cardShadowSource = () => irradianceFieldKernelWgsl('global-sdf').cardSurface;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Independent double plane/barycentric oracle, parameterized directly on the closed segment. */
export function triangleOnSegment(
  origin: V3,
  delta: V3,
  last: number,
  triangle: readonly [V3, V3, V3],
): boolean {
  const e1 = sub(triangle[1], triangle[0]),
    e2 = sub(triangle[2], triangle[0]),
    p = cross(delta, e2),
    det = dot(e1, p);
  if (det === 0) return false;
  const t = sub(origin, triangle[0]),
    q = cross(t, e1),
    u = dot(t, p) / det,
    v = dot(delta, q) / det,
    distance = dot(e2, q) / det;
  return u >= 0 && v >= 0 && u + v <= 1 && distance >= 0 && distance <= last;
}
