import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import type { Tuple3 } from '../geom';
import { curveDerivatives, curvePoint as nurbsPoint } from '../nurbs';
import { tally } from './ops';
import { surfaceDomain, wrapPeriod } from './surfaces';
import { brepError, type Curve, type PCurve, type Surface } from './types';
import {
  add3,
  cross3,
  dot3,
  len3,
  madd3,
  type P2,
  type P3,
  scale3,
  sub3,
  TWO_PI,
  unit3,
} from './vec';

type AnalyticSurface = Exclude<Surface, { kind: 'nurbs' }>;

export function curvePoint(c: Curve, t: number): P3 {
  tally('curveEvals');
  switch (c.kind) {
    case 'line':
      return madd3(c.o, c.d, t);
    case 'circle': {
      const f = c.frame;
      return madd3(madd3(f.o, f.x, c.radius * cos(t)), f.y, c.radius * sin(t));
    }
    case 'ellipse': {
      const f = c.frame;
      return madd3(madd3(f.o, f.x, c.a * cos(t)), f.y, c.b * sin(t));
    }
    case 'nurbs':
      return nurbsPoint(c.curve, t);
  }
}

/** Derivative with respect to the curve parameter. */
export function curveTangent(c: Curve, t: number): P3 {
  tally('curveEvals');
  switch (c.kind) {
    case 'line':
      return c.d;
    case 'circle': {
      const f = c.frame;
      return add3(scale3(f.x, -c.radius * sin(t)), scale3(f.y, c.radius * cos(t)));
    }
    case 'ellipse': {
      const f = c.frame;
      return add3(scale3(f.x, -c.a * sin(t)), scale3(f.y, c.b * cos(t)));
    }
    case 'nurbs':
      return curveDerivatives(c.curve, t, 1)[1] as P3;
  }
}

export function pcurvePoint(p: PCurve, t: number): P2 {
  tally('curveEvals');
  if (p.kind === 'nurbs') {
    const q = nurbsPoint(p.curve, t);
    return [q[0], q[1]];
  }
  if (p.kind === 'line') return [p.o[0] + t * p.d[0], p.o[1] + t * p.d[1]];
  const a = p.dir * t + p.phase;
  return [p.c[0] + p.r * cos(a), p.c[1] + p.r * sin(a)];
}

export function pcurveTangent(p: PCurve, t: number): P2 {
  if (p.kind === 'nurbs') {
    const d = curveDerivatives(p.curve, t, 1)[1] as Tuple3;
    return [d[0], d[1]];
  }
  if (p.kind === 'line') return p.d;
  const a = p.dir * t + p.phase;
  return [-p.r * p.dir * sin(a), p.r * p.dir * cos(a)];
}

export function shiftPCurve(p: PCurve, du: number, dv: number): PCurve {
  if (du === 0 && dv === 0) return p;
  if (p.kind === 'nurbs') {
    const points = p.curve.points.map((q): Tuple3 => [q[0] + du, q[1] + dv, q[2]]);
    return { kind: 'nurbs', curve: { ...p.curve, points } };
  }
  return p.kind === 'line'
    ? { kind: 'line', o: [p.o[0] + du, p.o[1] + dv], d: p.d }
    : { ...p, c: [p.c[0] + du, p.c[1] + dv] };
}

const PARALLEL = 1e-9;

function unsupported(surface: Surface, curve: Curve, why: string): Result<PCurve, ModelingError> {
  return err(
    brepError('brep-pcurve-unsupported', `a closed-form pcurve (${why})`, {
      surface: surface.kind,
      curve: curve.kind,
    }),
  );
}

function parallel(a: P3, b: P3): boolean {
  return len3(cross3(a, b)) < PARALLEL;
}

/** Angle of the horizontal direction `d` in the frame of `s`, in [0, 2 pi). */
function angleIn(s: AnalyticSurface, d: P3): number {
  return wrapPeriod(atan2(dot3(d, s.frame.y), dot3(d, s.frame.x)));
}

function horizontal(s: AnalyticSurface, p: P3): P3 {
  const d = sub3(p, s.frame.o);
  return sub3(d, scale3(s.frame.z, dot3(d, s.frame.z)));
}

/**
 * The curve as a trim on the surface, parameterized by the curve parameter, in closed form.
 * A pair with no closed form (an oblique section, a NURBS curve) is `brep-pcurve-unsupported`.
 * The `u` of a periodic result lies in [0, 2 pi) at the start; the caller shifts whole periods.
 */
export function pcurveFor(
  surface: Surface,
  curve: Curve,
  t0: number,
  t1: number,
): Result<PCurve, ModelingError> {
  if (surface.kind === 'nurbs') {
    return unsupported(surface, curve, 'a NURBS surface needs an explicit pcurve');
  }
  const f = surface.frame;
  if (curve.kind === 'line') {
    const d = curve.d;
    const od = sub3(curve.o, f.o);
    switch (surface.kind) {
      case 'plane':
        return ok({
          kind: 'line',
          o: [dot3(od, f.x), dot3(od, f.y)],
          d: [dot3(d, f.x), dot3(d, f.y)],
        });
      case 'cylinder': {
        if (!parallel(d, f.z)) return unsupported(surface, curve, 'line parallel to the axis');
        const mid = madd3(curve.o, d, (t0 + t1) / 2);
        const h = horizontal(surface, mid);
        if (len3(h) < PARALLEL) return unsupported(surface, curve, 'line off the axis');
        return ok({ kind: 'line', o: [angleIn(surface, h), dot3(od, f.z)], d: [0, dot3(d, f.z)] });
      }
      case 'cone': {
        const sa = sin(surface.halfAngle);
        const ca = cos(surface.halfAngle);
        let best = madd3(curve.o, d, t0);
        for (const t of [t1, (t0 + t1) / 2]) {
          const p = madd3(curve.o, d, t);
          if (len3(horizontal(surface, p)) > len3(horizontal(surface, best))) best = p;
        }
        const h = horizontal(surface, best);
        if (len3(h) < PARALLEL) return unsupported(surface, curve, 'line off the apex');
        const e = unit3(h);
        const g = madd3(scale3(e, sa), f.z, ca);
        if (Math.abs(Math.abs(dot3(d, g)) - 1) > PARALLEL) {
          return unsupported(surface, curve, 'generatrix of the cone');
        }
        return ok({
          kind: 'line',
          o: [angleIn(surface, e), dot3(od, f.z) / ca],
          d: [0, dot3(d, f.z) / ca],
        });
      }
      default:
        return unsupported(surface, curve, 'line on this surface');
    }
  }
  if (curve.kind !== 'circle') return unsupported(surface, curve, 'circle or line');
  const cf = curve.frame;
  const co = sub3(cf.o, f.o);
  if (surface.kind === 'plane') {
    if (!parallel(cf.z, f.z)) return unsupported(surface, curve, 'circle parallel to the plane');
    return ok({
      kind: 'circle',
      c: [dot3(co, f.x), dot3(co, f.y)],
      r: curve.radius,
      phase: atan2(dot3(cf.x, f.y), dot3(cf.x, f.x)),
      dir: dot3(cf.z, f.z) > 0 ? 1 : -1,
    });
  }
  const axial = len3(sub3(co, scale3(f.z, dot3(co, f.z)))) < PARALLEL * Math.max(1, len3(co));
  if (parallel(cf.z, f.z)) {
    if (!axial) return unsupported(surface, curve, 'circle centered on the axis');
    const dir = dot3(cf.z, f.z) > 0 ? 1 : -1;
    const phase = angleIn(surface, cf.x);
    const h = dot3(co, f.z);
    let v: number;
    switch (surface.kind) {
      case 'cylinder':
        v = h;
        break;
      case 'sphere':
        v = atan2(h, curve.radius);
        break;
      case 'cone':
        v = h / cos(surface.halfAngle);
        break;
      case 'torus':
        v = atan2(h, curve.radius - surface.major);
        break;
    }
    return ok({ kind: 'line', o: [phase, v], d: [dir, 0] });
  }
  if (surface.kind !== 'sphere' && surface.kind !== 'torus') {
    return unsupported(surface, curve, 'circle about the axis');
  }
  if (Math.abs(dot3(cf.z, f.z)) > PARALLEL) return unsupported(surface, curve, 'meridian circle');
  let e: P3;
  if (surface.kind === 'sphere') {
    if (len3(co) > PARALLEL * Math.max(1, surface.radius)) {
      return unsupported(surface, curve, 'great circle');
    }
    const h = horizontal(surface, curvePoint(curve, (t0 + t1) / 2));
    if (len3(h) < PARALLEL) return unsupported(surface, curve, 'arc away from the poles');
    e = unit3(h);
  } else {
    const h = horizontal(surface, cf.o);
    if (len3(h) < PARALLEL || Math.abs(dot3(co, f.z)) > PARALLEL * Math.max(1, surface.major)) {
      return unsupported(surface, curve, 'meridian circle of the tube');
    }
    e = unit3(h);
  }
  const ae = dot3(cf.x, e);
  const az = dot3(cf.x, f.z);
  const be = dot3(cf.y, e);
  const bz = dot3(cf.y, f.z);
  const s = ae * bz - az * be > 0 ? 1 : -1;
  let psi = atan2(az, ae);
  const vm = psi + (s * (t0 + t1)) / 2;
  psi -= TWO_PI * Math.round(vm / TWO_PI);
  if (surface.kind === 'sphere') {
    const lim = surfaceDomain(surface).vMax + PARALLEL;
    const va = psi + s * t0;
    const vb = psi + s * t1;
    if (Math.abs(va) > lim || Math.abs(vb) > lim) {
      return unsupported(surface, curve, 'arc within one half meridian');
    }
  }
  return ok({ kind: 'line', o: [angleIn(surface, e), psi], d: [0, s] });
}
