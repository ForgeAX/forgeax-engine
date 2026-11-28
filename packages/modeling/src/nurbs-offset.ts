import { err, ok, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  checkSurface,
  type NurbsSurface,
  surfaceClosest,
  surfaceCurvature,
  surfaceDomain,
  surfacePoint,
} from './nurbs';
import { fitSurface } from './nurbs-fit';

/** Approximation controls for a free-form surface offset. */
export interface OffsetSurfaceOptions {
  /** Largest independently measured offset error in meters (default 1e-5). */
  readonly tolerance?: number;
  /** Maximum fitted control points in u and v (default [32, 32]). */
  readonly maxNet?: readonly [number, number];
}

/** Fitted offset and independently measured geometric error. */
export interface OffsetSurfaceResult {
  /** The output knot domains map affinely to the input domains, preserving parameter correspondence. */
  readonly surface: NurbsSurface;
  /** Largest of the off-grid pointwise and true-distance errors, in meters. */
  readonly max: number;
  /** RMS of off-grid pointwise errors, including true-distance checks at the independent subset. */
  readonly rms: number;
  readonly net: readonly [number, number];
  /** True when the independent off-grid maximum is no greater than the requested tolerance. */
  readonly converged: boolean;
  /** Smallest sampled radius on the side toward which the offset moves; Infinity when none exists. */
  readonly minRadius: number;
}

const invalid = (expected: string, detail: Record<string, unknown> = {}) =>
  modelingError('model-invalid-argument', expected, detail);

const distance3 = (a: Tuple3, b: Tuple3): number => {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return Math.sqrt(x * x + y * y + z * z);
};

function sampleParameters(
  knots: readonly number[],
  degree: number,
  count: number,
  maxNet: number,
): number[] {
  const values = new Set<number>([0, 1]);
  for (let span = degree; span < count; span++) {
    const lo = knots[span] as number;
    const hi = knots[span + 1] as number;
    if (!(hi > lo)) continue;
    const a =
      (lo - (knots[degree] as number)) / ((knots[count] as number) - (knots[degree] as number));
    const b =
      (hi - (knots[degree] as number)) / ((knots[count] as number) - (knots[degree] as number));
    for (let step = 0; step <= 4; step++) values.add(a + ((b - a) * step) / 4);
  }
  const fitSpans = Math.max(1, maxNet - degree);
  const intervals = 4 * fitSpans;
  for (let i = 0; i <= intervals; i++) values.add(i / intervals);
  for (let i = 0; i <= 32; i++) values.add(i / 32);
  return [...values].sort((a, b) => a - b);
}

function mapKnotDomain(knots: readonly number[], start: number, end: number): number[] {
  return knots.map((t) => start + (end - start) * t);
}

function parameterError(
  source: NurbsSurface,
  fitted: NurbsSurface,
  distance: number,
  us: readonly number[],
  vs: readonly number[],
): Result<{ max: number; rms: number }, ModelingError> {
  const [[u0, u1], [v0, v1]] = surfaceDomain(source);
  const uMid = us.slice(0, -1).map((t, i) => (t + (us[i + 1] as number)) / 2);
  const vMid = vs.slice(0, -1).map((t, i) => (t + (vs[i + 1] as number)) / 2);
  const errors: number[][] = Array.from(
    { length: uMid.length },
    () => new Array<number>(vMid.length),
  );
  let max = 0;
  let sum = 0;
  for (let i = 0; i < uMid.length; i++) {
    const row = errors[i] as number[];
    const tu = uMid[i] as number;
    const u = u0 + (u1 - u0) * tu;
    for (let j = 0; j < vMid.length; j++) {
      const tv = vMid[j] as number;
      const v = v0 + (v1 - v0) * tv;
      const curvature = surfaceCurvature(source, u, v);
      if (curvature === undefined)
        return err(
          modelingError(
            'model-degenerate',
            'the surface normal is defined at every offset sample',
            { u, v },
          ),
        );
      const exact: Tuple3 = [
        curvature.point[0] + distance * curvature.normal[0],
        curvature.point[1] + distance * curvature.normal[1],
        curvature.point[2] + distance * curvature.normal[2],
      ];
      const fittedPoint = surfacePoint(fitted, tu, tv);
      const pointError = distance3(fittedPoint, exact);
      row[j] = pointError;
      max = Math.max(max, pointError);
      sum += pointError * pointError;
    }
  }

  // A small interior subset also checks distance to the source carrier, not just parameter-wise fit.
  const pick = (count: number) => [
    ...new Set([
      Math.floor((count - 1) / 4),
      Math.floor((count - 1) / 2),
      Math.floor((3 * (count - 1)) / 4),
    ]),
  ];
  const picksU = pick(uMid.length);
  const picksV = pick(vMid.length);
  for (const i of picksU) {
    const tu = uMid[i] as number;
    const row = errors[i] as number[];
    for (const j of picksV) {
      const tv = vMid[j] as number;
      const fittedPoint = surfacePoint(fitted, tu, tv);
      const closest = surfaceClosest(source, fittedPoint);
      const distanceError = Math.abs(closest.distance - Math.abs(distance));
      const previous = row[j] as number;
      if (distanceError > previous) {
        sum += distanceError * distanceError - previous * previous;
        row[j] = distanceError;
      }
      max = Math.max(max, distanceError);
    }
  }
  return ok({ max, rms: Math.sqrt(sum / (uMid.length * vMid.length)) });
}

/** Fit the exact normal offset of a NURBS patch, rejecting sampled focal-distance folds. */
export function offsetSurface(
  s: NurbsSurface,
  distance: number,
  options: OffsetSurfaceOptions = {},
): Result<OffsetSurfaceResult, ModelingError> {
  const checked = checkSurface(s);
  if (!checked.ok) return checked;
  if (!Number.isFinite(distance)) return err(invalid('offset distance is finite', { distance }));
  const tolerance = options.tolerance ?? 1e-5;
  if (!(Number.isFinite(tolerance) && tolerance > 0))
    return err(invalid('tolerance is finite and > 0', { tolerance }));

  const maxNet = options.maxNet ?? [32, 32];
  const degrees = [s.degreeU, s.degreeV] as const;
  if (
    !Array.isArray(maxNet) ||
    maxNet.length !== 2 ||
    !maxNet.every((n, d) => Number.isInteger(n) && n >= (degrees[d] as number) + 1)
  )
    return err(invalid('maxNet holds two integers >= the surface degrees + 1', { maxNet }));

  const nu = s.points.length;
  const nv = (s.points[0] as readonly Tuple3[]).length;
  if (distance === 0) {
    return ok({ surface: s, max: 0, rms: 0, net: [nu, nv], converged: true, minRadius: Infinity });
  }

  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  const us = sampleParameters(s.knotsU, s.degreeU, nu, maxNet[0]);
  const vs = sampleParameters(s.knotsV, s.degreeV, nv, maxNet[1]);
  const rows: Tuple3[][] = Array.from({ length: us.length }, () => new Array<Tuple3>(vs.length));
  let minRadius = Infinity;
  let limiting:
    | { readonly radius: number; readonly u: number; readonly v: number; readonly point: Tuple3 }
    | undefined;

  for (let i = 0; i < us.length; i++) {
    const row = rows[i] as Tuple3[];
    const tu = us[i] as number;
    const u = u0 + (u1 - u0) * tu;
    for (let j = 0; j < vs.length; j++) {
      const tv = vs[j] as number;
      const v = v0 + (v1 - v0) * tv;
      const curvature = surfaceCurvature(s, u, v);
      if (curvature === undefined)
        return err(
          modelingError(
            'model-degenerate',
            'the surface normal is defined at every offset sample',
            { u, v },
          ),
        );

      // Principal curvature is normal-dot-second-derivative. With this convention, the
      // offset derivative has factor (1 - distance * k); an outward cylinder has k = -1/R.
      // The offset reaches a focal radius only when distance and curvature have equal signs.
      for (const k of [curvature.k1, curvature.k2]) {
        if (k === 0 || distance * k <= 0) continue;
        const radius = 1 / Math.abs(k);
        if (radius < minRadius) {
          minRadius = radius;
          limiting = { radius, u, v, point: curvature.point };
        }
      }
      row[j] = [
        curvature.point[0] + distance * curvature.normal[0],
        curvature.point[1] + distance * curvature.normal[1],
        curvature.point[2] + distance * curvature.normal[2],
      ];
    }
  }
  if (limiting !== undefined && Math.abs(distance) >= limiting.radius)
    return err(
      modelingError(
        'model-precondition',
        'offset distance is smaller than every sampled radius on the side of motion',
        limiting,
      ),
    );

  const parameters = { u: us, v: vs };
  const fit = fitSurface(rows, {
    degree: degrees,
    net: 'auto',
    maxError: tolerance,
    maxNet,
    parameters,
  });
  if (!fit.ok) return fit;

  let fitted = fit.value.surface;
  let measured = parameterError(s, fitted, distance, us, vs);
  if (!measured.ok) return measured;
  let net = fit.value.net;
  while (measured.value.max > tolerance && (net[0] < maxNet[0] || net[1] < maxNet[1])) {
    const growU =
      net[0] < maxNet[0] && (net[1] >= maxNet[1] || net[0] / maxNet[0] <= net[1] / maxNet[1]);
    const nextNet: readonly [number, number] = growU ? [net[0] + 1, net[1]] : [net[0], net[1] + 1];
    const next = fitSurface(rows, { degree: degrees, net: nextNet, parameters });
    if (!next.ok) return next;
    fitted = next.value.surface;
    net = next.value.net;
    measured = parameterError(s, fitted, distance, us, vs);
    if (!measured.ok) return measured;
  }

  const surface: NurbsSurface = {
    ...fitted,
    knotsU: mapKnotDomain(fitted.knotsU, u0, u1),
    knotsV: mapKnotDomain(fitted.knotsV, v0, v1),
  };
  return ok({
    surface,
    max: measured.value.max,
    rms: measured.value.rms,
    net,
    converged: measured.value.max <= tolerance,
    minRadius,
  });
}
