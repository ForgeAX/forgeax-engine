import type { Buffer } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { LightSnapshot } from '../render-system-extract';
import { type RayReferenceError, rayReferenceFailure } from './scene';
export interface RayPathCamera {
  readonly origin: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly verticalFov: number;
}
/** An already located ray, including its carried texture footprint. */
export interface RayPathInitialRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly coneWidth: number;
  readonly coneSpread: number;
  /** Rejected sampling directions remain explicit zero-contribution samples. */
  readonly active: boolean;
}
export type RayPathSettings = {
  readonly width: number;
  readonly height: number;
  readonly maxBounces: number;
  readonly seed: number;
  readonly environment: readonly [number, number, number];
  readonly maxDistance: number;
  /**
   * First-surface response. `'full'` (default) evaluates the complete BSDF;
   * `'diffuse'` evaluates only the raster diffuse-GI receiver term, so indirect
   * estimates compare directly with the diffuse lane.
   */
  readonly receiver?: 'full' | 'diffuse';
} & (
  | { readonly camera: RayPathCamera; readonly rays?: never; readonly rayBuffer?: never }
  | {
      readonly rays: readonly RayPathInitialRay[];
      readonly camera?: never;
      readonly rayBuffer?: never;
    }
  | {
      /** Borrowed 80-byte initial PathState rows; producer work precedes each sample. */
      readonly rayBuffer: Buffer;
      readonly camera?: never;
      readonly rays?: never;
    }
);
export function packSettings(s: RayPathSettings): Result<Uint8Array, RayReferenceError> {
  if (
    !Number.isInteger(s.width) ||
    !Number.isInteger(s.height) ||
    s.width < 1 ||
    s.height < 1 ||
    s.width * s.height > 262144 ||
    !Number.isInteger(s.maxBounces) ||
    s.maxBounces < 1 ||
    s.maxBounces > 8 ||
    !Number.isInteger(s.seed) ||
    s.seed < 0 ||
    s.seed > 0xffffffff
  )
    return rayReferenceFailure('expected 1..262144 pixels, 1..8 bounces, and a u32 seed', true);
  if (
    ![...s.environment, s.maxDistance].every(finite32) ||
    s.environment.some((v) => v < 0) ||
    s.maxDistance <= 0
  )
    return rayReferenceFailure(
      'expected finite nonnegative environment and positive trace distance',
    );
  if (
    Number(s.camera !== undefined) +
      Number(s.rays !== undefined) +
      Number(s.rayBuffer !== undefined) !==
    1
  )
    return rayReferenceFailure(
      'expected one exclusive camera, initial-ray array or GPU ray buffer',
    );
  if (s.receiver !== undefined && s.receiver !== 'full' && s.receiver !== 'diffuse')
    return rayReferenceFailure("expected receiver 'full' or 'diffuse'");
  const receiver = s.receiver === 'diffuse' ? 1 : 0;
  const bytes = new Uint8Array(96);
  new Float32Array(bytes.buffer).set([...s.environment, s.maxDistance], 16);
  new Float32Array(bytes.buffer)[15] = receiver;
  new Uint32Array(bytes.buffer, 80).set([s.width, s.height, s.maxBounces, s.seed]);
  if (s.rayBuffer !== undefined) {
    if (s.rayBuffer === null || typeof s.rayBuffer !== 'object')
      return rayReferenceFailure('expected a live RHI storage buffer containing initial ray rows');
    return ok(bytes);
  }
  if (s.rays !== undefined) {
    if (
      s.rays.length !== s.width * s.height ||
      s.rays.some(
        (r) =>
          r.origin.length !== 3 ||
          r.direction.length !== 3 ||
          ![...r.origin, ...r.direction, r.coneWidth, r.coneSpread].every(finite32) ||
          Math.abs(Math.hypot(...r.direction) - 1) > 1e-5 ||
          r.coneWidth < 0 ||
          r.coneSpread < 0 ||
          typeof r.active !== 'boolean',
      )
    )
      return rayReferenceFailure(
        'expected one exclusive source, one finite unit initial ray per pixel, nonnegative cone footprint and boolean activity',
      );
    return ok(bytes);
  }
  const c = s.camera;
  if (c === undefined) return rayReferenceFailure('expected camera or initial rays');
  if (
    ![...c.origin, ...c.target, ...c.up, c.verticalFov].every(finite32) ||
    c.verticalFov <= 0 ||
    c.verticalFov >= Math.PI
  )
    return rayReferenceFailure(
      'expected finite camera, nonnegative linear environment, and positive trace distance',
    );
  const forward = normalize(c.target.map((v, i) => v - (c.origin[i] ?? 0)));
  const right = normalize(cross(forward, c.up));
  const up = normalize(cross(right, forward));
  if (![...forward, ...right, ...up].every(Number.isFinite))
    return rayReferenceFailure('camera direction and up must span a basis');
  const tan = Math.tan(c.verticalFov / 2),
    aspect = s.width / s.height;
  const floats = [
    ...c.origin,
    (2 * tan) / s.height,
    ...forward,
    0,
    ...right.map((v) => v * tan * aspect),
    0,
    ...up.map((v) => v * tan),
    receiver,
    ...s.environment,
    s.maxDistance,
  ];
  new Float32Array(bytes.buffer).set(floats);
  return ok(bytes);
}
export function packLights(
  lights: readonly LightSnapshot[],
): Result<Uint8Array, RayReferenceError> {
  if (lights.length > 32) return rayReferenceFailure('at most 32 analytic lights', true);
  const bytes = new Uint8Array(Math.max(1, lights.length) * 64);
  const out = new Float32Array(bytes.buffer);
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    if (!l) continue;
    if (l.kind === 'rect-area') return rayReferenceFailure('analytic area lights are not admitted');
    if (l.kind !== 'directional' && l.iesProfileHandle !== undefined)
      return rayReferenceFailure('IES profiles are not admitted');
    if (l.kind === 'spot' && (l.cookieHandle !== undefined || l.projectorSlice !== undefined))
      return rayReferenceFailure('spot modifiers are not admitted');
    const position = l.kind === 'directional' ? [0, 0, 0] : Array.from(l.position);
    const direction = l.kind === 'point' ? [0, 0, -1] : normalize(Array.from(l.direction));
    // LightSnapshot.color is already radiance: extraction pre-multiplies intensity.
    const color = Array.from(l.color);
    const range = l.kind === 'directional' ? 0 : l.invRangeSquared;
    const cone = l.kind === 'spot' ? [l.cosInner, l.cosOuter] : [1, 0];
    const row = [
      ...position,
      l.kind === 'directional' ? 1 : l.kind === 'point' ? 2 : 3,
      ...color,
      l.kind === 'point' ? (l.decay ?? 2) : 0,
      ...direction,
      range,
      ...cone,
      0,
      0,
    ];
    if (
      !row.every(finite32) ||
      color.some((v) => v < 0) ||
      range < 0 ||
      (l.kind === 'point' && (l.decay ?? 2) < 0) ||
      (l.kind === 'spot' && (!(l.cosInner > l.cosOuter) || l.cosInner > 1 || l.cosOuter < -1))
    )
      return rayReferenceFailure('invalid analytic light');
    out.set(row, i * 16);
  }
  return ok(bytes);
}
function finite32(v: number): boolean {
  return Number.isFinite(v) && Number.isFinite(Math.fround(v));
}
function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}
function normalize(a: readonly number[]): number[] {
  const n = Math.hypot(...a);
  return a.map((v) => v / n);
}
