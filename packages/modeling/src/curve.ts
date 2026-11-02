import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  type Axis,
  add,
  axisIndex,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  type Tuple3,
} from './geom';
import { requireFinite, requirePositive, requireSegments } from './ops';

/** Corner rounding of a polyline: each corner becomes a circular arc of `radius`. */
export interface PathBend {
  readonly radius: number;
  /** Arc segments per corner (>= 1). */
  readonly segments: number;
}

/**
 * A 3D path, sampled into a polyline before use. Smooth kinds carry their own
 * sampling density; whether the path closes is the consumer's `closed` option.
 */
export type PathSpec =
  | {
      readonly kind: 'polyline';
      readonly points: readonly Tuple3[];
      readonly bend?: PathBend;
    }
  | {
      /** Centripetal Catmull-Rom through `points` (no cusps or self-loops on spans). */
      readonly kind: 'catmullRom';
      readonly points: readonly Tuple3[];
      /** Samples per control span (>= 1). */
      readonly segments: number;
    }
  | {
      /** Circular arc about `axis` through `center`, right-handed (revolve convention). */
      readonly kind: 'arc';
      readonly radius: number;
      /** Degrees, within (0, 360]. */
      readonly angle: number;
      readonly segments: number;
      readonly axis?: Axis;
      readonly center?: Tuple3;
      /** Degrees; 0 lies on the axis after `axis` in x, y, z order (z for 'y'). */
      readonly startAngle?: number;
    }
  | {
      /** Helix rising along `axis` from `center`: springs and threads. */
      readonly kind: 'helix';
      readonly radius: number;
      /** Rise per turn along the axis (meters, > 0). */
      readonly pitch: number;
      /** Number of turns (> 0, fractional allowed). */
      readonly turns: number;
      /** Samples per turn (>= 3). */
      readonly segments: number;
      readonly axis?: Axis;
      readonly center?: Tuple3;
      readonly startAngle?: number;
      /** 'right' (default) turns right-handed about the rising axis. */
      readonly handedness?: 'right' | 'left';
    };

/** A path: a spec, or a bare point list meaning a polyline. */
export type PathInput = PathSpec | readonly Tuple3[];

/** Builders for path specs; plain objects, so they serialize into the journal. */
export const path = {
  polyline: (points: readonly Tuple3[], bend?: PathBend): PathSpec =>
    bend === undefined ? { kind: 'polyline', points } : { kind: 'polyline', points, bend },
  catmullRom: (points: readonly Tuple3[], segments: number): PathSpec => ({
    kind: 'catmullRom',
    points,
    segments,
  }),
  arc: (options: Omit<Extract<PathSpec, { kind: 'arc' }>, 'kind'>): PathSpec => ({
    kind: 'arc',
    ...options,
  }),
  helix: (options: Omit<Extract<PathSpec, { kind: 'helix' }>, 'kind'>): PathSpec => ({
    kind: 'helix',
    ...options,
  }),
};

function requirePoint(name: string, p: Tuple3): Result<void, ModelingError> {
  for (const c of p) {
    const checked = requireFinite(name, c);
    if (!checked.ok) return checked;
  }
  return ok(undefined);
}

function requirePoints(
  name: string,
  points: readonly Tuple3[],
  minimum: number,
): Result<void, ModelingError> {
  if (points.length < minimum) {
    return err(
      modelingError('model-invalid-argument', `${name} has at least ${minimum} points`, {
        count: points.length,
      }),
    );
  }
  for (const p of points) {
    const checked = requirePoint(name, p);
    if (!checked.ok) return checked;
  }
  return ok(undefined);
}

function same(a: Tuple3, b: Tuple3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Unit vectors (u, w) of the plane about `axis`, right-handed: u x w = axis. */
function planeAxes(axis: Axis): [Tuple3, Tuple3, Tuple3] {
  const k = axisIndex(axis);
  const e = (i: number): Tuple3 => [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
  return [e((k + 1) % 3), e((k + 2) % 3), e(k)];
}

function filletCorners(
  points: readonly Tuple3[],
  closed: boolean,
  bend: PathBend,
): Result<Tuple3[], ModelingError> {
  const radius = requirePositive('bend.radius', bend.radius);
  if (!radius.ok) return radius;
  const segments = requireSegments('bend.segments', bend.segments, 1);
  if (!segments.ok) return segments;
  const n = points.length;
  const at = (i: number) => points[(i + n) % n] as Tuple3;
  const reach: number[] = [];
  const out: Tuple3[] = [];
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) {
      reach.push(0);
      continue;
    }
    const d1 = normalize(sub(at(i), at(i - 1)));
    const d2 = normalize(sub(at(i + 1), at(i)));
    const turn = atan2(length(cross(d1, d2)), dot(d1, d2));
    reach.push(turn <= 1e-9 ? 0 : (bend.radius * sin(turn / 2)) / cos(turn / 2));
  }
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const span = length(sub(at(i + 1), at(i)));
    if ((reach[i] as number) + (reach[(i + 1) % n] as number) > span) {
      return err(
        modelingError(
          'model-invalid-argument',
          'neighbouring corner bends fit on the span between them',
          { span: i, length: span, needed: (reach[i] as number) + (reach[(i + 1) % n] as number) },
          'reduce bend.radius or move the corners apart',
        ),
      );
    }
  }
  for (let i = 0; i < n; i++) {
    const t = reach[i] as number;
    if (t === 0) {
      out.push([...at(i)]);
      continue;
    }
    const d1 = normalize(sub(at(i), at(i - 1)));
    const d2 = normalize(sub(at(i + 1), at(i)));
    const turn = atan2(length(cross(d1, d2)), dot(d1, d2));
    const start = sub(at(i), scale(d1, t));
    const center = add(at(i), scale(normalize(sub(d2, d1)), bend.radius / cos(turn / 2)));
    const u0 = sub(start, center);
    const normal = normalize(cross(d1, d2));
    const v0 = cross(normal, u0);
    for (let k = 0; k <= bend.segments; k++) {
      const phi = (turn * k) / bend.segments;
      out.push(add(center, add(scale(u0, cos(phi)), scale(v0, sin(phi)))));
    }
  }
  return ok(out);
}

function catmullRom(
  points: readonly Tuple3[],
  closed: boolean,
  segments: number,
): Result<Tuple3[], ModelingError> {
  const n = points.length;
  const control = (i: number): Tuple3 => {
    if (closed) return points[(i + n) % n] as Tuple3;
    if (i < 0) return sub(scale(points[0] as Tuple3, 2), points[1] as Tuple3);
    if (i >= n) return sub(scale(points[n - 1] as Tuple3, 2), points[n - 2] as Tuple3);
    return points[i] as Tuple3;
  };
  const lerp = (a: Tuple3, b: Tuple3, ta: number, tb: number, t: number): Tuple3 =>
    add(scale(a, (tb - t) / (tb - ta)), scale(b, (t - ta) / (tb - ta)));
  const out: Tuple3[] = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = control(i - 1);
    const p1 = control(i);
    const p2 = control(i + 1);
    const p3 = control(i + 2);
    const t0 = 0;
    const t1 = t0 + Math.sqrt(length(sub(p1, p0)));
    const t2 = t1 + Math.sqrt(length(sub(p2, p1)));
    const t3 = t2 + Math.sqrt(length(sub(p3, p2)));
    if (t1 === t0 || t2 === t1 || t3 === t2) {
      return err(modelingError('model-degenerate', 'consecutive path points differ', { span: i }));
    }
    const last = !closed && i === spans - 1 ? segments : segments - 1;
    for (let k = 0; k <= last; k++) {
      if (k === 0) {
        out.push([...p1]);
        continue;
      }
      if (k === segments) {
        out.push([...p2]);
        continue;
      }
      const t = t1 + ((t2 - t1) * k) / segments;
      const a1 = lerp(p0, p1, t0, t1, t);
      const a2 = lerp(p1, p2, t1, t2, t);
      const a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t);
      const b2 = lerp(a2, a3, t1, t3, t);
      out.push(lerp(b1, b2, t1, t2, t));
    }
  }
  return ok(out);
}

function sampleSpec(spec: PathSpec, closed: boolean): Result<Tuple3[], ModelingError> {
  switch (spec.kind) {
    case 'polyline': {
      const checked = requirePoints('path.points', spec.points, closed ? 3 : 2);
      if (!checked.ok) return checked;
      let points = [...spec.points];
      if (closed && points.length > 3 && same(points[0] as Tuple3, points.at(-1) as Tuple3)) {
        points = points.slice(0, -1);
      }
      return spec.bend === undefined ? ok(points) : filletCorners(points, closed, spec.bend);
    }
    case 'catmullRom': {
      const checked = requirePoints('path.points', spec.points, closed ? 3 : 2);
      if (!checked.ok) return checked;
      const segments = requireSegments('path.segments', spec.segments, 1);
      if (!segments.ok) return segments;
      return catmullRom(spec.points, closed, spec.segments);
    }
    case 'arc': {
      const radius = requirePositive('path.radius', spec.radius);
      if (!radius.ok) return radius;
      const angle = requireFinite('path.angle', spec.angle);
      if (!angle.ok) return angle;
      if (spec.angle <= 0 || spec.angle > 360) {
        return err(
          modelingError('model-invalid-argument', 'path.angle is in degrees, within (0, 360]', {
            angle: spec.angle,
          }),
        );
      }
      const segments = requireSegments('path.segments', spec.segments, 1);
      if (!segments.ok) return segments;
      const center = spec.center ?? [0, 0, 0];
      const centered = requirePoint('path.center', center);
      if (!centered.ok) return centered;
      const [u, w] = planeAxes(spec.axis ?? 'y');
      const full = spec.angle === 360 && closed;
      const count = full ? spec.segments : spec.segments + 1;
      const out: Tuple3[] = [];
      for (let k = 0; k < count; k++) {
        const phi = (((spec.startAngle ?? 0) + (spec.angle * k) / spec.segments) * Math.PI) / 180;
        out.push(
          add(center, add(scale(u, spec.radius * cos(phi)), scale(w, spec.radius * sin(phi)))),
        );
      }
      return ok(out);
    }
    case 'helix': {
      if (closed) {
        return err(
          modelingError('model-invalid-argument', 'a helix path is open (closed: false)', {}),
        );
      }
      for (const name of ['radius', 'pitch', 'turns'] as const) {
        const checked = requirePositive(`path.${name}`, spec[name]);
        if (!checked.ok) return checked;
      }
      const segments = requireSegments('path.segments', spec.segments, 3);
      if (!segments.ok) return segments;
      const center = spec.center ?? [0, 0, 0];
      const centered = requirePoint('path.center', center);
      if (!centered.ok) return centered;
      const [u, w, a] = planeAxes(spec.axis ?? 'y');
      const steps = Math.max(1, Math.ceil(spec.turns * spec.segments - 1e-9));
      const sign = spec.handedness === 'left' ? -1 : 1;
      const out: Tuple3[] = [];
      for (let k = 0; k <= steps; k++) {
        const turns = (spec.turns * k) / steps;
        const phi = ((spec.startAngle ?? 0) * Math.PI) / 180 + sign * 2 * Math.PI * turns;
        const ring = add(scale(u, spec.radius * cos(phi)), scale(w, spec.radius * sin(phi)));
        out.push(add(center, add(ring, scale(a, spec.pitch * turns))));
      }
      return ok(out);
    }
  }
}

/** Sample a path into distinct points; a closed path does not repeat its first point. */
export function samplePath(
  input: PathInput,
  closed: boolean,
  tolerance: number,
): Result<Tuple3[], ModelingError> {
  const spec: PathSpec = Array.isArray(input)
    ? { kind: 'polyline', points: input as readonly Tuple3[] }
    : (input as PathSpec);
  const sampled = sampleSpec(spec, closed);
  if (!sampled.ok) return sampled;
  const points = sampled.value;
  let total = 0;
  const spans = closed ? points.length : points.length - 1;
  for (let i = 0; i < spans; i++) {
    const d = length(sub(points[(i + 1) % points.length] as Tuple3, points[i] as Tuple3));
    total += d;
    if (d <= tolerance) {
      return err(
        modelingError(
          'model-degenerate',
          'consecutive path points are farther apart than the tolerance',
          { span: i, distance: d, tolerance },
          'remove repeated path points',
        ),
      );
    }
  }
  if (total <= tolerance) {
    return err(
      modelingError('model-degenerate', 'the path has non-zero length', { length: total }),
    );
  }
  return ok(points);
}

/** A cross-section frame at one path station; `x`, `y` and the tangent are right-handed. */
export interface Frame {
  readonly point: Tuple3;
  readonly tangent: Tuple3;
  readonly x: Tuple3;
  readonly y: Tuple3;
  /** Arc length from the first station. */
  readonly s: number;
  /** Turning angle of the path at this station (radians). */
  readonly turn: number;
  /** Unit direction in the section plane along which a miter stretches the section. */
  readonly miterAxis: Tuple3;
  /** Stretch along `miterAxis` that keeps the section width across a joint (1 = none). */
  readonly miter: number;
}

export type FrameMode = 'rmf' | 'up';

function perpendicular(v: Tuple3, t: Tuple3): Tuple3 {
  return sub(v, scale(t, dot(v, t)));
}

function rotateAbout(v: Tuple3, axis: Tuple3, angle: number): Tuple3 {
  const c = cos(angle);
  const s = sin(angle);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

/**
 * Frames along sampled points. `rmf` transports the initial frame with the
 * double-reflection rotation-minimizing method and spreads the
 * closing mismatch of a closed path evenly by arc length; `up` keeps the section's
 * y axis toward `up` at every station.
 */
export function pathFrames(
  points: readonly Tuple3[],
  closed: boolean,
  mode: FrameMode,
  up: Tuple3,
): Result<Frame[], ModelingError> {
  const n = points.length;
  const at = (i: number) => points[(i + n) % n] as Tuple3;
  const tangents: Tuple3[] = [];
  const turns: number[] = [];
  const miterAxes: Tuple3[] = [];
  const miters: number[] = [];
  const s: number[] = [0];
  for (let i = 1; i < n; i++) s.push((s[i - 1] as number) + length(sub(at(i), at(i - 1))));
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    const dIn = hasPrev ? normalize(sub(at(i), at(i - 1))) : undefined;
    const dOut = hasNext ? normalize(sub(at(i + 1), at(i))) : undefined;
    if (dIn === undefined || dOut === undefined) {
      tangents.push((dIn ?? dOut) as Tuple3);
      turns.push(0);
      miterAxes.push([0, 0, 0]);
      miters.push(1);
      continue;
    }
    const sum = add(dIn, dOut);
    const half = length(sum) / 2;
    if (half <= 1e-9) {
      return err(
        modelingError('model-degenerate', 'the path does not reverse on itself', { station: i }),
      );
    }
    tangents.push(scale(sum, 1 / (2 * half)));
    turns.push(atan2(length(cross(dIn, dOut)), dot(dIn, dOut)));
    const bend = sub(dOut, dIn);
    miterAxes.push(length(bend) <= 1e-12 ? [0, 0, 0] : normalize(bend));
    miters.push(1 / half);
  }
  const ys: Tuple3[] = [];
  const t0 = tangents[0] as Tuple3;
  if (mode === 'up') {
    for (let i = 0; i < n; i++) {
      const y = perpendicular(up, tangents[i] as Tuple3);
      if (length(y) <= 1e-6 * length(up)) {
        return err(
          modelingError(
            'model-degenerate',
            "the path never runs parallel to 'up' in frame mode 'up'",
            { station: i, up },
            "use frame: 'rmf' for paths that run along the up direction",
          ),
        );
      }
      ys.push(normalize(y));
    }
  } else {
    let y0 = perpendicular(up, t0);
    for (const fallback of [
      [0, 0, 1],
      [1, 0, 0],
    ] as Tuple3[]) {
      if (length(y0) > 1e-6) break;
      y0 = perpendicular(fallback, t0);
    }
    ys.push(normalize(y0));
    const steps = closed ? n : n - 1;
    for (let i = 0; i < steps; i++) {
      const r = ys[i] as Tuple3;
      const t = tangents[i] as Tuple3;
      const nextT = tangents[(i + 1) % n] as Tuple3;
      const v1 = sub(at(i + 1), at(i));
      const c1 = dot(v1, v1);
      const rL = sub(r, scale(v1, (2 / c1) * dot(v1, r)));
      const tL = sub(t, scale(v1, (2 / c1) * dot(v1, t)));
      const v2 = sub(nextT, tL);
      const c2 = dot(v2, v2);
      const next = c2 <= 1e-24 ? rL : sub(rL, scale(v2, (2 / c2) * dot(v2, rL)));
      ys.push(normalize(perpendicular(next, nextT)));
    }
    if (closed) {
      const end = ys.pop() as Tuple3;
      const start = ys[0] as Tuple3;
      const total = (s[n - 1] as number) + length(sub(at(0), at(n - 1)));
      const mismatch = atan2(dot(cross(end, start), t0), dot(end, start));
      for (let i = 1; i < n; i++) {
        const angle = (mismatch * (s[i] as number)) / total;
        ys[i] = normalize(rotateAbout(ys[i] as Tuple3, tangents[i] as Tuple3, angle));
      }
    }
  }
  return ok(
    points.map((point, i) => {
      const tangent = tangents[i] as Tuple3;
      const y = ys[i] as Tuple3;
      return {
        point: [...point] as Tuple3,
        tangent,
        x: cross(y, tangent),
        y,
        s: s[i] as number,
        turn: turns[i] as number,
        miterAxis: miterAxes[i] as Tuple3,
        miter: miters[i] as number,
      };
    }),
  );
}

/** Total arc length of sampled points (including the closing span when closed). */
export function pathLength(points: readonly Tuple3[], closed: boolean): number {
  let total = 0;
  const spans = closed ? points.length : points.length - 1;
  for (let i = 0; i < spans; i++) {
    total += length(sub(points[(i + 1) % points.length] as Tuple3, points[i] as Tuple3));
  }
  return total;
}
