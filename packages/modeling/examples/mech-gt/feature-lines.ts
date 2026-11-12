import { curveFairness, nurbs, type NurbsCurve, type Tuple3 } from '@forgeax/engine-modeling';
import { featureLines, planHalfWidth, sectionHalfWidth, sideOutline, type View } from './reference.ts';
import { FLOOR, ON_CAR, WHEELS } from './s2-body.ts';

/**
 * Case C-100 (examples/mech-gt): the feature-curve network of the car, the skeleton the
 * body surfaces are bounded by. Every line is fitted (never interpolated) from the measured
 * blueprint in the view it is drawn in, as cubic NURBS spans of at most FIT.maxPoints control
 * points with no inflection: a source polyline splits at its corners (G0) and at its
 * inflections (G2), and a span that needs more control points splits in half. The wheel
 * arches are exact arcs. FEATURE_TABLE says, per line, how it is held ("locked") and what
 * continuity the surfaces keep across it.
 */

/** Fit settings: control points per span, the tolerance to the drawing (meters), corner angle (degrees). */
export const FIT = { degree: 3, minPoints: 3, maxPoints: 8, tolerance: { line: 0.003, silhouette: 0.01 }, corner: 35, cornerReach: 0.03, minSpan: 6, flat: 0.5 } as const;

type P2 = readonly [number, number];

/** How a feature line is held by the surfaces . */
export type Lock = 'surface-boundary' | 'blend' | 'support-loops' | 'shut-line' | 'silhouette';
/** Continuity of the surfaces across a line: a deliberate break (G0 with a blend) or tangent / curvature continuous. */
export type Continuity = 'G0+blend' | 'G1' | 'G2';

/** One feature line of the network: its source in the blueprint and how the surfaces treat it. */
export interface FeatureLine {
  readonly id: string;
  readonly view: View;
  readonly note: string;
  readonly continuity: Continuity;
  readonly lock: Lock;
  /** Blend radius (meters) where the lock is a blend. */
  readonly radius?: number;
  /** Fit tolerance (meters) when it differs from FIT.tolerance for its kind (a coarsely drawn outline). */
  readonly tolerance?: number;
  /**
   * Designed breaks along the line's `axis` coordinate, with the continuity there; they replace
   * the drawn corners, and a piece still splits at an inflection or where no fit holds.
   */
  readonly breaks?: readonly { readonly at: number; readonly continuity: 'G0' | 'G1' | 'G2'; readonly note: string }[];
  /** Ranges of that coordinate where the drawing shows add-on parts on the outline (wing, louvres, wiper): bridged straight. */
  readonly exclude?: readonly (readonly [number, number])[];
  /** The coordinate breaks and exclusions are along (default 0: z in the side view; the plan runs along z = 1, the section along y = 1). */
  readonly axis?: 0 | 1;
  /** The drawn polyline on the car, in the view's coordinates. */
  readonly source: () => P2[];
}

/** Narrowest feature the silhouette lines keep (meters): the drawing's tail-lamp fins and similar spikes are narrower. */
const FIN = 0.08;
/** Slope (dy/dz) beyond which the side outline is a face, not the roof line. */
const STEEP = 2;

/**
 * The side outline above the floor (z, y), sampled per centimeter: its upper profile (roof
 * line, with spikes narrower than FIN opened away) or its lower profile (rocker, on the floor
 * where the tires are).
 */
function profile(which: 'upper' | 'lower'): P2[] {
  const pts = sideOutline(ON_CAR, FLOOR);
  const zs = pts.map((p) => p[0]);
  const [lo, hi] = [Math.min(...zs), Math.max(...zs)];
  const raw: P2[] = [];
  for (let z = lo + 0.005; z < hi - 0.004; z += 0.01) {
    const ys: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k] as P2;
      const b = pts[(k + 1) % pts.length] as P2;
      if ((a[0] - z) * (b[0] - z) > 0 || a[0] === b[0]) continue;
      ys.push(a[1] + ((z - a[0]) * (b[1] - a[1])) / (b[0] - a[0]));
    }
    if (ys.length > 0) raw.push([z, which === 'upper' ? Math.max(...ys) : Math.min(...ys)]);
  }
  if (which === 'lower') return raw;
  // Opening (min then max over FIN): removes peaks narrower than FIN, keeps the rest exactly.
  const w = Math.round(FIN / 2 / 0.01);
  const window = (values: number[], f: (...v: number[]) => number) => values.map((_, i) => f(...values.slice(Math.max(0, i - w), i + w + 1)));
  const opened = window(window(raw.map((p) => p[1]), Math.min), Math.max);
  const roof = raw.map((p, i): P2 => [p[0], opened[i] as number]);
  // The roof line ends where the outline turns steeper than STEEP over 3 cm (the nose and tail
  // faces, which the front-face and tail lines draw in their own views).
  const steep = (i: number) => Math.abs(((roof[Math.min(roof.length - 1, i + 3)] as P2)[1] - (roof[Math.max(0, i - 3)] as P2)[1]) / ((roof[Math.min(roof.length - 1, i + 3)] as P2)[0] - (roof[Math.max(0, i - 3)] as P2)[0] || 1)) > STEEP;
  let [a, b] = [0, roof.length - 1];
  while (a < b && steep(a)) a++;
  while (b > a && steep(b)) b--;
  return roof.slice(a, b + 1);
}

/** The lower profile outside the wheel arches (the tires stand above the floor inside them). */
function rocker(span: 'front' | 'sill' | 'rear'): P2[] {
  const [front, rear] = [ARCH_LINES.find((a) => a.id === 'arch-front') as ArchLine, ARCH_LINES.find((a) => a.id === 'arch-rear') as ArchLine];
  const z0 = span === 'front' ? front.center[0] + front.radius : span === 'sill' ? rear.center[0] + rear.radius : -Infinity;
  const z1 = span === 'front' ? Infinity : span === 'sill' ? front.center[0] - front.radius : rear.center[0] - rear.radius;
  return profile('lower').filter((p) => p[0] > z0 && p[0] < z1);
}

/** The mirror-free half section (x, y), the larger of the front and back views, from the floor to the roof. */
function halfSection(): P2[] {
  const out: P2[] = [];
  for (let y = FLOOR + 0.005; y < ON_CAR.height - 0.004; y += 0.01) out.push([sectionHalfWidth(ON_CAR, y), y]);
  return out.filter((p) => p[0] > 0);
}

/** The mirror-free plan half-width (x, z) along the car, from the tail to the nose. */
function plan(): P2[] {
  const out: P2[] = [];
  for (let z = ON_CAR.stations[0] + 0.005; z < ON_CAR.stations[3] - 0.004; z += 0.01) out.push([planHalfWidth(ON_CAR, z), z]);
  return out.filter((p) => p[0] > 0);
}

const drawn = (name: string) => () => (featureLines(name, ON_CAR)[0] ?? []).map((p): P2 => [p[0], p[1]]);

/**
 * The feature lines of the car : the silhouette profiles the body surfaces
 * are bounded by, and the character lines on them. The wheel arches are separate exact arcs
 * (ARCHES below).
 */
export const FEATURE_TABLE: readonly FeatureLine[] = [
  {
    id: 'roof-profile',
    view: 'right',
    note: 'side upper profile: deck, roof, windshield, front fender crown, nose',
    continuity: 'G2',
    lock: 'silhouette',
    source: () => profile('upper'),
    breaks: [
      { at: -2.22, continuity: 'G1', note: 'tail edge onto the deck' },
      { at: -0.68, continuity: 'G0', note: 'roof rear edge over the engine cover (C-pillar step)' },
      { at: 0.5, continuity: 'G1', note: 'windshield header (A-pillar top)' },
      { at: 1.4, continuity: 'G0', note: 'front fender crown over the front axle: the side outline leaves the windshield for the fender top' },
      { at: 2.3, continuity: 'G1', note: 'fender top onto the nose' },
    ],
    exclude: [[-1.48, -0.72]],
  },
  { id: 'rocker-front', view: 'right', note: 'side lower profile ahead of the front arch: splitter and nose', continuity: 'G1', lock: 'silhouette', source: () => rocker('front') },
  { id: 'rocker-sill', view: 'right', note: 'side lower profile between the arches: the sill', continuity: 'G1', lock: 'silhouette', source: () => rocker('sill') },
  { id: 'rocker-rear', view: 'right', note: 'side lower profile behind the rear arch: diffuser', continuity: 'G1', lock: 'silhouette', source: () => rocker('rear') },
  {
    id: 'plan',
    view: 'top',
    note: 'plan half-width: tail corner, rear haunch, doors, front fender, nose corner',
    continuity: 'G2',
    lock: 'silhouette',
    source: plan,
    axis: 1,
    breaks: [
      { at: -2.22, continuity: 'G1', note: 'tail-lamp corner' },
      { at: -2.0, continuity: 'G1', note: 'tail corner into the rear haunch' },
      { at: -1.55, continuity: 'G2', note: 'rear haunch at its widest' },
      { at: -0.4, continuity: 'G0', note: 'rear flare steps down to the doors' },
      { at: 1.66, continuity: 'G1', note: 'front fender turns into the nose taper' },
      { at: 2.2, continuity: 'G1', note: 'nose taper tightens toward the corner' },
      { at: 2.4, continuity: 'G1', note: 'nose corner' },
    ],
    exclude: [[-1.04, -0.92]],
  },
  {
    id: 'section',
    view: 'front',
    note: 'largest half section (front and back views, mirror-free): sill to roof',
    continuity: 'G2',
    lock: 'silhouette',
    source: halfSection,
    axis: 1,
    breaks: [
      { at: 0.22, continuity: 'G1', note: 'sill bottom corner' },
      { at: 0.73, continuity: 'G1', note: 'shoulder knee: body side into the tumblehome' },
      { at: 0.98, continuity: 'G1', note: 'roof edge' },
      { at: 1.06, continuity: 'G1', note: 'roof crown' },
    ],
  },
  {
    id: 'shoulder',
    view: 'right',
    note: 'rear shoulder crease: engine cover over the rear fender',
    continuity: 'G0+blend',
    lock: 'blend',
    radius: 0.004,
    source: drawn('shoulder'),
    breaks: [{ at: -2.17, continuity: 'G1', note: 'the crease leaves its run over the tail lamp' }],
  },
  { id: 'belt', view: 'right', note: 'side glass lower edge: door glass over the door', continuity: 'G0+blend', lock: 'shut-line', source: drawn('belt') },
  { id: 'waist', view: 'right', note: 'character line across the door and front fender', continuity: 'G0+blend', lock: 'blend', radius: 0.003, source: drawn('waist') },
  { id: 'sill', view: 'right', note: 'lower crease of the side scoop', continuity: 'G0+blend', lock: 'blend', radius: 0.005, source: drawn('sill') },
  { id: 'side-intake', view: 'right', note: 'side intake opening (a real opening into its duct)', continuity: 'G0+blend', lock: 'surface-boundary', source: drawn('sideIntake') },
  { id: 'front-face', view: 'front', note: 'front face: hood leading edge, lamp surrounds, lower intake', continuity: 'G0+blend', lock: 'surface-boundary', tolerance: 0.005, source: drawn('frontFace') },
  { id: 'tail-band', view: 'back', note: 'tail-lamp band across the rear', continuity: 'G0+blend', lock: 'surface-boundary', tolerance: 0.005, source: drawn('tail') },
];

/** A wheel arch: the fender trim circle in the side view (an exact arc, the arch lip is a surface boundary). */
export interface ArchLine {
  readonly id: string;
  readonly center: P2;
  readonly radius: number;
}

/** Arch lips: the tire radius plus the arch gap the S3 fenders are trimmed with. */
export const ARCH_LINES: readonly ArchLine[] = WHEELS.filter((w) => w.x > 0).map((w) => ({ id: `arch-${w.z > 0 ? 'front' : 'rear'}`, center: [w.z, w.d / 2] as P2, radius: w.d / 2 + 0.035 }));

/** One fitted span of a feature line. */
export interface Span {
  readonly line: string;
  readonly index: number;
  readonly curve: NurbsCurve;
  /** The drawn points it fits. */
  readonly points: readonly P2[];
  /** Largest and mean distance from the drawn points to the curve (meters). */
  readonly error: { readonly max: number; readonly mean: number };
  /** Sign changes of the curvature along the span. */
  readonly inflections: number;
  /** How the span meets the next one: a corner (G0), a tight radius (G1), an inflection (G2) or the line's end. */
  readonly next: 'G0' | 'G1' | 'G2' | 'end';
}

const to3 = (p: P2): Tuple3 => [p[0], p[1], 0];

/** Signed curvature of a plane curve (z = 0) at t. */
export function signedCurvature(curve: NurbsCurve, t: number): number {
  const [, d1, d2] = nurbs.derivatives(curve, t, 2) as [Tuple3, Tuple3, Tuple3];
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  const speed = Math.hypot(d1[0], d1[1]);
  return speed === 0 ? 0 : cross / speed ** 3;
}

function samples(curve: NurbsCurve, n: number): { t: number; p: Tuple3; k: number }[] {
  const [t0, t1] = nurbs.domain(curve);
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = t0 + ((t1 - t0) * i) / n;
    return { t, p: nurbs.point(curve, t), k: signedCurvature(curve, t) };
  });
}

/** Sign changes of the curvature, ignoring near-straight stretches (|k| below FIT.flat, a 2 m radius). */
export function inflections(curve: NurbsCurve): number {
  let sign = 0;
  let count = 0;
  for (const s of samples(curve, 200)) {
    if (Math.abs(s.k) < FIT.flat) continue;
    const now = Math.sign(s.k);
    if (sign !== 0 && now !== sign) count++;
    sign = now;
  }
  return count;
}

function fitError(curve: NurbsCurve, points: readonly P2[]): { max: number; mean: number } {
  const dense = samples(curve, 400).map((s) => s.p);
  const d = points.map((q) => {
    let best = Infinity;
    for (let i = 0; i + 1 < dense.length; i++) {
      const [a, b] = [dense[i] as Tuple3, dense[i + 1] as Tuple3];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy)));
    }
    return best;
  });
  return { max: Math.max(...d), mean: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length) };
}

/** Indices where the drawn polyline turns by more than FIT.corner degrees, measured over FIT.cornerReach either side (so sample noise is no corner). */
function corners(points: readonly P2[]): number[] {
  const out: number[] = [];
  const at = (i: number, dir: 1 | -1) => {
    let j = i;
    while (j + dir >= 0 && j + dir < points.length && Math.hypot((points[j] as P2)[0] - (points[i] as P2)[0], (points[j] as P2)[1] - (points[i] as P2)[1]) < FIT.cornerReach) j += dir;
    return points[j] as P2;
  };
  let last = -Infinity;
  for (let i = 1; i + 1 < points.length; i++) {
    const [a, b, c] = [at(i, -1), points[i] as P2, at(i, 1)];
    const u: P2 = [b[0] - a[0], b[1] - a[1]];
    const w: P2 = [c[0] - b[0], c[1] - b[1]];
    const cos = (u[0] * w[0] + u[1] * w[1]) / ((Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1])) || 1);
    const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    // One corner per turn: the first index of a run of turning samples.
    if (angle > FIT.corner && i - last > 3) out.push(i);
    if (angle > FIT.corner) last = i;
  }
  return out;
}

/**
 * The curve with its end tangents held forward: a fit pinned to its end samples can pull the
 * next control point behind the end (a hook of millimeter radius where the samples still curl
 * with a neighbouring corner); that point moves forward along the span's chord to a third of
 * a control-point spacing, keeping its offset across the chord.
 */
function unhooked(curve: NurbsCurve): NurbsCurve {
  const pts = curve.points.map((p): Tuple3 => [p[0], p[1], p[2]]);
  const n = pts.length - 1;
  if (n < 2) return curve;
  const [a, b] = [pts[0] as Tuple3, pts[n] as Tuple3];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const d: P2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const lead = len / (3 * n);
  const hold = (i: number, from: Tuple3, sign: 1 | -1) => {
    const p = pts[i] as Tuple3;
    const along = sign * ((p[0] - from[0]) * d[0] + (p[1] - from[1]) * d[1]);
    if (along >= lead) return;
    const shift = sign * (lead - along);
    pts[i] = [p[0] + d[0] * shift, p[1] + d[1] * shift, p[2]];
  };
  hold(1, a, 1);
  hold(n - 1, b, -1);
  return { ...curve, points: pts };
}

/**
 * The fewest control points (FIT.minPoints ..= FIT.maxPoints) within `tolerance` that are also
 * fair by the kernel's check (a span too short to judge only needs the tolerance); else the
 * fewest within tolerance (the caller splits it where it is unfair), or undefined.
 */
function fitSpan(points: readonly P2[], tolerance: number): { curve: NurbsCurve; error: { max: number; mean: number } } | undefined {
  let within: { curve: NurbsCurve; error: { max: number; mean: number } } | undefined;
  for (let n = Math.min(FIT.minPoints, points.length); n <= Math.min(FIT.maxPoints, points.length); n++) {
    const r = nurbs.approximate(points.map(to3), { degree: Math.min(FIT.degree, n - 1), controlPoints: n });
    if (!r.ok) continue;
    const error = fitError(r.value, points);
    if (error.max > tolerance) continue;
    if (points.length < 2 * FIT.minSpan) return { curve: r.value, error };
    for (const curve of [r.value, unhooked(r.value)]) {
      const e = curve === r.value ? error : fitError(curve, points);
      if (e.max > tolerance) continue;
      const fair = curveFairness({ name: 'span', curve });
      if (fair.ok && fair.value.pass) return { curve, error: e };
    }
    within ??= { curve: r.value, error };
  }
  return within;
}

/** The fit tolerance of a line (meters). */
export function toleranceOf(line: Pick<FeatureLine, 'lock' | 'tolerance'>): number {
  return line.tolerance ?? (line.lock === 'silhouette' ? FIT.tolerance.silhouette : FIT.tolerance.line);
}

/** The curvature comb of a span: samples along it with the comb tooth (normal times curvature). */
export function comb(curve: NurbsCurve, n = 80): { p: Tuple3; tooth: Tuple3; k: number }[] {
  const [t0, t1] = nurbs.domain(curve);
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = t0 + ((t1 - t0) * i) / n;
    const [p, d1] = nurbs.derivatives(curve, t, 1) as [Tuple3, Tuple3];
    const l = Math.hypot(d1[0], d1[1]) || 1;
    const k = signedCurvature(curve, t);
    return { p, tooth: [(-d1[1] / l) * k, (d1[0] / l) * k, 0], k };
  });
}

/** The point index nearest a point of a curve. */
function nearestIndex(points: readonly P2[], p: Tuple3): number {
  let bi = 0;
  let bd = Infinity;
  for (const [i, q] of points.entries()) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) [bi, bd] = [i, d];
  }
  return bi;
}

/**
 * Where a fit fails the kernel's fairness check (curveFairness: inflections, curvature spikes,
 * curvature rate), as a point index to split at; undefined when it is fair or the place is at
 * an end.
 */
function unfairAt(curve: NurbsCurve, points: readonly P2[]): number | undefined {
  const fair = curveFairness({ name: 'span', curve });
  if (!fair.ok || fair.value.pass) return undefined;
  const place = fair.value.inflections[0] ?? fair.value.spikes[0] ?? fair.value.rateAt;
  const i = nearestIndex(points, place.point);
  return i >= 1 && i <= points.length - 2 ? i : undefined;
}

/** The strongest curvature peak of a fair fit away from the ends, as a point index. */
function peakAt(points: readonly P2[]): number {
  const r = nurbs.approximate(points.map(to3), { degree: FIT.degree, controlPoints: Math.min(points.length, FIT.maxPoints + 2) });
  if (!r.ok) return Math.floor(points.length / 2);
  let best = Math.floor(points.length / 2);
  let bk = -1;
  for (const s of samples(r.value, 200)) {
    const i = nearestIndex(points, s.p);
    if (i < points.length * 0.15 || i > points.length * 0.85) continue;
    if (Math.abs(s.k) > bk) [best, bk] = [i, Math.abs(s.k)];
  }
  return best;
}

/**
 * The source with each excluded range (an add-on drawn on the outline) bridged: the samples
 * inside it become a straight line between the last sample before and the first after, so the
 * fit sees the body under the add-on instead of a gap (which would stretch its parameters).
 */
function bridged(points: readonly P2[], exclude: readonly (readonly [number, number])[], axis: 0 | 1): P2[] {
  const out = [...points];
  for (const [lo, hi] of exclude) {
    const inside = out.map((p, i) => (p[axis] >= lo && p[axis] <= hi ? i : -1)).filter((i) => i >= 0);
    if (inside.length === 0) continue;
    const [i0, i1] = [Math.max(0, (inside[0] as number) - 1), Math.min(out.length - 1, (inside.at(-1) as number) + 1)];
    const [a, b] = [out[i0] as P2, out[i1] as P2];
    for (const i of inside) {
      const q = out[i] as P2;
      // Keep the sample's own axis coordinate; the other follows the bridge.
      const t = (q[axis] - a[axis]) / ((b[axis] - a[axis]) || 1);
      const other = axis === 0 ? a[1] + (b[1] - a[1]) * t : a[0] + (b[0] - a[0]) * t;
      out[i] = axis === 0 ? [q[0], other] : [other, q[1]];
    }
  }
  return out;
}

/**
 * Fit one feature line into spans: split at the drawn corners (G0); fit each piece with the
 * fewest control points within tolerance; a piece no fit can hold splits at its strongest
 * curvature peak (a designed tight radius, G1) and a fit that still turns both ways splits
 * at its inflection (G2).
 */
export function fitLine(line: Pick<FeatureLine, 'id' | 'source' | 'lock' | 'tolerance' | 'breaks' | 'exclude' | 'axis'>): Span[] {
  const axis = line.axis ?? 0;
  const points = bridged(line.source(), line.exclude ?? [], axis);
  const tolerance = toleranceOf(line);
  const out: Span[] = [];
  const kinds = new Map<number, Span['next']>();
  // Designed breaks (with their continuity) where the table gives them, the drawn corners otherwise.
  const designed = (line.breaks ?? []).map((cut) => {
    let bi = 0;
    let bd = Infinity;
    for (const [j, q] of points.entries()) if (Math.abs(q[axis] - cut.at) < bd) [bi, bd] = [j, Math.abs(q[axis] - cut.at)];
    kinds.set(bi, cut.continuity);
    return bi;
  });
  const drawn = line.breaks === undefined ? corners(points) : [];
  for (const c of drawn) kinds.set(c, 'G0');
  const cuts = [...new Set([0, ...designed, ...drawn, points.length - 1])].sort((a, b) => a - b);
  const stack: [number, number][] = [];
  for (let k = cuts.length - 2; k >= 0; k--) stack.push([cuts[k] as number, cuts[k + 1] as number]);
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    const pts = points.slice(a, b + 1);
    if (pts.length < 2) continue;
    const small = pts.length < FIT.minSpan;
    const fit = fitSpan(pts, tolerance);
    const turn = fit === undefined ? undefined : unfairAt(fit.curve, pts);
    if (!small && (fit === undefined || turn !== undefined)) {
      const at = a + (turn ?? peakAt(pts));
      kinds.set(at, turn !== undefined ? 'G2' : 'G1');
      stack.push([at, b], [a, at]);
      continue;
    }
    const curve = fit?.curve ?? (nurbs.approximate(pts.map(to3), { degree: Math.min(FIT.degree, pts.length - 1), controlPoints: Math.min(pts.length, FIT.maxPoints) }) as { ok: true; value: NurbsCurve }).value;
    out.push({ line: line.id, index: out.length, curve, points: pts, error: fit?.error ?? fitError(curve, pts), inflections: inflections(curve), next: b === points.length - 1 ? 'end' : (kinds.get(b) ?? 'G0') });
  }
  return out;
}

/** The whole network: every table line fitted. */
export function featureNetwork(): Span[] {
  return FEATURE_TABLE.flatMap((line) => fitLine(line));
}
