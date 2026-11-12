import { nurbs, type NurbsCurve, type NurbsSurface, type Point2, type Tuple3 } from '@forgeax/engine-modeling';
import type { View } from './reference.ts';
import { INTAKE } from './s2-body.ts';
import { BODY_NOSE, BODY_TAIL, bodyPatches, bodyPoint } from './s3-rough.ts';
import { type Anchor, add3, cross3, dot3, inside2, scale3, sub3, unit3 } from './s6c-kit.ts';
import { ARCH_LINES, FEATURE_TABLE, fitLine, type Span } from './feature-lines.ts';

/**
 * Case C-100 stage S6c (code name mech-gt): detail anchors hosted on the feature-line feature-line
 * network. A spec names a line and a station on it; `resolveAnchor` finds the shell point
 * under it with `onShell`, so the detail follows the line when the shell is rebuilt on it.
 * `onShell` answers on the current S6 body surface.
 */

/** Where a detail sits: on feature line `line` at station `at` (along the line's axis), moved by `offset` in the line's view. */
export interface AnchorSpec {
  readonly host: string;
  /** A FEATURE_TABLE or ARCH_LINES id. */
  readonly line: string;
  /** A named closed loop of the line (front-face and tail-band loops, with the patch layout). */
  readonly loop?: string;
  readonly at: number;
  /** View offset (meters) from the line point. */
  readonly offset?: readonly [number, number];
  /** The anchor tangent: the line's direction, or the view's horizontal axis (default). */
  readonly along?: 'line' | 'view-x';
  /** Distance (meters) off the shell along its normal. */
  readonly lift?: number;
  /** A fixed anchor normal (a level mirror stalk) in place of the shell normal. */
  readonly normal?: Tuple3;
}

export interface ShellHit {
  readonly point: Tuple3;
  readonly normal: Tuple3;
  readonly part: string;
}

type P2 = readonly [number, number];

/** The view's horizontal and vertical axes in the car frame, for the left side (+x). */
function viewAxes(view: View): readonly [Tuple3, Tuple3] {
  switch (view) {
    case 'right':
      return [[0, 0, 1], [0, 1, 0]];
    case 'top':
      return [[1, 0, 0], [0, 0, 1]];
    case 'front':
    case 'back':
      return [[1, 0, 0], [0, 1, 0]];
  }
}

const bisect = (f: (x: number) => number, lo: number, hi: number, n = 40): number => {
  const flo = f(lo);
  for (let k = 0; k < n; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) * flo > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

/** Section parameter at station z whose height is y (height grows with t over the half section). */
function tAtHeight(z: number, y: number): number | undefined {
  const [y0, y1] = [bodyPoint(z, 0, 1)[1], bodyPoint(z, 1, 1)[1]];
  if (y < y0 || y > y1) return undefined;
  return bisect((t) => bodyPoint(z, t, 1)[1] - y, 0, 1);
}

/** Inside the half section at z: below the roof and within its half-width at height y. */
function inSection(z: number, x: number, y: number): boolean {
  const t = tAtHeight(z, y);
  return t !== undefined && x <= Math.abs(bodyPoint(z, t, 1)[0]);
}

let panels: { readonly part: string; readonly surface: NurbsSurface; readonly side: number }[] | undefined;

/** The body part whose panel on the side of p is nearest to it. */
function partAt(p: Tuple3): string {
  panels ??= Object.entries(bodyPatches()).flatMap(([part, list]) =>
    list.map((s) => {
      const xs = s.surface.points.flat().map((q) => q[0]);
      return { part, surface: s.surface, side: Math.sign(xs.reduce((a, x) => a + x, 0)) };
    }),
  );
  const side = Math.sign(p[0]) || 1;
  let best = { part: '', d: Infinity };
  for (const s of panels) {
    if (s.side !== side) continue;
    const d = nurbs.closest(s.surface, p, 8).distance;
    if (d < best.d) best = { part: s.part, d };
  }
  return best.part;
}

/** Outward unit normal of the body surface at (z, t). */
function normalAt(z: number, t: number, sign: 1 | -1): Tuple3 {
  const e = 1e-4;
  const dz = sub3(bodyPoint(z + e, t, sign), bodyPoint(z - e, t, sign));
  const dt = sub3(bodyPoint(z, Math.min(1, t + e), sign), bodyPoint(z, Math.max(0, t - e), sign));
  const n = unit3(cross3(dz, dt));
  const p = bodyPoint(z, t, sign);
  const out: Tuple3 = [p[0], p[1] - bodyPoint(z, 1, sign)[1] / 2, 0];
  return dot3(n, out) >= 0 ? n : scale3(n, -1);
}

/** An opening of the side view: the wheel arches and the side intake. */
function inOpening(z: number, y: number): boolean {
  if (ARCH_LINES.some((a) => Math.hypot(z - a.center[0], y - a.center[1]) < a.radius)) return true;
  return inside2([z, y], INTAKE.map((q): Point2 => [q[0], q[1]]));
}

/**
 * The first skin point seen from outside in `view` at view point p2 on `side`: its outward
 * normal and the part it belongs to; undefined where the view sees through (an opening) or
 * past the car. View coordinates: right (z, y), top (|x|, z), front and back (|x|, y).
 */
export function onShell(view: View, p2: P2, side: 'l' | 'r'): ShellHit | undefined {
  const sign = side === 'l' ? 1 : -1;
  const hit = (z: number, t: number): ShellHit => {
    const point = bodyPoint(z, t, sign);
    return { point, normal: normalAt(z, t, sign), part: partAt(point) };
  };
  switch (view) {
    case 'right': {
      const [z, y] = p2;
      if (z < BODY_TAIL || z > BODY_NOSE || inOpening(z, y)) return undefined;
      const t = tAtHeight(z, y);
      return t === undefined ? undefined : hit(z, t);
    }
    case 'top': {
      const [x, z] = [Math.abs(p2[0]), p2[1]];
      if (z < BODY_TAIL || z > BODY_NOSE) return undefined;
      // The upper surface: from the widest section point to the centerline.
      let wide = 0;
      for (let k = 1; k <= 100; k++) if (Math.abs(bodyPoint(z, k / 100, 1)[0]) > Math.abs(bodyPoint(z, wide, 1)[0])) wide = k / 100;
      if (x > Math.abs(bodyPoint(z, wide, 1)[0])) return undefined;
      return hit(z, bisect((t) => Math.abs(bodyPoint(z, t, 1)[0]) - x, wide, 1));
    }
    case 'front':
    case 'back': {
      const [x, y] = [Math.abs(p2[0]), p2[1]];
      const [end, inward] = view === 'front' ? [BODY_NOSE, -1] : [BODY_TAIL, 1];
      // Inside the end section the fascia closes the body: the one nose cap, or the tail piece nearest to it.
      if (inSection(end, x, y)) {
        const point: Tuple3 = [sign * x, y, end];
        return { point, normal: [0, 0, -inward], part: view === 'front' ? 'bumper-center' : partAt(point) };
      }
      const step = 0.005;
      for (let z = end + inward * step; (z - BODY_TAIL) * (BODY_NOSE - z) >= 0; z += inward * step) {
        if (!inSection(z, x, y)) continue;
        const zs = bisect((q) => (inSection(q, x, y) ? 1 : -1), z, z - inward * step);
        const t = tAtHeight(zs, y) as number;
        return hit(zs, t);
      }
      return undefined;
    }
  }
}

const network = new Map<string, readonly Span[]>();
const spansOf = (id: string): readonly Span[] => {
  let s = network.get(id);
  if (s === undefined) {
    const line = FEATURE_TABLE.find((l) => l.id === id);
    if (line === undefined) throw new Error(`unknown feature line ${id}`);
    s = fitLine(line);
    network.set(id, s);
  }
  return s;
};

const viewOf = (id: string): View => (ARCH_LINES.some((a) => a.id === id) ? 'right' : (FEATURE_TABLE.find((l) => l.id === id) as { view: View }).view);

/**
 * The point of a line at station `at` along its axis, and its view tangent; of several
 * crossings, the highest (largest other coordinate), as `featureY` reads a side line.
 */
export function linePoint(id: string, at: number): { readonly p: P2; readonly tangent: P2 } | undefined {
  const arch = ARCH_LINES.find((a) => a.id === id);
  if (arch !== undefined) {
    const dz = at - arch.center[0];
    if (Math.abs(dz) > arch.radius) return undefined;
    const h = Math.sqrt(arch.radius * arch.radius - dz * dz);
    return { p: [at, arch.center[1] + h], tangent: unit2([h, -dz]) };
  }
  const axis = FEATURE_TABLE.find((l) => l.id === id)?.axis ?? 0;
  const other = 1 - axis;
  let best: { p: P2; tangent: P2 } | undefined;
  for (const span of spansOf(id)) {
    const c = span.curve;
    const [u0, u1] = nurbs.domain(c);
    const f = (u: number) => (nurbs.point(c, u)[axis] as number) - at;
    const n = 64;
    for (let k = 0; k < n; k++) {
      const [a, b] = [u0 + ((u1 - u0) * k) / n, u0 + ((u1 - u0) * (k + 1)) / n];
      if (f(a) * f(b) > 0) continue;
      const u = bisect(f, a, b);
      const q = nurbs.point(c, u);
      const p: P2 = [q[0], q[1]];
      if (best === undefined || (p[other] as number) > (best.p[other] as number)) best = { p, tangent: tangentOf(c, u) };
    }
  }
  return best;
}

const unit2 = (v: P2): P2 => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

function tangentOf(c: NurbsCurve, u: number): P2 {
  const d = nurbs.derivatives(c, u, 1)[1] as Tuple3;
  return unit2([d[0], d[1]]);
}

/** The anchor of a spec on the left side: the shell point under the line point, its normal, and the tangent. */
export function resolveAnchor(spec: AnchorSpec): Anchor | undefined {
  const at = linePoint(spec.line, spec.at);
  if (at === undefined) return undefined;
  const view = viewOf(spec.line);
  const [du, dv] = spec.offset ?? [0, 0];
  const shell = onShell(view, [at.p[0] + du, at.p[1] + dv], 'l');
  if (shell === undefined) return undefined;
  const [h, v] = viewAxes(view);
  const tangent = spec.along === 'line' ? unit3(add3(scale3(h, at.tangent[0]), scale3(v, at.tangent[1]))) : h;
  return {
    part: spec.host,
    origin: add3(shell.point, scale3(shell.normal, spec.lift ?? 0)),
    normal: spec.normal ?? shell.normal,
    tangent,
  };
}
