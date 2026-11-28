import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { curvePoint, pcurveFor, pcurvePoint } from './curves';
import { nurbsAnalyticSection } from './intersect-nurbs-analytic';
import { nurbsNurbsSection } from './intersect-nurbs-nurbs';
import { type IntersectionWindow, planeSection, type RawBranch } from './intersect-plane';
import { quadricSection } from './intersect-quadric';
import type { SsiReason } from './ssi/types';
import { frameDefect, surfaceDomain, surfaceInverse, surfacePoint } from './surfaces';
import { TOL_FLOOR } from './tolerance';
import {
  type BrepDetailCode,
  brepFail,
  type Curve,
  deepFreeze,
  type PCurve,
  type Surface,
} from './types';
import { dist3, type P2, type P3 } from './vec';

export type { IntersectionWindow } from './intersect-plane';

export interface IntersectOptions {
  readonly window?: IntersectionWindow;
  /** Identities carried by a partial result; default `[0, 1]`. */
  readonly ids?: readonly [number, number];
}

/** A trim on one surface: a closed-form `PCurve`, or the lifted closure when the pair has none. */
export type BranchPCurve = PCurve | { readonly kind: 'lifted'; readonly at: (t: number) => P2 };

/**
 * `closed-form`: a line, circle or ellipse lying on both surfaces by construction, every sample within
 * tolerance. `bound`: a fitted curve; `bound` is the largest sampled distance from either surface,
 * widened by `BOUND_SAFETY`.
 */
export type IntersectionReceipt = 'closed-form' | { readonly bound: number };

export interface IntersectionBranch {
  readonly curve: Curve;
  readonly t0: number;
  readonly t1: number;
  readonly closed: boolean;
  readonly onA: BranchPCurve;
  readonly onB: BranchPCurve;
  readonly receipt: IntersectionReceipt;
}

export type IntersectionPartialCode = Extract<
  BrepDetailCode,
  'brep-ssi-tangent' | 'brep-ssi-coincident' | 'brep-ssi-unsupported'
>;

/** A pair the analytic route does not trace as branches: never a silent drop. */
export interface IntersectionPartial {
  readonly code: IntersectionPartialCode;
  readonly surfaces: readonly [number, number];
  /** Distance to the tangent or coincident configuration; null when none applies. */
  readonly gap: number | null;
  readonly contact?: P3;
  /** The exact SSI stop reason behind an analytic-route partial, when one was reported. */
  readonly reason?: SsiReason;
}

export interface SurfaceIntersection {
  readonly branches: readonly IntersectionBranch[];
  readonly partials: readonly IntersectionPartial[];
}

export function branchPCurvePoint(p: BranchPCurve, t: number): P2 {
  return p.kind === 'lifted' ? p.at(t) : pcurvePoint(p, t);
}

export const BOUND_SAFETY = 1.25;
const BOUND_FLOOR = 1e-12;
const LIFT_SAMPLES = 512;
const CLOSED_SAMPLES = 256;
const FITTED_SAMPLES = 2048;
const PCURVE_SAMPLES = 33;

function surfaceError(s: unknown): string | undefined {
  const x = s as Surface | null;
  if (typeof x !== 'object' || x === null) return 'surface-not-object';
  if (x.kind === 'nurbs') return undefined;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const defect = frameDefect(x.frame);
  if (defect !== undefined) return defect;
  switch (x.kind) {
    case 'plane':
      return undefined;
    case 'cylinder':
    case 'sphere':
      return finite(x.radius) && x.radius > 0 ? undefined : 'radius';
    case 'cone':
      return finite(x.radius) &&
        x.radius >= 0 &&
        finite(x.halfAngle) &&
        Math.abs(x.halfAngle) > 0 &&
        Math.abs(x.halfAngle) < Math.PI / 2
        ? undefined
        : 'cone-parameters';
    case 'torus':
      return finite(x.major) && finite(x.minor) && x.minor > 0 && x.major > 0
        ? undefined
        : 'torus-parameters';
    default:
      return 'surface-kind';
  }
}

function sampleDistance(curve: Curve, t0: number, t1: number, n: number, a: Surface, b: Surface) {
  let worst = 0;
  for (let i = 0; i <= n; i++) {
    const p = curvePoint(curve, t0 + ((t1 - t0) * i) / n);
    worst = Math.max(worst, surfaceInverse(a, p).dist, surfaceInverse(b, p).dist);
  }
  return worst;
}

function closedPCurve(s: Surface, raw: RawBranch, tol: number): PCurve | undefined {
  const r = pcurveFor(s, raw.curve, raw.t0, raw.t1);
  if (!r.ok) return undefined;
  for (let i = 0; i < PCURVE_SAMPLES; i++) {
    const t = raw.t0 + ((raw.t1 - raw.t0) * i) / (PCURVE_SAMPLES - 1);
    const uv = pcurvePoint(r.value, t);
    if (dist3(surfacePoint(s, uv[0], uv[1]), curvePoint(raw.curve, t)) > tol) return undefined;
  }
  return r.value;
}

/** The pcurve as a closure: the surface inverse of the curve point, unwrapped against a sample table. */
function lifted(s: Surface, raw: RawBranch): BranchPCurve {
  const dom = surfaceDomain(s);
  const span = raw.t1 - raw.t0;
  const us: number[] = [];
  const vs: number[] = [];
  const shift = (ref: number, x: number, period: number): number =>
    period > 0 ? x + period * Math.round((ref - x) / period) : x;
  for (let i = 0; i <= LIFT_SAMPLES; i++) {
    const inv = surfaceInverse(s, curvePoint(raw.curve, raw.t0 + (span * i) / LIFT_SAMPLES));
    us.push(i === 0 ? inv.u : shift(us[i - 1] as number, inv.u, dom.uPeriod));
    vs.push(i === 0 ? inv.v : shift(vs[i - 1] as number, inv.v, dom.vPeriod));
  }
  return {
    kind: 'lifted',
    at: (t) => {
      const i = Math.max(
        0,
        Math.min(LIFT_SAMPLES, Math.round(((t - raw.t0) / span) * LIFT_SAMPLES)),
      );
      const inv = surfaceInverse(s, curvePoint(raw.curve, t));
      return [
        shift(us[i] as number, inv.u, dom.uPeriod),
        shift(vs[i] as number, inv.v, dom.vPeriod),
      ];
    },
  };
}

function readOptions(options: IntersectOptions | undefined) {
  try {
    return { window: options?.window, ids: options?.ids };
  } catch {
    return undefined;
  }
}

function windowError(w: IntersectionWindow | undefined): boolean {
  if (w === undefined) return false;
  const c = w.c as readonly unknown[] | undefined;
  return !(
    Array.isArray(c) &&
    c.length === 3 &&
    c.every((x) => typeof x === 'number' && Number.isFinite(x)) &&
    typeof w.r === 'number' &&
    Number.isFinite(w.r) &&
    w.r > 0
  );
}

/**
 * Intersection of two analytic surfaces in closed form where one exists. The plane against each
 * surface kind is supported (a plane-torus section must be perpendicular or parallel to the axis);
 * every other pair, and a tangent or coincident contact, returns a partial with its code and the
 * surface ids rather than guessing. An unbounded branch needs `options.window` and covers its ball.
 */
export function intersectSurfaces(
  a: Surface,
  b: Surface,
  tol: number,
  options?: IntersectOptions,
): Result<SurfaceIntersection, ModelingError> {
  const read = readOptions(options);
  if (read === undefined) return brepFail('brep-bad-argument', 'options are readable', {});
  const ids: readonly [number, number] = read.ids ?? [0, 1];
  if (!Number.isFinite(tol) || tol < TOL_FLOOR) {
    return brepFail('brep-bad-argument', 'a finite tolerance >= 1e-9', { tol });
  }
  if (windowError(read.window)) {
    return brepFail('brep-bad-argument', 'a window with a finite centre and radius > 0', {});
  }
  if (
    !Array.isArray(ids) ||
    ids.length !== 2 ||
    !ids.every((x) => typeof x === 'number' && Number.isFinite(x))
  ) {
    return brepFail('brep-bad-argument', 'ids are two finite numbers', {});
  }
  for (const [name, s] of [
    ['a', a],
    ['b', b],
  ] as const) {
    const why = surfaceError(s);
    if (why !== undefined) {
      return brepFail('brep-bad-argument', 'a valid analytic surface', {
        surface: name,
        reason: why,
      });
    }
  }
  const partial = (code: IntersectionPartialCode, gap: number | null, contact?: P3) =>
    ({ code, surfaces: ids, gap, ...(contact === undefined ? {} : { contact }) }) as const;
  if (a.kind === 'nurbs' && b.kind === 'nurbs') return nurbsNurbsSection(a, b, { tol, ids });
  if (a.kind === 'nurbs' && b.kind !== 'nurbs')
    return nurbsAnalyticSection(a, b, true, { region: read.window, tol, ids });
  if (b.kind === 'nurbs' && a.kind !== 'nurbs')
    return nurbsAnalyticSection(b, a, false, { region: read.window, tol, ids });
  if (a.kind === 'nurbs' || b.kind === 'nurbs') {
    return ok(deepFreeze({ branches: [], partials: [partial('brep-ssi-unsupported', null)] }));
  }
  const found =
    a.kind !== 'plane' && b.kind !== 'plane'
      ? quadricSection(a, b, tol, read.window)
      : a.kind !== 'plane'
        ? planeSection(b, a, tol, read.window)
        : planeSection(a, b, tol, read.window);
  if (!found.ok) return found;
  const section = found.value;
  if (section.unsupported === true) {
    return ok(deepFreeze({ branches: [], partials: [partial('brep-ssi-unsupported', null)] }));
  }
  const branches: IntersectionBranch[] = [];
  for (const raw of section.raws) {
    const fitted = raw.curve.kind === 'nurbs';
    const worst = sampleDistance(
      raw.curve,
      raw.t0,
      raw.t1,
      fitted ? FITTED_SAMPLES : CLOSED_SAMPLES,
      a,
      b,
    );
    const bound = Math.max(worst * BOUND_SAFETY, BOUND_FLOOR);
    if (worst > tol) {
      return brepFail('brep-tol-exceeded', 'a section within tolerance of both surfaces', {
        curve: raw.curve.kind,
        deviation: worst,
        tol,
      });
    }
    const trim = (s: Surface): BranchPCurve => closedPCurve(s, raw, tol) ?? lifted(s, raw);
    branches.push({
      curve: raw.curve,
      t0: raw.t0,
      t1: raw.t1,
      closed: raw.closed,
      onA: trim(a),
      onB: trim(b),
      receipt:
        fitted || (section.offset ?? 0) > 0
          ? { bound: Math.max(bound, section.offset ?? 0) }
          : 'closed-form',
    });
  }
  const partials = (section.touches ?? []).map((t) => partial(t.code, t.gap, t.contact));
  return ok(deepFreeze({ branches, partials }));
}
