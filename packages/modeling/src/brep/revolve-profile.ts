import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, hypot2, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { modelingError } from '../errors';
import {
  checkCurve,
  checkSurface,
  curvePoint,
  domain,
  type InterpolateOptions,
  interpolate,
  type NurbsCurve,
  type NurbsSurface,
} from '../nurbs';
import { type LoopEdge, ShapeAssembler } from './assembler';
import { area2, ringDefect } from './profile';
import { RING_CIRCLE, RING_CIRCLE_WEIGHTS, ringTrimCurve } from './ring-fit';
import { frameDefect } from './surfaces';
import type { ToleranceOptions } from './tolerance';
import type { Frame, Shape } from './types';
import { cross3, dist3, madd3, type P2, type P3, scale3, sub3, TWO_PI, unit3 } from './vec';

/** One profile edge in the (radius, z) plane, from the previous point to `to`. */
export type ProfileSegment =
  | { readonly kind: 'line'; readonly to: P2 }
  | {
      readonly kind: 'arc';
      readonly to: P2;
      /** Centre of the circle in the (radius, z) plane; on the axis it makes a sphere, off it a torus. */
      readonly center: P2;
      /** Direction about `center` (default true: counter-clockwise in the (radius, z) plane). */
      readonly ccw?: boolean;
    }
  | {
      /**
       * Free-form profile: `curve` has control points `[radius, z, 0]` and clamped end points at the
       * previous profile point and `to`. Requires a full-turn revolve; the surface is exact and rational.
       */
      readonly kind: 'nurbs';
      readonly to: P2;
      readonly curve: NurbsCurve;
    };

/**
 * Profile segment through `points` ([radius, z] pairs, the first being the previous profile point
 * and the last the segment end) by interpolation with `interpolate`.
 */
export function nurbsSegment(
  points: readonly P2[],
  options: InterpolateOptions = {},
): Result<ProfileSegment, ModelingError> {
  if (points.length < 2 || !points.every(isP2)) {
    return bad('at least two finite [radius, z] points');
  }
  const fit = interpolate(
    points.map((p): [number, number, number] => [p[0], p[1], 0]),
    options,
  );
  if (!fit.ok) return fit;
  const segment: ProfileSegment = {
    kind: 'nurbs',
    to: points[points.length - 1] as P2,
    curve: fit.value,
  };
  return ok(segment);
}

export interface RevolveProfileOptions extends ToleranceOptions {
  readonly start: P2;
  /**
   * Counter-clockwise in the (radius, z) plane. An open profile starts and ends on the axis
   * (radius 0); a closed one returns to `start` and keeps every radius positive.
   */
  readonly segments: readonly ProfileSegment[];
  /** Sweep about the frame z through the frame origin, in (0, 2 pi]; default a full turn. */
  readonly angle?: number;
  readonly frame?: Frame;
  /** Face labels are `<label>.s<i>`, `<label>.cap0` and `<label>.cap1`. */
  readonly label?: string;
  readonly role?: string;
}

interface Arc {
  readonly c: P2;
  readonly radius: number;
  readonly a0: number;
  readonly sweep: number;
  readonly ccw: boolean;
}

interface Seg {
  readonly from: number;
  readonly to: number;
  readonly arc: Arc | undefined;
  readonly curve: NurbsCurve | undefined;
}

const ARC_SAMPLES = 16;
const NURBS_SAMPLES = 32;
const WORLD: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const ANGLE_EPS = 1e-12;

function bad(expected: string, detail: Record<string, unknown> = {}): Result<never, ModelingError> {
  return err(
    modelingError('model-invalid-argument', expected, { brep: 'brep-bad-argument', ...detail }),
  );
}

function partial(expected: string, detail: Record<string, unknown>): Result<never, ModelingError> {
  return err(modelingError('model-partial', expected, detail));
}

function isP2(p: unknown): p is P2 {
  return Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

/** Angle in (0, 2 pi] swept from `from` to `to` going counter-clockwise. */
function wrapPositive(from: number, to: number): number {
  let s = to - from;
  while (s <= 0) s += TWO_PI;
  while (s > TWO_PI) s -= TWO_PI;
  return s;
}

/**
 * Revolve a profile of lines and circular arcs about the frame z axis through the frame origin.
 * Lines give planes, cylinders and cones; an arc centred on the axis gives a sphere and one centred off
 * the axis a torus. A partial angle adds two planar end caps. Anything else (spindle or horn tori, arcs
 * crossing the axis, unknown edge kinds) fails closed as `model-partial`.
 */
export function revolveProfile(options: RevolveProfileOptions): Result<Shape, ModelingError> {
  const { start, segments } = options;
  if (!isP2(start) || !Array.isArray(segments) || segments.length < 1) {
    return bad('a finite start point and at least one profile segment');
  }
  const angle = options.angle ?? TWO_PI;
  if (!Number.isFinite(angle) || angle <= 0 || angle > TWO_PI + ANGLE_EPS) {
    return bad('an angle in (0, 2 pi]', { angle });
  }
  const full = angle >= TWO_PI - ANGLE_EPS;
  const sweep = full ? TWO_PI : angle;
  const raw: P2[] = [start];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] as ProfileSegment;
    if (s === null || typeof s !== 'object' || !isP2(s.to)) {
      return bad('a segment with a finite end point', { index: i });
    }
    if (s.kind === 'arc') {
      if (!isP2(s.center)) return bad('an arc with a finite centre', { index: i });
    } else if (s.kind === 'nurbs') {
      const checked = checkCurve(s.curve);
      if (!checked.ok) return checked;
    } else if (s.kind !== 'line') {
      return partial('a line or circular-arc profile edge', {
        reason: 'profile-edge-kind',
        index: i,
        kind: (s as { kind?: unknown }).kind,
      });
    }
    raw.push(s.to);
  }
  let rmax = 0;
  let zmin = Number.POSITIVE_INFINITY;
  let zmax = Number.NEGATIVE_INFINITY;
  for (const p of raw) {
    rmax = Math.max(rmax, Math.abs(p[0]));
    zmin = Math.min(zmin, p[1]);
    zmax = Math.max(zmax, p[1]);
  }
  for (const s of segments) {
    if (s.kind === 'arc') {
      rmax = Math.max(
        rmax,
        Math.abs(s.center[0]) + hypot2(s.to[0] - s.center[0], s.to[1] - s.center[1]),
      );
      zmin = Math.min(zmin, s.center[1]);
      zmax = Math.max(zmax, s.center[1]);
    } else if (s.kind === 'nurbs') {
      const [a, b] = domain(s.curve);
      for (let j = 0; j <= NURBS_SAMPLES; j++) {
        const p = curvePoint(s.curve, a + ((b - a) * j) / NURBS_SAMPLES);
        rmax = Math.max(rmax, Math.abs(p[0]));
        zmin = Math.min(zmin, p[1]);
        zmax = Math.max(zmax, p[1]);
      }
    }
  }
  if (
    segments.some((s) => s.kind === 'nurbs') &&
    !(options.angle === undefined || options.angle >= TWO_PI - ANGLE_EPS)
  ) {
    return bad('a full-turn revolve for a NURBS profile segment', { reason: 'nurbs-partial-turn' });
  }
  const frame = options.frame ?? WORLD;
  const defect = frameDefect(frame);
  if (defect !== undefined) return bad('an orthonormal right-handed frame', { reason: defect });
  const created = ShapeAssembler.create(hypot2(2 * rmax, zmax - zmin), options);
  if (!created.ok) return created;
  const asm = created.value;
  const tol = asm.tol;
  const label = options.label ?? 'revolve';
  const role = options.role ?? '';

  const snap = (p: P2): P2 => (Math.abs(p[0]) <= tol ? [0, p[1]] : p);
  const lastRaw = raw[raw.length - 1] as P2;
  const closed = hypot2(lastRaw[0] - start[0], lastRaw[1] - start[1]) <= tol;
  const cornerCount = closed ? segments.length : segments.length + 1;
  const corners: P2[] = [];
  for (let i = 0; i < cornerCount; i++) corners.push(snap(raw[i] as P2));
  if (corners.some((p) => p[0] < 0)) return bad('a profile with radius >= 0');
  const first = corners[0] as P2;
  const last = corners[cornerCount - 1] as P2;
  if (closed ? corners.some((p) => p[0] === 0) : first[0] !== 0 || last[0] !== 0) {
    return bad(
      closed
        ? 'a closed profile with positive radii'
        : 'an open profile starting and ending on the axis',
      closed ? {} : { reason: 'profile-not-on-axis' },
    );
  }
  if (!closed && corners.slice(1, -1).some((p) => p[0] === 0)) {
    return bad('an open profile that meets the axis only at its two ends', {
      reason: 'profile-touches-axis',
    });
  }

  const segs: Seg[] = [];
  const ring: P2[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] as ProfileSegment;
    const from = i;
    const to = closed && i === segments.length - 1 ? 0 : i + 1;
    const p = corners[from] as P2;
    const q = corners[to] as P2;
    ring.push(p);
    if (s.kind === 'line') {
      if (p[0] === 0 && q[0] === 0) {
        return bad('a line segment off the axis', { reason: 'segment-on-axis', index: i });
      }
      if (dist3([p[0], p[1], 0], [q[0], q[1], 0]) <= tol) {
        return bad('a profile without repeated points', { index: i });
      }
      segs.push({ from, to, arc: undefined, curve: undefined });
      continue;
    }
    if (s.kind === 'nurbs') {
      const [a, b] = domain(s.curve);
      const start = curvePoint(s.curve, a);
      const end = curvePoint(s.curve, b);
      if (
        hypot2(start[0] - p[0], start[1] - p[1]) > tol ||
        hypot2(end[0] - q[0], end[1] - q[1]) > tol
      ) {
        return bad('a NURBS profile whose end points match the profile points', {
          reason: 'nurbs-endpoint-mismatch',
          index: i,
        });
      }
      // Control radii are a sufficient certificate: a rational curve with non-negative control radii
      // (weights positive) keeps non-negative radius for the convex hull property.
      const controlRadiusOk = s.curve.points.every((c) => c[0] >= -tol);
      if (!controlRadiusOk) {
        return bad('a NURBS profile with radius >= 0', { reason: 'nurbs-radius', index: i });
      }
      for (let j = 0; j <= NURBS_SAMPLES; j++) {
        const point = curvePoint(s.curve, a + ((b - a) * j) / NURBS_SAMPLES);
        if (point[0] < -tol) {
          return partial('a NURBS profile that stays on one side of the axis', {
            reason: 'nurbs-crosses-axis',
            index: i,
          });
        }
        if (j > 0 && j < NURBS_SAMPLES) ring.push([Math.max(0, point[0]), point[1]]);
      }
      segs.push({ from, to, arc: undefined, curve: s.curve });
      continue;
    }
    const c = snap(s.center);
    const r1 = hypot2(p[0] - c[0], p[1] - c[1]);
    const r2 = hypot2(q[0] - c[0], q[1] - c[1]);
    if (Math.abs(r1 - r2) > 2 * tol) {
      return bad('an arc whose end points are equidistant from its centre', {
        reason: 'arc-radius-mismatch',
        index: i,
        radii: [r1, r2],
      });
    }
    const radius = (r1 + r2) / 2;
    if (radius <= 2 * tol)
      return bad('an arc radius greater than twice the tolerance', { index: i });
    const ccw = s.ccw ?? true;
    const a0 = atan2(p[1] - c[1], p[0] - c[0]);
    const a1 = atan2(q[1] - c[1], q[0] - c[0]);
    const arcSweep = ccw ? wrapPositive(a0, a1) : wrapPositive(a1, a0);
    if (dist3([p[0], p[1], 0], [q[0], q[1], 0]) <= tol) {
      return bad('an arc with distinct end points (split a full circle in two)', { index: i });
    }
    if (c[0] < 0 || (c[0] > 0 && c[0] <= radius + 2 * tol)) {
      return partial(
        'an arc centred on the axis (sphere) or farther from it than its radius (torus)',
        { reason: 'torus-degenerate', index: i, centerRadius: c[0], arcRadius: radius },
      );
    }
    const arc: Arc = { c, radius, a0, sweep: arcSweep, ccw };
    for (let j = 1; j < ARC_SAMPLES; j++) {
      const t = a0 + (ccw ? 1 : -1) * ((arcSweep * j) / ARC_SAMPLES);
      const point: P2 = [c[0] + radius * cos(t), c[1] + radius * sin(t)];
      if (point[0] < -tol) {
        return partial('an arc that stays on one side of the axis', {
          reason: 'arc-crosses-axis',
          index: i,
        });
      }
      ring.push(point);
    }
    segs.push({ from, to, arc, curve: undefined });
  }
  if (!closed) ring.push(last);
  const crossing = ringDefect([ring], tol, 'profile');
  if (crossing !== undefined) {
    return bad(crossing.expected, { reason: crossing.reason, ...crossing.ids });
  }
  if (!(area2(ring) > 0)) return bad('a profile counter-clockwise in the (radius, z) plane');
  if (!full && (angle * rmax <= 2 * tol || (TWO_PI - angle) * rmax <= 2 * tol)) {
    return bad('an angle whose arc and gap are longer than twice the tolerance', { angle });
  }

  const pt = (p: P3): P3 =>
    madd3(madd3(madd3(frame.o, frame.x, p[0]), frame.y, p[1]), frame.z, p[2]);
  const dir = (d: P3): P3 => madd3(madd3(scale3(frame.x, d[0]), frame.y, d[1]), frame.z, d[2]);
  const local = (o: P3, z: P3, x: P3): Frame => {
    const zz = dir(z);
    const xx = dir(x);
    return { o: pt(o), x: xx, y: cross3(zz, xx), z: zz };
  };
  const at = (p: P2, theta: number): P3 => pt([p[0] * cos(theta), p[0] * sin(theta), p[1]]);

  const lines = new Map<string, number>();
  const lineEdge = (a: P3, b: P3): LoopEdge => {
    const va = asm.vertex(a);
    const vb = asm.vertex(b);
    const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
    const known = lines.get(key);
    if (known !== undefined) return { edge: known };
    const curve = asm.curve({ kind: 'line', o: a, d: unit3(sub3(b, a)) });
    const edge = asm.edge(curve, 0, dist3(a, b));
    lines.set(key, edge);
    return { edge };
  };
  const rings = new Map<number, LoopEdge>();
  const ringAt = (k: number): LoopEdge | undefined => {
    const p = corners[k] as P2;
    if (p[0] === 0) return undefined;
    let e = rings.get(k);
    if (e === undefined) {
      const f = local([0, 0, p[1]], [0, 0, 1], [1, 0, 0]);
      e = { edge: asm.edge(asm.curve({ kind: 'circle', frame: f, radius: p[0] }), 0, sweep) };
      rings.set(k, e);
    }
    return e;
  };
  const seamAt = (s: Seg, theta: number): LoopEdge => {
    if (s.arc === undefined) {
      return lineEdge(at(corners[s.from] as P2, theta), at(corners[s.to] as P2, theta));
    }
    const { c, radius, a0, sweep: arcSweep, ccw } = s.arc;
    const x = dir([cos(theta), sin(theta), 0]);
    const y = dir([0, 0, 1]);
    const f: Frame = { o: at(c, theta), x, y, z: cross3(x, y) };
    const curve = asm.curve({ kind: 'circle', frame: f, radius });
    return { edge: ccw ? asm.edge(curve, a0, a0 + arcSweep) : asm.edge(curve, a0 - arcSweep, a0) };
  };

  /**
   * Profile curve of a NURBS segment as a 3D edge at angle 0 (the revolve is full, so both seams are
   * this edge). Its (u, v) pcurve is the constant u with v the profile parameter, which is exact: the
   * Greville abscissae reproduce the identity in the knot domain.
   */
  const mutable = (p: P3): [number, number, number] => [p[0], p[1], p[2]];
  const profileEdges = new Map<number, number>();
  const nurbsSeam = (index: number, u: 0 | 1): LoopEdge => {
    const curve = (segs[index] as Seg).curve as NurbsCurve;
    let edge = profileEdges.get(index);
    if (edge === undefined) {
      const world: NurbsCurve = {
        degree: curve.degree,
        knots: [...curve.knots],
        points: curve.points.map((c): [number, number, number] => mutable(pt([c[0], 0, c[1]]))),
        ...(curve.weights === undefined ? {} : { weights: [...curve.weights] }),
      };
      const [a, b] = domain(curve);
      edge = asm.edge(asm.curve({ kind: 'nurbs', curve: world }), a, b);
      profileEdges.set(index, edge);
    }
    const p = curve.degree;
    const points = curve.points.map((_, j): [number, number, number] => {
      let greville = 0;
      for (let k = 1; k <= p; k++) greville += curve.knots[j + k] as number;
      return [u, greville / p, 0];
    });
    return {
      edge,
      pcurve: { kind: 'nurbs', curve: { degree: p, knots: [...curve.knots], points } },
    };
  };

  /**
   * Exact rational surface of revolution over one NURBS profile segment: u runs around the rational
   * circle (weights multiplied by the profile weights), v along the profile, all in the revolve
   * frame. Each ring keeps its analytic circle edge with a fitted (u, v) trim at the profile end;
   * the seams are the profile curve itself at u = 0 and u = 1.
   */
  const nurbsFace = (
    index: number,
    curve: NurbsCurve,
    p: P2,
    q: P2,
    name: string,
  ): Result<number, ModelingError> => {
    const surface: NurbsSurface = {
      degreeU: 2,
      degreeV: curve.degree,
      points: RING_CIRCLE.points.map((c) =>
        curve.points.map((pc): [number, number, number] =>
          mutable(pt([c[0] * pc[0], c[1] * pc[0], pc[1]])),
        ),
      ),
      weights: RING_CIRCLE_WEIGHTS.map((wu) =>
        curve.points.map((_, j) => wu * (curve.weights?.[j] ?? 1)),
      ),
      knotsU: [...(RING_CIRCLE.knots as number[])],
      knotsV: [...curve.knots],
    };
    const checked = checkSurface(surface);
    if (!checked.ok) return checked;
    const sid = asm.surface({ kind: 'nurbs', surface });
    const seg = segs[index] as Seg;
    const [a, b] = domain(curve);
    const lowIndex = p[1] <= q[1] ? seg.from : seg.to;
    const highIndex = p[1] <= q[1] ? seg.to : seg.from;
    const lowAtStart = lowIndex === seg.from;
    const low = ringTrim(lowIndex, lowAtStart ? a : b, 0);
    if (!low.ok) return low;
    const high = ringTrim(highIndex, lowAtStart ? b : a, 1);
    if (!high.ok) return high;
    const loop: LoopEdge[] = [nurbsSeam(index, 1), high.value, nurbsSeam(index, 0), low.value];
    return add(sid, [loop], false, name);
  };

  /**
   * Ring boundary of a NURBS face at profile corner `index`, trimmed at profile parameter `v`: the
   * analytic circle edge (param = angle) with a fitted (u, v) trim. An axis corner has no ring and
   * becomes the pole edge.
   */
  const ringTrim = (index: number, v: number, end: 0 | 1): Result<LoopEdge, ModelingError> => {
    const corner = corners[index] as P2;
    const ring = ringAt(index);
    if (ring === undefined) return ok(poleEdge(corner, end));
    const trim = ringTrimCurve(corner[0], tol, v);
    if (!trim.ok) return trim;
    return ok({ edge: ring.edge, pcurve: { kind: 'nurbs', curve: trim.value } });
  };

  /**
   * A pole on the axis: one vertex with no curve. Its span runs the rational circle's unit u-range
   * (0 to 1 or back), carrying the loop across the pole.
   */
  const poleEdge = (corner: P2, end: 0 | 1): LoopEdge => ({
    edge: asm.degenerateEdge(asm.vertex(at(corner, 0))),
    span: [end === 0 ? 1 : -1, 0],
  });

  const add = (
    surface: number,
    loops: readonly (readonly LoopEdge[])[],
    reversed: boolean,
    name: string,
  ): Result<number, ModelingError> => {
    const ids: number[] = [];
    for (let i = 0; i < loops.length; i++) {
      const l = asm.loop(surface, loops[i] as readonly LoopEdge[], i === 0);
      if (!l.ok) return l;
      ids.push(l.value);
    }
    return ok(asm.face(surface, ids, reversed, `${label}.${name}`, role));
  };

  const faces: number[] = [];
  const push = (r: Result<number, ModelingError>): Result<number, ModelingError> => {
    if (r.ok) faces.push(r.value);
    return r;
  };
  const memo = new Map<string, LoopEdge>();
  const seamFor = (i: number, theta: number): LoopEdge => {
    const key = `${i}:${theta}`;
    let e = memo.get(key);
    if (e === undefined) {
      e = seamAt(segs[i] as Seg, theta);
      memo.set(key, e);
    }
    return e;
  };
  const seam0 = (i: number): LoopEdge => seamFor(i, 0);
  const seam1 = (i: number): LoopEdge => (full ? seam0(i) : seamFor(i, sweep));

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] as Seg;
    const p = corners[s.from] as P2;
    const q = corners[s.to] as P2;
    const name = `s${i}`;
    if (s.curve !== undefined) {
      const r = push(nurbsFace(i, s.curve, p, q, name));
      if (!r.ok) return r;
      continue;
    }
    if (s.arc === undefined && p[1] === q[1]) {
      const outward = q[0] > p[0];
      const surface = asm.surface({
        kind: 'plane',
        frame: local([0, 0, p[1]], [0, 0, outward ? -1 : 1], [1, 0, 0]),
      });
      const bigIndex = p[0] > q[0] ? s.from : s.to;
      const smallIndex = p[0] > q[0] ? s.to : s.from;
      const big = ringAt(bigIndex) as LoopEdge;
      const small = ringAt(smallIndex);
      const loops: LoopEdge[][] = full
        ? small === undefined
          ? [[big]]
          : [[big], [small]]
        : small === undefined
          ? [[big, seam1(i), seam0(i)]]
          : [[big, seam1(i), small, seam0(i)]];
      const r = push(add(surface, loops, false, name));
      if (!r.ok) return r;
      continue;
    }
    const a = s.arc;
    const up = a === undefined ? q[1] > p[1] : a.ccw;
    const lowIndex = up ? s.from : s.to;
    const highIndex = up ? s.to : s.from;
    const lo = corners[lowIndex] as P2;
    const hi = corners[highIndex] as P2;
    let surface: number;
    if (a === undefined) {
      surface =
        p[0] === q[0]
          ? asm.surface({
              kind: 'cylinder',
              frame: local([0, 0, 0], [0, 0, 1], [1, 0, 0]),
              radius: lo[0],
            })
          : asm.surface({
              kind: 'cone',
              frame: local([0, 0, lo[1]], [0, 0, 1], [1, 0, 0]),
              radius: lo[0],
              halfAngle: atan2(hi[0] - lo[0], hi[1] - lo[1]),
            });
    } else if (a.c[0] === 0) {
      surface = asm.surface({
        kind: 'sphere',
        frame: local([0, 0, a.c[1]], [0, 0, 1], [1, 0, 0]),
        radius: a.radius,
      });
    } else {
      surface = asm.surface({
        kind: 'torus',
        frame: local([0, 0, a.c[1]], [0, 0, 1], [1, 0, 0]),
        major: a.c[0],
        minor: a.radius,
      });
    }
    const lowRing = ringAt(lowIndex);
    const highRing = ringAt(highIndex);
    const lowLoop: LoopEdge = lowRing ?? {
      edge: asm.degenerateEdge(asm.vertex(at(lo, 0))),
      span: [sweep, 0],
    };
    const highLoop: LoopEdge = highRing ?? {
      edge: asm.degenerateEdge(asm.vertex(at(hi, 0))),
      span: [-sweep, 0],
    };
    const right = seam1(i);
    const left = seam0(i);
    const loop =
      lowRing === undefined ? [right, highLoop, left, lowLoop] : [lowLoop, right, highLoop, left];
    const r = push(add(surface, [loop], !up, name));
    if (!r.ok) return r;
  }

  if (!full) {
    const axis: LoopEdge[] = closed ? [] : [lineEdge(pt([0, 0, last[1]]), pt([0, 0, first[1]]))];
    const cap0 = asm.surface({
      kind: 'plane',
      frame: local([0, 0, 0], [0, -1, 0], [1, 0, 0]),
    });
    const cap1 = asm.surface({
      kind: 'plane',
      frame: local([0, 0, 0], [-sin(sweep), cos(sweep), 0], [cos(sweep), sin(sweep), 0]),
    });
    const r0 = push(add(cap0, [[...segs.map((_, i) => seam0(i)), ...axis]], false, 'cap0'));
    if (!r0.ok) return r0;
    const r1 = push(add(cap1, [[...segs.map((_, i) => seam1(i)), ...axis]], false, 'cap1'));
    if (!r1.ok) return r1;
  }
  asm.shell(faces);
  return asm.finish();
}
