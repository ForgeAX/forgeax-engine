import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import { atan2, cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  approximate,
  checkSurface,
  fitKnots,
  type NurbsCurve,
  type NurbsSurface,
  normalCurvature,
  surfaceClosest,
  surfaceCurvature,
  surfaceDerivatives,
  surfaceDomain,
  transpose,
} from './nurbs';
import { type PatchSide, surfaceReverse, surfaceSplit } from './nurbs-surface';
import type { OpDiagnostic } from './ops';
import type { Point2 } from './primitives';
import type { SurfacePatch } from './surface';
import { type FillBoundary, fillN } from './surface-fill';
import { curveFairness, isoparm } from './surface-quality';

/**
 * Surface fillet and blend: a rolling-ball blend between two
 * patches that meet at a crease along a shared side. The ball of the given radius
 * touches both patches in each station plane across the edge; the blend's sections
 * leave each patch tangent (G1, a cubic close to the circular arc) or also matching its
 * cross curvature (G2, a quintic). Both patches stay exactly as given: each gets a trim
 * region in its own domain up to its contact curve, and `m.surface` welds the blend's
 * contact sides to those trim edges.
 */
export interface BlendOptions {
  /**
   * Ball radius in meters: constant, or `[t, radius]` stations along the edge (t from 0
   * to 1 along `a`'s side, linear between them). Leading and trailing stations may be 0:
   * the blend then covers only the range between the last leading and the first trailing
   * zero, and runs out at a zero end (that segment eases with a C2 cubic step, so the contact
   * curves leave the crease with G2). A zero between positive stations is rejected. The
   * run-out knots raise the nets (`surface-density`), and a run-out shorter than 0.4 x the
   * side length reports `surface-fairness` on the isoparm beside it (rate ratio about
   * 6 L / l); the geometry is unaffected.
   */
  readonly radius: number | readonly (readonly [number, number])[];
  /** G1 (default) or G2 at both contact curves. */
  readonly continuity?: 'G1' | 'G2';
  /** The shared sides; default found by matching side end and middle points. */
  readonly sides?: readonly [PatchSide, PatchSide];
  /** Stations across the blended range (default 17, 4 to 129); the rest of the side gets the same spacing. */
  readonly stations?: number;
  /**
   * Control points of the blend along the blended range; the rest of the side gets the same
   * density. Default adaptive: 8, 12, 16 ... (stations raised to 2 x controlPoints + 1, at most
   * 129) until `gap` is at most `tolerance / 2`, keeping the last fit whose isoparms along the
   * edge stay fair (no spike, curvature rate within 15 times) where more would ripple, if that
   * fit lies within 10 x `tolerance`.
   */
  readonly controlPoints?: number;
  /** Distance within which the two sides coincide (default 1e-5 m); half of it bounds the adaptive `gap`. */
  readonly tolerance?: number;
}

export interface BlendResult {
  /**
   * Region of `a` the blend replaces, in `a`'s normalized domain: the strip from its contact
   * curve to the shared side, closed 1e-3 outside the domain (a `{ uv }` trim outline,
   * counter-clockwise). A run-out end closes at the side in a cusp.
   */
  readonly trimA: readonly Point2[];
  readonly trimB: readonly Point2[];
  /**
   * u along the edge over the blended range (`[t0, t1]` of `a`'s side), v from the contact
   * curve on `a` (v = 0) to the one on `b`; a run-out end collapses to one point.
   */
  readonly blend: NurbsSurface;
  /** Distance of the contact curves from the edge (min, max over the stations; 0 with a run-out). */
  readonly setback: readonly [number, number];
  /** Largest distance of the blend's contact sides from the trim edges on `a` and `b` (257 samples each). */
  readonly gap: number;
  readonly sides: readonly [PatchSide, PatchSide];
}

const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Tuple3, s: number): Tuple3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Tuple3) => Math.sqrt(dot(a, a));
const unit = (a: Tuple3): Tuple3 => {
  const l = norm(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};
const angle = (a: Tuple3, b: Tuple3) => atan2(norm(cross(a, b)), dot(a, b));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function invalid(expected: string, detail: Record<string, unknown>): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

/** Reorient so `side` becomes v = v-min. */
function canonical(s: NurbsSurface, side: PatchSide): NurbsSurface {
  switch (side) {
    case 'v0':
      return s;
    case 'v1':
      return surfaceReverse(s, 'v');
    case 'u0':
      return transpose(s);
    case 'u1':
      return surfaceReverse(transpose(s), 'v');
  }
}

function point(s: NurbsSurface, u: number, v: number): Tuple3 {
  return (surfaceDerivatives(s, u, v, 0)[0] as Tuple3[])[0] as Tuple3;
}

function sidePoint(s: NurbsSurface, side: PatchSide, f: number): Tuple3 {
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  switch (side) {
    case 'u0':
      return point(s, u0, lerp(v0, v1, f));
    case 'u1':
      return point(s, u1, lerp(v0, v1, f));
    case 'v0':
      return point(s, lerp(u0, u1, f), v0);
    case 'v1':
      return point(s, lerp(u0, u1, f), v1);
  }
}

const SIDES: readonly PatchSide[] = ['u0', 'u1', 'v0', 'v1'];

/** Side pairs whose ends and middles coincide (either direction). */
function sharedSides(
  a: NurbsSurface,
  b: NurbsSurface,
  tolerance: number,
): [PatchSide, PatchSide][] {
  const out: [PatchSide, PatchSide][] = [];
  for (const sa of SIDES)
    for (const sb of SIDES) {
      const fs = [0, 0.25, 0.5, 0.75, 1];
      const same = fs.every(
        (f) => norm(sub(sidePoint(a, sa, f), sidePoint(b, sb, f))) <= tolerance,
      );
      const reversed = fs.every(
        (f) => norm(sub(sidePoint(a, sa, f), sidePoint(b, sb, 1 - f))) <= tolerance,
      );
      if (same || reversed) out.push([sa, sb]);
    }
  return out;
}

interface Frame {
  readonly p: Tuple3;
  readonly su: Tuple3;
  readonly sv: Tuple3;
  readonly n: Tuple3;
}

function frame(s: NurbsSurface, u: number, v: number): Frame {
  const d = surfaceDerivatives(s, u, v, 1);
  const su = (d[1] as Tuple3[])[0] as Tuple3;
  const sv = (d[0] as Tuple3[])[1] as Tuple3;
  return { p: (d[0] as Tuple3[])[0] as Tuple3, su, sv, n: unit(cross(su, sv)) };
}

/** Component of `w` across the edge tangent `t`, normalized. */
function across(w: Tuple3, t: Tuple3): Tuple3 {
  return unit(sub(w, scale(t, dot(w, t))));
}

type Stations = readonly (readonly [number, number])[];

/**
 * C2 cubic step from 0 to 1 over three equal spans (the sum of uniform cubic B-spline basis
 * functions): value, slope and curvature vanish at both ends, and with knots at the thirds
 * a cubic fit holds it exactly, so a run-out tip does not overshoot the crease.
 */
function step(s: number): number {
  const x = 3 * s;
  if (x <= 1) return (x * x * x) / 6;
  if (x <= 2) return (x * (x * (9 - 2 * x) - 9) + 3) / 6;
  const y = 3 - x;
  return 1 - (y * y * y) / 6;
}

function radiusAt(radius: BlendOptions['radius'], t: number): number {
  if (typeof radius === 'number') return radius;
  const first = radius[0] as readonly [number, number];
  if (t <= first[0]) return first[1];
  for (let k = 1; k < radius.length; k++) {
    const [t1, r1] = radius[k] as readonly [number, number];
    const [t0, r0] = radius[k - 1] as readonly [number, number];
    if (t > t1) continue;
    if (!(t1 > t0)) return r1;
    const s = (t - t0) / (t1 - t0);
    // A run-out (one end zero) eases so the contact curves meet the crease with G2.
    return lerp(r0, r1, (r0 === 0) !== (r1 === 0) ? step(s) : s);
  }
  return (radius[radius.length - 1] as readonly [number, number])[1];
}

/**
 * The blended range of valid radius stations: from the last leading zero station to the
 * first trailing one (whole side without them); undefined when a zero lies between positive
 * stations, no station is positive, or a run-out has no length.
 */
function blendedRange(radius: BlendOptions['radius']): readonly [number, number] | undefined {
  if (typeof radius === 'number') return [0, 1];
  const stations = radius as Stations;
  const positive = stations.flatMap(([, r], k) => (r > 0 ? [k] : []));
  const f = positive[0];
  const l = positive[positive.length - 1];
  if (f === undefined || l === undefined || positive.length !== l - f + 1) return undefined;
  const at = (k: number) => (stations[k] as readonly [number, number])[0];
  if (f > 0 && !(at(f - 1) < at(f))) return undefined;
  if (l < stations.length - 1 && !(at(l + 1) > at(l))) return undefined;
  return [f > 0 ? at(f - 1) : 0, l < stations.length - 1 ? at(l + 1) : 1];
}

/** Station parameters and the fit along the edge they feed. */
interface Plan {
  readonly params: readonly number[];
  readonly count: number;
  /** Clamped cubic knots placed at the run-out eighteenths; absent without a run-out (knots by averaging). */
  readonly knots?: readonly number[];
}

/**
 * Without zero stations: `stations` and `controlPoints` across the side, as always. With
 * them: the side splits at the blended range and the run-out segments; stations and knots
 * keep the blended range's spacing everywhere, and each run-out gets knots at its
 * eighteenths (its step is cubic between thirds, so the fit holds it; between curved
 * patches the sections also carry their cross curvature, which six spans lose near the tip)
 * plus halved spans toward its zero end, where the band narrows fastest, with two stations
 * per span at least.
 */
function plan(
  radius: BlendOptions['radius'],
  range: readonly [number, number],
  stations: number,
  controlPoints: number,
): Plan {
  const zeros = typeof radius === 'number' ? [] : radius.filter(([, r]) => r === 0);
  if (zeros.length === 0)
    return {
      params: Array.from({ length: stations }, (_, k) => k / (stations - 1)),
      count: controlPoints,
    };
  const stationList = radius as Stations;
  const [t0, t1] = range;
  const runs: (readonly [number, number, number])[] = [];
  for (let k = 1; k < stationList.length; k++) {
    const [ta, ra] = stationList[k - 1] as readonly [number, number];
    const [tb, rb] = stationList[k] as readonly [number, number];
    if ((ra === 0) !== (rb === 0) && ta >= t0 && tb <= t1) runs.push([ta, tb, ra === 0 ? ta : tb]);
  }
  const ends = [...runs.map((run) => run[0]), ...runs.map((run) => run[1])];
  const breaks = [...new Set([0, t0, ...ends, t1, 1])].sort((x, y) => x - y);
  const h = (t1 - t0) / (stations - 1);
  const spacing = (t1 - t0) / (controlPoints - 3);
  const params: number[] = [0];
  const inner: number[] = [];
  for (let k = 1; k < breaks.length; k++) {
    const x = breaks[k - 1] as number;
    const y = breaks[k] as number;
    const run = runs.find(([a, b]) => a === x && b === y);
    const n = Math.max(run ? 36 : 1, Math.round((y - x) / h));
    const local: number[] = [];
    for (let j = 1; j <= n; j++) local.push(j === n ? y : lerp(x, y, j / n));
    const m = run ? 18 : Math.max(1, Math.ceil((y - x) / spacing - 1e-9));
    for (let j = 1; j < m; j++) inner.push(lerp(x, y, j / m));
    if (run !== undefined) {
      // Toward the zero end the band narrows faster than the fit error: halve the last
      // spans (knots at 1/12, 1/24, 1/48 of the run-out) with dense stations there.
      const [, , zero] = run;
      const toward = zero === x ? 1 : -1;
      for (const g of [12, 24, 48]) inner.push(zero + (toward * (y - x)) / g);
      for (let j = 1; j < 32; j++) local.push(zero + (toward * (y - x) * j) / 192);
    }
    pushAll(
      params,
      [...new Set(local)].sort((p, q) => p - q),
    );
    if (y < 1) inner.push(y);
  }
  inner.sort((x, y) => x - y);
  return { params, count: inner.length + 4, knots: [0, 0, 0, 0, ...inner, 1, 1, 1, 1] };
}

/** How far a trim outline reaches past the domain's sides (normalized), so the side lies strictly inside it. */
const TRIM_OVERSHOOT = 1e-3;
/** How far (normalized) a contact may extrapolate past an end of its patch's side, inside the trim overshoot. */
const CONTACT_OVERSHOOT = TRIM_OVERSHOOT / 2;

interface Contact {
  readonly ua: number;
  readonly va: number;
  readonly ub: number;
  readonly vb: number;
  /** b's parameter of the edge point at this station. */
  readonly edge: number;
  readonly sa: number;
  readonly sb: number;
  readonly tangent: Tuple3;
  readonly setback: number;
}

/** Solve the rolling-ball contacts at one station by damped Newton (finite differences). */
function solveContact(
  A: NurbsSurface,
  B: NurbsSurface,
  ua0: number,
  r: number,
  station: number,
): Result<Contact, ModelingError> {
  const [[a0, a1], [av0, av1]] = surfaceDomain(A);
  const [[b0, b1], [bv0, bv1]] = surfaceDomain(B);
  const fa = frame(A, ua0, av0);
  const E = fa.p;
  const T = unit(fa.su);
  // B's parameter on the shared side at E.
  let ubStart = b0;
  let best = Infinity;
  for (let k = 0; k <= 64; k++) {
    const u = lerp(b0, b1, k / 64);
    const d = norm(sub(point(B, u, bv0), E));
    if (d < best) {
      best = d;
      ubStart = u;
    }
  }
  for (let it = 0; it < 30; it++) {
    const f = frame(B, ubStart, bv0);
    const d2 = surfaceDerivatives(B, ubStart, bv0, 2);
    const suu = (d2[2] as Tuple3[])[0] as Tuple3;
    const r0 = sub(f.p, E);
    const g = dot(f.su, r0);
    const h = dot(f.su, f.su) + dot(suu, r0);
    if (!(h > 0)) break;
    const next = Math.min(b1, Math.max(b0, ubStart - g / h));
    if (Math.abs(next - ubStart) < 1e-15) break;
    ubStart = next;
  }
  const fb = frame(B, ubStart, bv0);
  // Outside the blended range and at a run-out end the contacts are the edge itself.
  if (r === 0)
    return ok({
      ua: ua0,
      va: av0,
      ub: ubStart,
      vb: bv0,
      edge: ubStart,
      sa: 1,
      sb: 1,
      tangent: T,
      setback: 0,
    });
  const dA = across(fa.sv, T);
  const dB = across(fb.sv, T);
  const opening = angle(dA, dB);
  if (!(opening < (179 * Math.PI) / 180))
    return err(
      modelingError(
        'model-precondition',
        'the patches meet at a crease (a fillet needs a kink across the shared side)',
        { station, angle: (opening * 180) / Math.PI },
        'blend only designed breaks: tangent joints need no fillet',
      ),
    );
  const half = opening / 2;
  const setback = (r * cos(half)) / sin(half);
  const bisector = unit(add(dA, dB));
  const sa = dot(fa.n, bisector) >= 0 ? 1 : -1;
  const sb = dot(fb.n, bisector) >= 0 ? 1 : -1;
  const x0 = [
    ua0,
    av0 + setback / Math.max(norm(fa.sv), 1e-300),
    ubStart,
    bv0 + setback / Math.max(norm(fb.sv), 1e-300),
  ];
  // The contact on `a` stays on its isoparm through the station, inside its domain at
  // the end stations too (a plane across a curved edge would leave it there). Where the
  // crease slants across an end, `b`'s contact would fall past that end instead: it is
  // held there, and `a`'s contact moves inside along its side.
  const pinA = (y: number[]) => ((y[0] as number) - ua0) * norm(fa.su);
  const residualOf =
    (pin: (y: number[]) => number) =>
    (y: number[]): number[] => {
      const pa = frame(A, y[0] as number, y[1] as number);
      const pb = frame(B, y[2] as number, y[3] as number);
      const ca = add(pa.p, scale(pa.n, r * sa));
      const cb = add(pb.p, scale(pb.n, r * sb));
      const d = sub(ca, cb);
      return [d[0], d[1], d[2], pin(y)];
    };
  const spans = [a1 - a0, av1 - av0, b1 - b0, bv1 - bv0];
  // Along the edge a contact may extrapolate a little past an end: where two blends meet at a
  // smooth patch seam, both then solve the same ball there (the patch polynomials agree past
  // a G1/G2 seam to second order), not one ball on each side of it.
  const past = CONTACT_OVERSHOOT * (a1 - a0);
  const pastB = CONTACT_OVERSHOOT * (b1 - b0);
  const clamp = (y: number[]) => [
    Math.min(a1 + past, Math.max(a0 - past, y[0] as number)),
    Math.min(av1, Math.max(av0, y[1] as number)),
    Math.min(b1 + pastB, Math.max(b0 - pastB, y[2] as number)),
    Math.min(bv1, Math.max(bv0, y[3] as number)),
  ];
  const size = (v: number[]) => Math.sqrt(v.reduce((s, c) => s + c * c, 0));
  const newton = (start: number[], residual: (y: number[]) => number[]) => {
    let x = start;
    let fx = residual(x);
    for (let it = 0; it < 40 && size(fx) > 1e-12 * (1 + r); it++) {
      const J: number[][] = [[], [], [], []];
      for (let k = 0; k < 4; k++) {
        const h = 1e-7 * (spans[k] as number);
        const y = [...x];
        y[k] = (y[k] as number) + h;
        const fy = residual(y);
        for (let i = 0; i < 4; i++)
          (J[i] as number[])[k] = ((fy[i] as number) - (fx[i] as number)) / h;
      }
      const step = solve4(J, fx);
      if (step === undefined) break;
      let damping = 1;
      let next = clamp(x.map((v, k) => v - damping * (step[k] as number)));
      let fn = residual(next);
      while (size(fn) > size(fx) && damping > 1 / 64) {
        damping /= 2;
        next = clamp(x.map((v, k) => v - damping * (step[k] as number)));
        fn = residual(next);
      }
      x = next;
      fx = fn;
    }
    return { x, fx };
  };
  let { x, fx } = newton(x0, residualOf(pinA));
  const end = x[2] === b0 - pastB ? b0 : x[2] === b1 + pastB ? b1 : undefined;
  if (!(size(fx) <= 1e-9 * (1 + r)) && end !== undefined) {
    const held = newton(
      x,
      residualOf((y) => ((y[2] as number) - end) * norm(fb.su)),
    );
    if (size(held.fx) < size(fx)) ({ x, fx } = held);
  }
  if (!(size(fx) <= 1e-9 * (1 + r)) || x[1] === av1 || x[3] === bv1)
    return err(
      modelingError(
        'model-precondition',
        'the rolling ball touches both patches inside them',
        { station, radius: r, residual: size(fx) },
        'use a smaller radius or wider patches',
      ),
    );
  return ok({
    ua: x[0] as number,
    va: x[1] as number,
    ub: x[2] as number,
    vb: x[3] as number,
    edge: ubStart,
    sa,
    sb,
    tangent: T,
    setback: norm(sub(point(A, x[0] as number, x[1] as number), E)),
  });
}

function solve4(J: number[][], f: number[]): number[] | undefined {
  const m = J.map((row, i) => [...row, f[i] as number]);
  for (let c = 0; c < 4; c++) {
    let pivot = c;
    for (let r = c + 1; r < 4; r++)
      if (Math.abs((m[r] as number[])[c] as number) > Math.abs((m[pivot] as number[])[c] as number))
        pivot = r;
    if (!(Math.abs((m[pivot] as number[])[c] as number) > 1e-300)) return undefined;
    [m[c], m[pivot]] = [m[pivot] as number[], m[c] as number[]];
    const row = m[c] as number[];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const other = m[r] as number[];
      const factor = (other[c] as number) / (row[c] as number);
      for (let k = c; k <= 4; k++) other[k] = (other[k] as number) - factor * (row[k] as number);
    }
  }
  return m.map((row, i) => (row[4] as number) / (row[i] as number));
}

/**
 * Stations held at one contact pair (a slanted end: `b`'s contact held at its end) carry the
 * same section over a stretch of the edge; fit as they are, the blend would stop dead there
 * and overshoot. Their sections sweep from the held one to the next station that moves.
 */
function held(sections: Tuple3[][], params: readonly number[]): Tuple3[][] {
  const same = (x: readonly Tuple3[], y: readonly Tuple3[]) =>
    norm(sub(x[0] as Tuple3, y[0] as Tuple3)) <= 1e-12 &&
    norm(sub(x[x.length - 1] as Tuple3, y[y.length - 1] as Tuple3)) <= 1e-12;
  const out = sections.map((s) => [...s]);
  const n = out.length;
  for (let a = 0; a < n; ) {
    let b = a;
    while (b + 1 < n && same(sections[b + 1] as Tuple3[], sections[a] as Tuple3[])) b++;
    const [from, to] = b < n - 1 ? [a, b + 1] : [a - 1, b];
    if (b > a && from >= 0) {
      const t0 = params[from] as number;
      const t1 = params[to] as number;
      for (let k = from + 1; k < to; k++) {
        const w = ((params[k] as number) - t0) / (t1 - t0);
        out[k] = (sections[from] as Tuple3[]).map((p, j) =>
          add(scale(p, 1 - w), scale((sections[to] as Tuple3[])[j] as Tuple3, w)),
        );
      }
    }
    a = b + 1;
  }
  return out;
}

/** Bezier section control points from the contact on `a` to the contact on `b`. */
function section(
  A: NurbsSurface,
  B: NurbsSurface,
  c: Contact,
  r: number,
  continuity: 'G1' | 'G2',
): Tuple3[] {
  const fa = frame(A, c.ua, c.va);
  const fb = frame(B, c.ub, c.vb);
  // Leave each contact toward the edge, inside the station plane.
  const ta = scale(across(fa.sv, c.tangent), -1);
  const tb = scale(across(fb.sv, c.tangent), -1);
  const turn = angle(ta, scale(tb, -1));
  if (continuity === 'G1') {
    const h = ((4 / 3) * r * sin(turn / 4)) / cos(turn / 4);
    return [fa.p, add(fa.p, scale(ta, h)), add(fb.p, scale(tb, h)), fb.p];
  }
  const h = 0.25 * norm(sub(fb.p, fa.p));
  const bend = (s: NurbsSurface, u: number, v: number, t: Tuple3): Tuple3 => {
    const k = surfaceCurvature(s, u, v);
    if (k === undefined) return [0, 0, 0];
    // Quintic end curvature (4/5) |d1 x d2| / |d1|^3 matches the surface's cross curvature.
    return scale(k.normal, (5 / 4) * normalCurvature(k, t) * h * h);
  };
  const p1 = add(fa.p, scale(ta, h));
  const p4 = add(fb.p, scale(tb, h));
  return [
    fa.p,
    p1,
    add(add(p1, scale(ta, h)), bend(A, c.ua, c.va, ta)),
    add(add(p4, scale(tb, h)), bend(B, c.ub, c.vb, tb)),
    p4,
    fb.p,
  ];
}

function bezierKnots(degree: number): number[] {
  return [...new Array<number>(degree + 1).fill(0), ...new Array<number>(degree + 1).fill(1)];
}

/** Rows of points (one per station) fit with shared parameters into compatible curves. */
function fitRows(
  rows: readonly (readonly Tuple3[])[],
  fit: Plan,
): Result<NurbsCurve[], ModelingError> {
  const out: NurbsCurve[] = [];
  for (const row of rows) {
    const curve =
      fit.knots === undefined
        ? approximate(row, { controlPoints: fit.count, degree: 3, parameters: fit.params })
        : fitKnots(row, fit.params, 3, fit.knots);
    if (!curve.ok) return curve;
    out.push(curve.value);
  }
  return ok(out);
}

/** Normal of a surface at the middle of its domain. */
function midNormal(s: NurbsSurface, at?: Tuple3): { n: Tuple3; p: Tuple3 } {
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  if (at !== undefined) {
    const hit = surfaceClosest(s, at, 12);
    return { n: frame(s, hit.u, hit.v).n, p: hit.point };
  }
  const f = frame(s, (u0 + u1) / 2, (v0 + v1) / 2);
  return { n: f.n, p: f.p };
}

/** Flip `s` (reverse u) when its normal near `at` opposes `reference`'s there. */
function orientLike(s: NurbsSurface, reference: NurbsSurface): NurbsSurface {
  const here = midNormal(s);
  const there = midNormal(reference, here.p);
  return dot(here.n, there.n) < 0 ? surfaceReverse(s, 'u') : s;
}

/**
 * The blend over its range of the whole-side fit (an exact split, so its contact sides are
 * sub-curves of the trimmed patches' sides), each run-out end collapsed to one point.
 */
function blendedPart(
  full: NurbsSurface,
  [t0, t1]: readonly [number, number],
  r0: number,
  r1: number,
): Result<NurbsSurface, ModelingError> {
  let s = full;
  if (t0 > 0) {
    const split = surfaceSplit(s, 'u', t0);
    if (!split.ok) return split;
    s = split.value[1];
  }
  if (t1 < 1) {
    const split = surfaceSplit(s, 'u', t1);
    if (!split.ok) return split;
    s = split.value[0];
  }
  const collapse = (column: readonly Tuple3[]): Tuple3[] => {
    const mean = scale(column.reduce(add, [0, 0, 0] as Tuple3), 1 / column.length);
    return column.map(() => mean);
  };
  const points = s.points.map((column, i) =>
    (i === 0 && r0 === 0) || (i === s.points.length - 1 && r1 === 0) ? collapse(column) : column,
  );
  return ok({ ...s, points });
}

/** Fillet the crease where `a` and `b` share a side (see the module comment). */
export function blendSurfaces(
  a: NurbsSurface,
  b: NurbsSurface,
  options: BlendOptions,
): Result<BlendResult, ModelingError> {
  for (const s of [a, b]) {
    const checked = checkSurface(s);
    if (!checked.ok) return checked;
  }
  const continuity = options.continuity ?? 'G1';
  const stations = options.stations ?? 17;
  const controlPoints = options.controlPoints ?? 8;
  const tolerance = options.tolerance ?? 1e-5;
  if (continuity !== 'G1' && continuity !== 'G2')
    return err(invalid('continuity is G1 or G2', { continuity }));
  if (!(Number.isInteger(stations) && stations >= 4 && stations <= 129))
    return err(invalid('stations is an integer from 4 to 129', { stations }));
  if (
    options.controlPoints !== undefined &&
    !(Number.isInteger(controlPoints) && controlPoints >= 4 && controlPoints <= stations)
  )
    return err(invalid('controlPoints is an integer from 4 to stations', { controlPoints }));
  if (!(Number.isFinite(tolerance) && tolerance > 0))
    return err(invalid('tolerance is positive', { tolerance }));
  const radius = options.radius;
  const radii =
    typeof radius === 'number' ? [radius] : Array.isArray(radius) ? radius.map((s) => s?.[1]) : [];
  if (
    radii.length === 0 ||
    !radii.every((r) => typeof r === 'number' && Number.isFinite(r) && r >= 0) ||
    (typeof radius === 'number' && !(radius > 0)) ||
    (typeof radius !== 'number' &&
      !radius.every(
        (s, k) =>
          Number.isFinite(s[0]) &&
          s[0] >= 0 &&
          s[0] <= 1 &&
          (k === 0 || s[0] >= (radius[k - 1] as readonly [number, number])[0]),
      ))
  )
    return err(
      invalid('radius is positive, or [t, radius] stations with t rising in [0, 1]', {
        radius: radius as unknown,
      }),
    );
  const range = blendedRange(radius);
  if (range === undefined)
    return err(
      invalid(
        'radius stations are zero only before and after one positive run, each zero a distance from it (a run-out)',
        { radius: radius as unknown },
      ),
    );
  let sides = options.sides;
  if (sides === undefined) {
    const found = sharedSides(a, b, tolerance);
    if (found.length !== 1)
      return err(
        modelingError(
          'model-precondition',
          'the patches share exactly one whole side',
          { shared: found },
          'build both patches from one curve network so they share the side, or pass sides',
        ),
      );
    sides = found[0] as [PatchSide, PatchSide];
  } else if (!sharedSides(a, b, tolerance).some(([x, y]) => x === sides?.[0] && y === sides?.[1]))
    return err(modelingError('model-precondition', 'the given sides coincide', { sides }));
  const A = canonical(a, sides[0]);
  let B = canonical(b, sides[1]);
  const [[a0]] = surfaceDomain(A);
  const [[b0, b1], [bv0]] = surfaceDomain(B);
  const startA = point(A, a0, surfaceDomain(A)[1][0]);
  const reversedB = norm(sub(point(B, b0, bv0), startA)) > norm(sub(point(B, b1, bv0), startA));
  if (reversedB) B = surfaceReverse(B, 'u');
  // The trim outlines follow the exact contacts; only the blend is fit, until its contact
  // sides lie within the gap of them.
  const lines = trimLines(
    A,
    B,
    radius,
    range,
    plan(radius, range, stations, 8).params,
    tolerance / 5,
  );
  if (!lines.ok) return lines;
  const [onA, onB] = lines.value;
  const ends = [radiusAt(radius, range[0]) > 0, radiusAt(radius, range[1]) > 0] as const;
  const result = (blend: NurbsSurface, setbacks: readonly number[], gap: number): BlendResult => ({
    trimA: counterClockwise(closeTrim(onA, ends).map(givenPoint(sides[0], false))),
    trimB: counterClockwise(closeTrim(onB, ends).map(givenPoint(sides[1], reversedB))),
    blend: orientLike(blend, a),
    setback: [minOf(setbacks), maxOf(setbacks)],
    gap,
    sides,
  });
  const auto = options.controlPoints === undefined;
  let count = controlPoints;
  let fairFit: BlendResult | undefined;
  for (;;) {
    const n = auto ? Math.min(129, Math.max(stations, 2 * count + 1)) : stations;
    const solved = solveBlend(A, B, radius, range, n, count, continuity);
    if (!solved.ok) return solved;
    const { blend, setbacks } = solved.value;
    const gap = Math.max(seamGap(blend, 'v0', A, onA), seamGap(blend, 'v1', B, onB));
    // Where the contacts turn sharply (a slanted end), more control points chase the turn and
    // ripple the band: the last fair fit stands, and its gap is reported.
    const isFair = !auto || fair(blend);
    if (!isFair && fairFit !== undefined) return ok(fairFit);
    if (!auto || gap <= tolerance / 2 || 2 * (count + 4) + 1 > 129)
      return ok(result(blend, setbacks, gap));
    // A fair fit stands in only within ten times the tolerance of its trims.
    if (isFair && gap <= 10 * tolerance) fairFit = result(blend, setbacks, gap);
    count += 4;
  }
}

/** Whether a blend's isoparms along the edge are fair: no spike, curvature rate within 15 times. */
function fair(blend: NurbsSurface): boolean {
  for (let k = 1; k <= 5; k++) {
    const line = curveFairness({ name: 'blend', curve: isoparm(blend, 'u', k / 6) });
    if (!line.ok || line.value.spikes.length > 0 || line.value.rateRatio > 15) return false;
  }
  return true;
}

/** One blend fit: station contacts and the blend over the range (canonical, u along `A`'s side). */
function solveBlend(
  A: NurbsSurface,
  B: NurbsSurface,
  radius: BlendOptions['radius'],
  range: readonly [number, number],
  stations: number,
  controlPoints: number,
  continuity: 'G1' | 'G2',
): Result<{ readonly blend: NurbsSurface; readonly setbacks: readonly number[] }, ModelingError> {
  const [[a0, a1]] = surfaceDomain(A);
  const fit = plan(radius, range, stations, controlPoints);
  const { params, count } = fit;
  const contacts: Contact[] = [];
  for (const [k, t] of params.entries()) {
    const c = solveContact(A, B, lerp(a0, a1, t), radiusAt(radius, t), k);
    if (!c.ok) return c;
    contacts.push(c.value);
  }
  const degree = continuity === 'G1' ? 3 : 5;
  const sections = held(
    contacts.map((c, k) => section(A, B, c, radiusAt(radius, params[k] as number), continuity)),
    params,
  );
  const columns = Array.from({ length: degree + 1 }, (_, j) => sections.map((s) => s[j] as Tuple3));
  const rows = fitRows(columns, fit);
  if (!rows.ok) return rows;
  const contactA = rows.value[0] as NurbsCurve;
  const full: NurbsSurface = {
    degreeU: 3,
    degreeV: degree,
    points: Array.from({ length: count }, (_, i) =>
      rows.value.map((row) => row.points[i] as Tuple3),
    ),
    knotsU: [...contactA.knots],
    knotsV: bezierKnots(degree),
  };
  const blend = blendedPart(full, range, radiusAt(radius, range[0]), radiusAt(radius, range[1]));
  if (!blend.ok) return blend;
  return ok({ blend: blend.value, setbacks: contacts.map((c) => c.setback) });
}

/** Normalized point of a canonical patch (shared side at w = 0), clamped to its domain. */
function canonicalPoint(S: NurbsSurface, [s, w]: Point2): Tuple3 {
  const [[u0, u1], [v0, v1]] = surfaceDomain(S);
  const c = (x: number) => Math.min(1, Math.max(0, x));
  return point(S, lerp(u0, u1, c(s)), lerp(v0, v1, c(w)));
}

/**
 * The contact curves on both canonical patches over the blended range, in their normalized
 * domains: the exact rolling-ball contacts at the stations `params`, with contacts solved in
 * between until each chord's image lies within `chord` of the curve on both patches. Both
 * share their parameters, so the two seams meet the blend's columns alike.
 */
function trimLines(
  A: NurbsSurface,
  B: NurbsSurface,
  radius: BlendOptions['radius'],
  [t0, t1]: readonly [number, number],
  params: readonly number[],
  chord: number,
): Result<[Point2[], Point2[]], ModelingError> {
  const [[a0, a1], [av0, av1]] = surfaceDomain(A);
  const [[b0, b1], [bv0, bv1]] = surfaceDomain(B);
  const at = (t: number): Result<[Point2, Point2], ModelingError> => {
    const c = solveContact(A, B, lerp(a0, a1, t), radiusAt(radius, t), 0);
    if (!c.ok) return c;
    const { ua, va, ub, vb } = c.value;
    return ok([
      [(ua - a0) / (a1 - a0), (va - av0) / (av1 - av0)],
      [(ub - b0) / (b1 - b0), (vb - bv0) / (bv1 - bv0)],
    ]);
  };
  const bows = (pa: [Point2, Point2], pb: [Point2, Point2], pm: [Point2, Point2]) =>
    [A, B].some((S, i) => {
      const ends = add(canonicalPoint(S, pa[i] as Point2), canonicalPoint(S, pb[i] as Point2));
      return norm(sub(canonicalPoint(S, pm[i] as Point2), scale(ends, 0.5))) > chord;
    });
  const out: [Point2, Point2][] = [];
  const refine = (
    ta: number,
    pa: [Point2, Point2],
    tb: number,
    pb: [Point2, Point2],
    depth: number,
  ): Result<void, ModelingError> => {
    const tm = (ta + tb) / 2;
    const pm = at(tm);
    // Between two stations that fit, a ball that just fails to (an end where it eases out of
    // the crease) leaves the chord as it is.
    if (!pm.ok) return ok(undefined);
    if (depth < 10 && bows(pa, pb, pm.value)) {
      const left = refine(ta, pa, tm, pm.value, depth + 1);
      if (!left.ok) return left;
      out.push(pm.value);
      return refine(tm, pm.value, tb, pb, depth + 1);
    }
    return ok(undefined);
  };
  const ts = params.filter((t) => t >= t0 && t <= t1);
  let previous = at(ts[0] as number);
  if (!previous.ok) return previous;
  out.push(previous.value);
  for (let k = 1; k < ts.length; k++) {
    const next = at(ts[k] as number);
    if (!next.ok) return next;
    const refined = refine(ts[k - 1] as number, previous.value, ts[k] as number, next.value, 0);
    if (!refined.ok) return refined;
    out.push(next.value);
    previous = next;
  }
  // The stations crowd toward a run-out tip: keep only the points either seam needs.
  const keep = new Set<number>([0, out.length - 1]);
  const simplify = (i: number, j: number) => {
    let worst = 0;
    let at = -1;
    for (let k = i + 1; k < j; k++)
      for (const [side, S] of [A, B].entries()) {
        const p = canonicalPoint(S, (out[k] as [Point2, Point2])[side] as Point2);
        const a = canonicalPoint(S, (out[i] as [Point2, Point2])[side] as Point2);
        const b = canonicalPoint(S, (out[j] as [Point2, Point2])[side] as Point2);
        const d = segmentDistance(p, a, b);
        if (d > worst) {
          worst = d;
          at = k;
        }
      }
    if (at < 0 || worst <= chord) return;
    keep.add(at);
    simplify(i, at);
    simplify(at, j);
  };
  simplify(0, out.length - 1);
  const kept = out.filter((_, k) => keep.has(k));
  return ok([kept.map((p) => p[0]), kept.map((p) => p[1])]);
}

/**
 * Close a contact line into a trim outline: past each held end along its isoparm, then back
 * outside the shared side; a run-out end (`held` false) closes at the side in a cusp.
 */
function closeTrim(line: readonly Point2[], held: readonly [boolean, boolean]): Point2[] {
  const e = TRIM_OVERSHOOT;
  const first = line[0] as Point2;
  const last = line[line.length - 1] as Point2;
  const s0 = held[0] ? -e : first[0];
  const s1 = held[1] ? 1 + e : last[0];
  return [
    ...(held[0] ? [[s0, first[1]] as Point2] : []),
    ...line,
    ...(held[1] ? [[s1, last[1]] as Point2] : []),
    [s1, -e],
    [s0, -e],
  ];
}

/** Map normalized points of the canonical patch (`side` at w = 0, u maybe reversed) to the given patch. */
function givenPoint(side: PatchSide, reversedU: boolean): (p: Point2) => Point2 {
  return ([s0, w]) => {
    const s = reversedU ? 1 - s0 : s0;
    switch (side) {
      case 'v0':
        return [s, w];
      case 'v1':
        return [s, 1 - w];
      case 'u0':
        return [w, s];
      case 'u1':
        return [1 - w, s];
    }
  };
}

function counterClockwise(ring: Point2[]): Point2[] {
  let area = 0;
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k] as Point2;
    const q = ring[(k + 1) % ring.length] as Point2;
    area += p[0] * q[1] - q[0] * p[1];
  }
  return area < 0 ? ring.reverse() : ring;
}

/** Largest distance of a blend contact side (257 samples) from the seam polyline on the patch. */
function seamGap(
  blend: NurbsSurface,
  side: 'v0' | 'v1',
  S: NurbsSurface,
  line: readonly Point2[],
): number {
  const seam = line.map((p) => canonicalPoint(S, p));
  let worst = 0;
  for (let k = 0; k <= 256; k++) {
    const p = sidePoint(blend, side, k / 256);
    let best = Infinity;
    for (let i = 1; i < seam.length; i++)
      best = Math.min(best, segmentDistance(p, seam[i - 1] as Tuple3, seam[i] as Tuple3));
    worst = Math.max(worst, best);
  }
  return worst;
}

function segmentDistance(p: Tuple3, a: Tuple3, b: Tuple3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  return norm(sub(p, add(a, scale(ab, t))));
}

/** A fillet between two named patches of one `m.surface` call. */
export interface SurfaceBlend extends BlendOptions {
  /** Patch names (`SurfacePatch.name`) of the two patches; each name unique in the call. */
  readonly between: readonly [string, string];
  /** Patch name of the blend (default `blend`). */
  readonly name?: string;
}

/**
 * A setback corner: the named blends (n >= 3) meet at one vertex. The strips
 * of each face up to the isoparms `setback` beyond the widest contact from the vertex are
 * blended as usual (exact pieces of the face); each face keeps its surface and trims the
 * strips' contact regions and its corner square, and the n-sided hole (face isoparm + blend
 * end section + face isoparm per side) is filled with n quads by `nurbs.surface.fillN`. The quads meet the faces and blends at `continuity` and
 * each other G1 (the interior spokes and the center stay G1 by design).
 */
export interface SurfaceCorner {
  /** Names (`SurfaceBlend.name`) of the blends meeting at the vertex; each has a constant radius. */
  readonly blends: readonly string[];
  /** Distance the blends stop short of where their contacts would cross, meters (> 0). */
  readonly setback: number;
  /** To the faces and blends (default 'G1'). */
  readonly continuity?: 'G1' | 'G2';
  /** Patch name prefix of the quads, named `${name}-${k}` (default 'corner'). */
  readonly name?: string;
}

/**
 * Apply `corners`, then `blends` (except those the corners build) to a patch list in order:
 * each blend adds its trim region to its two patches, whose surfaces stay as given, and
 * appends the blend patch (with the first patch's `flip`). A blend whose adaptive fit stops
 * above `tolerance / 2` (64 control points, or a fairer fit kept) reports a `warn` in
 * `diagnostics`.
 */
export function resolveBlends(
  patches: readonly SurfacePatch[],
  blends: readonly SurfaceBlend[],
  corners: readonly SurfaceCorner[] = [],
  diagnostics: OpDiagnostic[] = [],
): Result<
  { readonly patches: SurfacePatch[]; readonly reports: readonly Record<string, unknown>[] },
  ModelingError
> {
  const out = [...patches];
  const reports: Record<string, unknown>[] = [];
  const claimed = new Set<number>();
  for (const [index, corner] of corners.entries()) {
    const resolved = resolveCorner(out, blends, corner, index, claimed);
    if (!resolved.ok) return resolved;
    reports.push(resolved.value);
  }
  for (const [index, blend] of blends.entries()) {
    if (claimed.has(index)) continue;
    const at = (name: unknown) => {
      const found = out.flatMap((p, k) => (p.name === name ? [k] : []));
      return found.length === 1 ? found[0] : undefined;
    };
    const ia = at(blend?.between?.[0]);
    const ib = at(blend?.between?.[1]);
    if (ia === undefined || ib === undefined || ia === ib)
      return err(
        invalid('a blend names two distinct patches, each name unique in the call', {
          blend: index,
          between: blend?.between as unknown,
        }),
      );
    const pa = out[ia] as SurfacePatch;
    const pb = out[ib] as SurfacePatch;
    const result = blendSurfaces(pa.surface, pb.surface, blend);
    if (!result.ok)
      return err(
        modelingError(
          result.error.code,
          result.error.expected,
          { ...result.error.detail, blend: index },
          result.error.hint,
        ),
      );
    out[ia] = withTrims(pa, [result.value.trimA]);
    out[ib] = withTrims(pb, [result.value.trimB]);
    out.push(blendPatch(pa, pb, blend, result.value));
    const report = {
      between: blend.between,
      sides: result.value.sides,
      setback: result.value.setback,
      gap: result.value.gap,
    };
    reports.push(report);
    const tolerance = blend.tolerance ?? 1e-5;
    if (blend.controlPoints === undefined && result.value.gap > tolerance / 2)
      diagnostics.push({
        severity: 'warn',
        message: `blend ${blend.name ?? 'blend'} leaves its contact sides ${result.value.gap} m from the trim edges (above tolerance / 2): more control points would ripple it, or it reached 64`,
        detail: { ...report, tolerance },
      });
  }
  return ok({ patches: out, reports });
}

function withTrims(p: SurfacePatch, outlines: readonly (readonly Point2[])[]): SurfacePatch {
  return { ...p, trims: [...(p.trims ?? []), ...outlines.map((outer) => ({ uv: [{ outer }] }))] };
}

/**
 * The blend patch of `pa` and `pb`: it runs along the shared side and inherits the
 * inflections the two patches declare along that side (u along the edge on the blend).
 */
function blendPatch(
  pa: SurfacePatch,
  pb: SurfacePatch,
  blend: SurfaceBlend,
  result: BlendResult,
): SurfacePatch {
  const along = (p: SurfacePatch, side: PatchSide) =>
    (side === 'v0' || side === 'v1' ? p.inflections?.u : p.inflections?.v) ?? 0;
  const turns = Math.max(along(pa, result.sides[0]), along(pb, result.sides[1]));
  return {
    name: blend.name ?? 'blend',
    surface: result.blend,
    transition: {
      kind: 'blend',
      continuity: blend.continuity ?? 'G1',
      gap: (blend.tolerance ?? 1e-5) / 2,
    },
    ...(pa.flip === undefined ? {} : { flip: pa.flip }),
    ...(turns > 0 ? { inflections: { u: turns } } : {}),
  };
}

const DEGREES = 180 / Math.PI;

/** Normalized position along `side` at arc length `distance` from its end `from` (0 or 1). */
function positionAt(s: NurbsSurface, side: PatchSide, from: 0 | 1, distance: number): number {
  const count = 512;
  let length = 0;
  let previous = sidePoint(s, side, from);
  for (let k = 1; k <= count; k++) {
    const f = k / count;
    const q = sidePoint(s, side, from === 0 ? f : 1 - f);
    const step = norm(sub(q, previous));
    if (length + step >= distance && step > 0) {
      const g = (k - 1 + (distance - length) / step) / count;
      return from === 0 ? g : 1 - g;
    }
    length += step;
    previous = q;
  }
  return from === 0 ? 1 : 0;
}

function sideLength(s: NurbsSurface, side: PatchSide): number {
  let length = 0;
  let previous = sidePoint(s, side, 0);
  for (let k = 1; k <= 128; k++) {
    const q = sidePoint(s, side, k / 128);
    length += norm(sub(q, previous));
    previous = q;
  }
  return length;
}

/** Unit tangent leaving `side`'s end `at` (0 or 1) into the side. */
function leaving(s: NurbsSurface, side: PatchSide, at: 0 | 1): Tuple3 {
  const h = 1e-4;
  return unit(sub(sidePoint(s, side, at === 0 ? h : 1 - h), sidePoint(s, side, at)));
}

/** The side of `s` running from `a` to `b` (either way), with the end at `a`. */
function sideJoining(
  s: NurbsSurface,
  a: Tuple3,
  b: Tuple3,
  tolerance: number,
): { side: PatchSide; at: 0 | 1 } | undefined {
  for (const side of SIDES)
    for (const at of [0, 1] as const)
      if (
        norm(sub(sidePoint(s, side, at), a)) <= tolerance &&
        norm(sub(sidePoint(s, side, 1 - at), b)) <= tolerance
      )
        return { side, at };
  return undefined;
}

const isUSide = (side: PatchSide) => side === 'u0' || side === 'u1';

/** An exact piece of a corner face, with the map from its normalized domain to the face's. */
interface Strip {
  readonly surface: NurbsSurface;
  readonly map: (p: Point2) => Point2;
}

/**
 * The fill boundary carrier on a face strip: the part of the strip's side through `c` that
 * runs from `p` (a blend contact on that side) to `c`, as the side of an exact split piece.
 * The strip's own side reaches on to the crease, inside the face's trim.
 */
function carrier(
  s: NurbsSurface,
  p: Tuple3,
  c: Tuple3,
  tolerance: number,
): { surface: NurbsSurface; side: PatchSide; at: 0 | 1 } | undefined {
  for (const side of SIDES)
    for (const end of [0, 1] as const) {
      if (norm(sub(sidePoint(s, side, end), c)) > tolerance) continue;
      const f = closestAlong(s, side, p);
      if (norm(sub(sidePoint(s, side, f), p)) > tolerance || f <= 1e-9 || f >= 1 - 1e-9) continue;
      const dir = isUSide(side) ? 'v' : 'u';
      const [[u0, u1], [v0, v1]] = surfaceDomain(s);
      const parts = surfaceSplit(s, dir, dir === 'u' ? lerp(u0, u1, f) : lerp(v0, v1, f));
      if (!parts.ok) continue;
      const piece = parts.value[end === 0 ? 0 : 1];
      const found = sideJoining(piece, p, c, tolerance);
      if (found !== undefined) return { surface: piece, ...found };
    }
  return undefined;
}

/** Normalized position along `side` closest to `p`: sampled, then golden-section refined. */
function closestAlong(s: NurbsSurface, side: PatchSide, p: Tuple3): number {
  const d = (f: number) => norm(sub(sidePoint(s, side, f), p));
  let best = 0;
  for (let k = 1; k <= 512; k++) if (d(k / 512) < d(best / 512)) best = k;
  let lo = Math.max(0, (best - 1) / 512);
  let hi = Math.min(1, (best + 1) / 512);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 60; it++) {
    const x = hi - g * (hi - lo);
    const y = lo + g * (hi - lo);
    if (d(x) <= d(y)) hi = y;
    else lo = x;
  }
  return (lo + hi) / 2;
}

/**
 * Build one setback corner (see `SurfaceCorner`) on `out` in place: blend the face strips,
 * trim the faces, fill the hole, and claim the corner's blends.
 */
function resolveCorner(
  out: SurfacePatch[],
  blends: readonly SurfaceBlend[],
  corner: SurfaceCorner,
  index: number,
  claimed: Set<number>,
): Result<Record<string, unknown>, ModelingError> {
  const name = corner?.name ?? 'corner';
  const continuity = corner?.continuity ?? 'G1';
  const setback = corner?.setback;
  if (!(typeof setback === 'number' && Number.isFinite(setback) && setback > 0))
    return err(
      modelingError(
        'model-invalid-argument',
        'a corner setback is a positive number of meters',
        { corner: index, setback },
        'setback > 0 (a zero setback leaves a degenerate three-sided corner)',
      ),
    );
  if (continuity !== 'G1' && continuity !== 'G2')
    return err(invalid("corner continuity is 'G1' or 'G2'", { corner: index, continuity }));
  const names = corner.blends;
  if (!Array.isArray(names) || names.length < 3)
    return err(invalid('a corner names at least 3 blends', { corner: index, blends: names }));
  const entries: SurfaceBlend[] = [];
  for (const blendName of names) {
    const found = blends.flatMap((b, k) => (b?.name === blendName ? [k] : []));
    const k = found[0];
    if (found.length !== 1 || k === undefined)
      return err(
        invalid('a corner names its blends by their unique SurfaceBlend name', {
          corner: index,
          blend: blendName,
          matches: found.length,
        }),
      );
    if (claimed.has(k))
      return err(
        invalid('a blend belongs to at most one corner', { corner: index, blend: blendName }),
      );
    const entry = blends[k] as SurfaceBlend;
    if (!(typeof entry.radius === 'number' && Number.isFinite(entry.radius) && entry.radius > 0))
      return err(
        invalid('a corner blend has a constant positive radius', {
          corner: index,
          blend: blendName,
          radius: entry.radius as unknown,
        }),
      );
    claimed.add(k);
    entries.push(entry);
  }
  const n = entries.length;
  // Faces around the vertex: blend i runs between faces[i] and faces[i + 1].
  const faces: string[] = [...(entries[0]?.between ?? [])];
  const order: number[] = [0];
  while (order.length < n) {
    const last = faces[faces.length - 1];
    const j = entries.findIndex((b, k) => !order.includes(k) && b.between.includes(last as string));
    const entry = entries[j];
    if (entry === undefined) break;
    order.push(j);
    const next = entry.between[0] === last ? entry.between[1] : entry.between[0];
    if (order.length < n) faces.push(next);
    else if (next !== faces[0]) faces.push(next);
  }
  const indexOf = (face: string) => {
    const found = out.flatMap((p, k) => (p.name === face ? [k] : []));
    return found.length === 1 ? found[0] : undefined;
  };
  if (order.length !== n || faces.length !== n || new Set(faces).size !== n)
    return err(
      modelingError(
        'model-precondition',
        "the corner's blends run between n faces in one cycle around a vertex",
        { corner: index, blends: names, faces },
        'list the blends whose faces meet at one vertex, each face in exactly two of them',
      ),
    );
  const at: number[] = [];
  for (const face of faces) {
    const k = indexOf(face);
    if (k === undefined)
      return err(
        invalid('corner blends name patches, each name unique in the call', {
          corner: index,
          face,
        }),
      );
    at.push(k);
  }
  const blendOf = (i: number) => entries[order[i] as number] as SurfaceBlend;
  const specOf = (i: number) => out[at[((i % n) + n) % n] as number] as SurfacePatch;
  const tolerance = maxOf(entries.map((b) => b.tolerance ?? 1e-5));
  // Side of face i toward face i + 1 (next) and toward face i - 1 (previous).
  const nextSide: PatchSide[] = [];
  const prevSide: PatchSide[] = new Array<PatchSide>(n);
  for (let i = 0; i < n; i++) {
    const shared = sharedSides(specOf(i).surface, specOf(i + 1).surface, tolerance);
    const pair = shared[0];
    if (shared.length !== 1 || pair === undefined)
      return err(
        modelingError(
          'model-precondition',
          'neighbouring corner faces share exactly one whole side',
          { corner: index, faces: [faces[i], faces[(i + 1) % n]], shared },
          'build the faces from one curve network so each pair shares a side',
        ),
      );
    nextSide.push(pair[0]);
    prevSide[(i + 1) % n] = pair[1];
  }
  // The vertex: the end common to every shared side.
  const s0 = specOf(0).surface;
  const vertex = [0, 1]
    .map((f) => sidePoint(s0, nextSide[0] as PatchSide, f))
    .find((v) =>
      faces.every((_, i) =>
        [nextSide[i], prevSide[i]].every((side) =>
          [0, 1].some(
            (f) => norm(sub(sidePoint(specOf(i).surface, side as PatchSide, f), v)) <= tolerance,
          ),
        ),
      ),
    );
  if (vertex === undefined)
    return err(
      modelingError(
        'model-precondition',
        "the corner's blends meet at one vertex",
        { corner: index, faces },
        'name the blends of the edges that end at one common vertex',
      ),
    );
  const endAt = (s: NurbsSurface, side: PatchSide): 0 | 1 =>
    norm(sub(sidePoint(s, side, 0), vertex)) <= norm(sub(sidePoint(s, side, 1), vertex)) ? 0 : 1;
  // Contact width of each blend at the vertex: r cot(opening / 2).
  const widths: number[] = [];
  for (let i = 0; i < n; i++) {
    const F = specOf(i).surface;
    const G = specOf(i + 1).surface;
    const sF = nextSide[i] as PatchSide;
    if (isUSide(sF) === isUSide(prevSide[i] as PatchSide))
      return err(
        modelingError(
          'model-precondition',
          'the two sides of a corner face at the vertex run along different directions',
          { corner: index, face: faces[i], sides: [prevSide[i], sF] },
          'each corner face meets the vertex with one u side and one v side',
        ),
      );
    const T = leaving(F, sF, endAt(F, sF));
    const intoF = leaving(F, prevSide[i] as PatchSide, endAt(F, prevSide[i] as PatchSide));
    const otherG = nextSide[(i + 1) % n] as PatchSide;
    const intoG = leaving(G, otherG, endAt(G, otherG));
    const opening = angle(across(intoF, T), across(intoG, T));
    if (!(opening < (179 * Math.PI) / 180))
      return err(
        modelingError(
          'model-precondition',
          'the corner faces meet at a crease',
          { corner: index, blend: blendOf(i).name, angle: opening * DEGREES },
          'a corner joins blended creases',
        ),
      );
    const r = blendOf(i).radius as number;
    widths.push((r * cos(opening / 2)) / sin(opening / 2));
  }
  const split = setback + maxOf(widths);
  const radius = maxOf(entries.map((b) => b.radius as number));
  for (let i = 0; i < n; i++)
    for (const side of [prevSide[i], nextSide[i]] as PatchSide[]) {
      const width = sideLength(specOf(i).surface, side);
      if (!(split < width))
        return err(
          modelingError(
            'model-precondition',
            'the setback corner fits inside each face (contact width + setback < face extent)',
            { corner: index, face: faces[i], radius, setback, width, contact: maxOf(widths) },
            'use a smaller radius or setback, or larger faces',
          ),
        );
    }
  // Split each face at the isoparms `split` from the vertex along both of its sides there. The
  // strips beside the blended sides are exact pieces of the face, blended in its place; the
  // face keeps its surface and trims their contact regions and its corner square.
  const e = TRIM_OVERSHOOT;
  const strips: { next: Strip; prev: Strip; c: Tuple3 }[] = [];
  const trims: Point2[][][] = [];
  for (let i = 0; i < n; i++) {
    const F = specOf(i).surface;
    const sN = nextSide[i] as PatchSide;
    const sP = prevSide[i] as PatchSide;
    // A v side runs along u: the split along it is in u.
    const alongU = isUSide(sN) ? sP : sN;
    const alongV = isUSide(sN) ? sN : sP;
    const [[u0, u1], [v0, v1]] = surfaceDomain(F);
    const eu = endAt(F, alongU);
    const ev = endAt(F, alongV);
    const fu = positionAt(F, alongU, eu, split);
    const fv = positionAt(F, alongV, ev, split);
    const us = lerp(u0, u1, fu);
    const vs = lerp(v0, v1, fv);
    const byU = surfaceSplit(F, 'u', us);
    if (!byU.ok) return byU;
    const [nearU, farU] = eu === 0 ? byU.value : [byU.value[1], byU.value[0]];
    const halves = (s: NurbsSurface) => {
      const byV = surfaceSplit(s, 'v', vs);
      if (!byV.ok) return byV;
      return ok(ev === 0 ? byV.value : ([byV.value[1], byV.value[0]] as const));
    };
    const near = halves(nearU);
    if (!near.ok) return near;
    const far = halves(farU);
    if (!far.ok) return far;
    const range = (end: 0 | 1, f: number, nearSide: boolean): readonly [number, number] =>
      (end === 0) === nearSide ? [0, f] : [f, 1];
    const strip = (
      surface: NurbsSurface,
      ru: readonly [number, number],
      rv: readonly [number, number],
    ): Strip => ({
      surface,
      map: ([x, y]) => [lerp(ru[0], ru[1], x), lerp(rv[0], rv[1], y)],
    });
    // The strip along a v side (at the vertex's v) is near in v and far in u.
    const stripAlongU = strip(far.value[0], range(eu, fu, false), range(ev, fv, true));
    const stripAlongV = strip(near.value[1], range(eu, fu, true), range(ev, fv, false));
    strips.push({
      next: isUSide(sN) ? stripAlongV : stripAlongU,
      prev: isUSide(sN) ? stripAlongU : stripAlongV,
      c: point(F, us, vs),
    });
    const cu = eu === 0 ? -e : 1 + e;
    const cv = ev === 0 ? -e : 1 + e;
    trims.push([
      [
        [Math.min(cu, fu), Math.min(cv, fv)],
        [Math.max(cu, fu), Math.min(cv, fv)],
        [Math.max(cu, fu), Math.max(cv, fv)],
        [Math.min(cu, fu), Math.max(cv, fv)],
      ],
    ]);
  }
  const blendPatches: SurfacePatch[] = [];
  const sides: FillBoundary[][] = [];
  const results: BlendResult[] = [];
  for (let i = 0; i < n; i++) {
    const blend = blendOf(i);
    const { between: _between, name: _name, sides: _sides, ...options } = blend;
    const a = (strips[i] as { next: Strip }).next;
    const b = (strips[(i + 1) % n] as { prev: Strip }).prev;
    const result = blendSurfaces(a.surface, b.surface, options);
    if (!result.ok)
      return err(
        modelingError(
          result.error.code,
          result.error.expected,
          { ...result.error.detail, corner: index, blend: blend.name },
          result.error.hint,
        ),
      );
    results.push(result.value);
    (trims[i] as Point2[][]).push(result.value.trimA.map(a.map));
    (trims[(i + 1) % n] as Point2[][]).push(result.value.trimB.map(b.map));
  }
  const join = 1e-6 + 1e-6 * split;
  let meet = 0;
  let kink = 0;
  for (let i = 0; i < n; i++) {
    const blend = (results[i] as BlendResult).blend;
    const ends = (['u0', 'u1'] as const).map((side) => ({
      side,
      d: norm(sub(sidePoint(blend, side, 0.5), vertex)),
    }));
    const end = (ends[0] as { d: number }).d <= (ends[1] as { d: number }).d ? 'u0' : 'u1';
    const SA = (strips[i] as { next: Strip }).next.surface;
    const SB = (strips[(i + 1) % n] as { prev: Strip }).prev.surface;
    const cA = (strips[i] as { c: Tuple3 }).c;
    const cB = (strips[(i + 1) % n] as { c: Tuple3 }).c;
    const p0 = sidePoint(blend, end, 0);
    const p1 = sidePoint(blend, end, 1);
    // A face isoparm off the blended edge's normal plane (the tilt, judged below) leaves the
    // held contact a little off the strip's side: the strip piece ends nearest it.
    const reach = (p: Tuple3, s: NurbsSurface, c: Tuple3) =>
      carrier(s, p, c, join) ?? carrier(s, p, c, 0.03 * norm(sub(p0, p1)));
    const [pa, pb] = reach(p0, SA, cA) !== undefined ? ([p0, p1] as const) : ([p1, p0] as const);
    const onA = reach(pa, SA, cA);
    const onB = reach(pb, SB, cB);
    // How far the strip pieces end from the blend end (0 but where the tilt holds a contact off).
    for (const [on, p] of [
      [onA, pa],
      [onB, pb],
    ] as const)
      if (on !== undefined)
        meet = Math.max(
          meet,
          Math.min(
            ...([0, 1] as const).map((e) => norm(sub(sidePoint(on.surface, on.side, e), p))),
          ),
        );
    if (onA === undefined || onB === undefined)
      return err(
        modelingError(
          'model-precondition',
          'the face strips end on the blend end section',
          { corner: index, blend: blendOf(i).name },
          'parametrize the faces orthogonally to the blended edges',
        ),
      );
    const atA: 0 | 1 = norm(sub(p0, pa)) <= join ? 0 : 1;
    const turn = (x: Tuple3, y: Tuple3) => 180 - angle(x, y) * DEGREES;
    const atB: 0 | 1 = atA === 0 ? 1 : 0;
    const kinks = [
      turn(leaving(onA.surface, onA.side, onA.at), leaving(blend, end, atA)),
      turn(leaving(onB.surface, onB.side, onB.at), leaving(blend, end, atB)),
    ];
    // The documented limit is on the faces' own isoparms (the strips before the blend trims
    // them) against the blended edge, which leaves the corner along the blend's rails. The
    // end kink can reach about twice the tilt: the blend end follows the slanted contact.
    const into: 0 | 1 = end === 'u0' ? 0 : 1;
    const tiltOf = (strip: NurbsSurface, c: Tuple3, at: 0 | 1) => {
      const rail = leaving(blend, at === 0 ? 'v0' : 'v1', into);
      let best = 90;
      for (const side of SIDES)
        for (const e of [0, 1] as const)
          if (norm(sub(sidePoint(strip, side, e), c)) <= join)
            best = Math.min(best, Math.abs(90 - angle(leaving(strip, side, e), rail) * DEGREES));
      return best;
    };
    const tilt = Math.max(tiltOf(SA, cA, atA), tiltOf(SB, cB, atB));
    const worst = maxOf(kinks);
    if (tilt > 1)
      return err(
        modelingError(
          'model-precondition',
          'each face isoparm at the corner is orthogonal to the blended edge within 1 degree',
          { corner: index, blend: blendOf(i).name, tilt, kink: worst },
          'parametrize the faces orthogonally to the blended edges',
        ),
      );
    kink = Math.max(kink, worst);
    sides.push([
      { surface: onA.surface, side: onA.side },
      { surface: blend, side: end },
      { surface: onB.surface, side: onB.side },
    ]);
  }
  const fill = fillN({
    boundaries: sides,
    continuity,
    ...(meet > 1e-6 ? { tolerance: 2 * meet } : {}),
  });
  if (!fill.ok)
    return err(
      modelingError(
        fill.error.code,
        fill.error.expected,
        { ...fill.error.detail, corner: index },
        fill.error.hint,
      ),
    );
  for (let i = 0; i < n; i++) {
    const spec = specOf(i);
    out[at[i] as number] = withTrims(spec, trims[i] as Point2[][]);
    blendPatches.push(blendPatch(spec, specOf(i + 1), blendOf(i), results[i] as BlendResult));
  }
  const flip = specOf(0).flip;
  out.push(
    ...blendPatches,
    ...fill.value.patches.map(
      (surface, k): SurfacePatch => ({
        name: `${name}-${k}`,
        surface,
        transition: { kind: 'corner', continuity },
        ...(flip === undefined ? {} : { flip }),
      }),
    ),
  );
  const worstOf = (edge: 'side' | 'spoke', key: 'angle' | 'gap') =>
    maxOf(fill.value.residual.filter((r) => r.edge === edge).map((r) => r[key]));
  // Per sample the jump is relative to the larger of two near-zero cross curvatures (always
  // about 1 beside a flat face); the corner's scale is its blend curvature 1 / r.
  const curvatureRatio = Math.max(
    ...fill.value.residual
      .filter((r) => r.edge === 'side')
      .map((r) => r.curvature * (blendOf(r.index).radius as number)),
  );
  return ok({
    corner: name,
    blends: names,
    faces,
    setback,
    split,
    kink,
    continuity,
    residual: {
      sideAngle: worstOf('side', 'angle'),
      spokeAngle: worstOf('spoke', 'angle'),
      gap: worstOf('side', 'gap'),
      sideCurvatureRatio: curvatureRatio,
      normalSpread: fill.value.normalSpread,
    },
  });
}
