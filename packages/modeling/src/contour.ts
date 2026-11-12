import { hypot2 } from './dmath';
import type { Point2 } from './primitives';

/** The point-based curve kinds (`CurveSpec` reuses them): polyline, centripetal spline, tolerance-bounded fit. */
export type ContourKind =
  | { readonly kind: 'polyline' }
  | { readonly kind: 'spline' }
  | { readonly kind: 'fit'; readonly smooth?: boolean };

/** Input points of one curve spec; the over-budget error states it. @internal */
export const CONTOUR_POINT_LIMIT = 4096;
const MAX_DEPTH = 14;

function distanceToSegment(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return hypot2(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from each sample to the outline (closed) or line (open). @internal */
export function sampleDistances(
  samples: readonly Point2[],
  outline: readonly Point2[],
  closed = true,
): number[] {
  const n = closed ? outline.length : outline.length - 1;
  return samples.map((p) => {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = distanceToSegment(
        p,
        outline[i] as Point2,
        outline[(i + 1) % outline.length] as Point2,
      );
      if (d < best) best = d;
    }
    return best;
  });
}

/** Largest distance from any sample to the outline (closed, default) or line (open). */
export function outlineDeviation(
  samples: readonly Point2[],
  outline: readonly Point2[],
  closed = true,
): number {
  let worst = 0;
  for (const d of sampleDistances(samples, outline, closed)) if (d > worst) worst = d;
  return worst;
}

/**
 * Distance from `p` to an open line, and whether its nearest point lies inside the line's span
 * (not beyond either end).
 * @internal
 */
export function spanDistance(
  p: Point2,
  line: readonly Point2[],
): { readonly distance: number; readonly inside: boolean } {
  // Repeated points make zero-length end segments that would hide the line's real ends.
  const pts = line.filter(
    (q, i) => i === 0 || q[0] !== line[i - 1]?.[0] || q[1] !== line[i - 1]?.[1],
  );
  if (pts.length === 1) {
    const q = pts[0] as Point2;
    return { distance: hypot2(p[0] - q[0], p[1] - q[1]), inside: false };
  }
  let distance = Infinity;
  let inside = false;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Point2;
    const b = pts[i] as Point2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const raw = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
    const d = distanceToSegment(p, a, b);
    if (d < distance) {
      distance = d;
      inside = !((i === 1 && raw < 0) || (i === pts.length - 1 && raw > 1));
    }
  }
  return { distance, inside };
}

/**
 * Largest distance from the samples to an open line, counting only samples within `reach`
 * whose nearest point lies inside the line's span: what a line answers for, so a
 * neighbouring piece or a band left out between pieces never counts.
 * @internal
 */
export function spanDeviation(
  samples: readonly Point2[],
  line: readonly Point2[],
  reach: number,
): number {
  let worst = 0;
  for (const p of samples) {
    const s = spanDistance(p, line);
    if (s.inside && s.distance <= reach && s.distance > worst) worst = s.distance;
  }
  return worst;
}

/** A polyline resampled so no segment is longer than `step`. @internal */
export function resampleLine(line: readonly Point2[], step: number): Point2[] {
  const out: Point2[] = line.length > 0 ? [line[0] as Point2] : [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as Point2;
    const b = line[i] as Point2;
    const n = Math.max(1, Math.ceil(hypot2(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++)
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** A polyline without `inset` meters of its length at each end. */
function trimEnds(line: readonly Point2[], inset: number): Point2[] {
  if (inset <= 0) return [...line];
  const at: number[] = [0];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as Point2;
    const b = line[i] as Point2;
    at.push((at[i - 1] as number) + hypot2(b[0] - a[0], b[1] - a[1]));
  }
  const total = at.at(-1) ?? 0;
  return line.filter((_, i) => (at[i] as number) >= inset && (at[i] as number) <= total - inset);
}

/**
 * A drawn open line against its realised counterpart in the same view, over the span both
 * share: the largest drawn-to-counterpart and counterpart-to-drawn distances inside each
 * other's span (within `reach`), and `coverage`, the share of the drawn line (without `inset`
 * at each end) whose counterpart lies inside its span. The one owner of line comparison:
 * drawing features and shut-line breaks use it.
 * @internal
 */
export function compareLines(
  drawn: readonly Point2[],
  counterpart: readonly Point2[],
  options: { readonly reach: number; readonly inset?: number },
): { readonly max: number; readonly back: number; readonly coverage: number } {
  const line = trimEnds(resampleLine(drawn, 0.01), options.inset ?? 0);
  let total = 0;
  let covered = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as Point2;
    const b = line[i] as Point2;
    const length = hypot2(b[0] - a[0], b[1] - a[1]);
    total += length;
    const s = spanDistance([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], counterpart);
    if (s.inside && s.distance <= options.reach) covered += length;
  }
  return {
    max: spanDeviation(line, counterpart, options.reach),
    back: spanDeviation(counterpart, line, options.reach),
    coverage: total > 0 ? covered / total : 0,
  };
}

/** Signed area of a closed polygon (positive counter-clockwise). @internal */
export function signedArea(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point2;
    const b = points[(i + 1) % points.length] as Point2;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

/** Point of the centripetal Catmull-Rom span p1 -> p2 at `s` in [0, 1] (Barry-Goldman). */
function catmullRom(p0: Point2, p1: Point2, p2: Point2, p3: Point2, s: number): Point2 {
  const knot = (a: Point2, b: Point2) =>
    Math.max(Math.sqrt(hypot2(b[0] - a[0], b[1] - a[1])), 1e-12);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * s;
  const lerp = (a: Point2, b: Point2, ta: number, tb: number): Point2 => {
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = lerp(p0, p1, 0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, 0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/**
 * Spline through `controls` (closed, or open with its end spans clamped), each span split
 * until its chord error is within `tolerance`.
 */
function sampleSpline(controls: readonly Point2[], tolerance: number, closed = true): Point2[] {
  const n = controls.length;
  const out: Point2[] = [];
  const control = (i: number) =>
    (closed ? controls[(i + n) % n] : controls[Math.max(0, Math.min(n - 1, i))]) as Point2;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = control(i - 1);
    const p1 = control(i);
    const p2 = control(i + 1);
    const p3 = control(i + 2);
    const at = (s: number) => catmullRom(p0, p1, p2, p3, s);
    out.push(p1);
    const split = (s0: number, a: Point2, s1: number, b: Point2, depth: number) => {
      const sm = (s0 + s1) / 2;
      const m = at(sm);
      // Quarter points as well: an S-shaped span can cross its chord at the midpoint.
      const q1 = at((s0 + sm) / 2);
      const q3 = at((sm + s1) / 2);
      const error = Math.max(
        distanceToSegment(m, a, b),
        distanceToSegment(q1, a, b),
        distanceToSegment(q3, a, b),
      );
      if (depth >= MAX_DEPTH || error <= tolerance) return;
      split(s0, a, sm, m, depth + 1);
      out.push(m);
      split(sm, m, s1, b, depth + 1);
    };
    split(0, p1, 1, p2, 0);
  }
  if (!closed) out.push(controls[n - 1] as Point2);
  return out;
}

/** Douglas-Peucker (closed, or open between the end samples): indices of the kept samples, in order. */
function simplify(samples: readonly Point2[], tolerance: number, closed = true): number[] {
  if (!closed)
    return simplifyBetween(samples, tolerance, new Set([0, samples.length - 1]), [
      [0, samples.length - 1],
    ]);
  let far = 0;
  let farDistance = -1;
  const first = samples[0] as Point2;
  for (const [i, p] of samples.entries()) {
    const d = hypot2(p[0] - first[0], p[1] - first[1]);
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  }
  const n = samples.length;
  return simplifyBetween(samples, tolerance, new Set<number>([0, far]), [
    [0, far],
    [far, n],
  ]);
}

function simplifyBetween(
  samples: readonly Point2[],
  tolerance: number,
  keep: Set<number>,
  stack: [number, number][],
): number[] {
  const n = samples.length;
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    const pa = samples[a % n] as Point2;
    const pb = samples[b % n] as Point2;
    let worst = -1;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distanceToSegment(samples[i] as Point2, pa, pb);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep.add(index);
      stack.push([a, index], [index, b]);
    }
  }
  return [...keep].sort((x, y) => x - y);
}

/**
 * The points of a contour-kind curve (closed outline or open line) from its distinct input
 * points: `polyline` keeps them, `spline` samples the Catmull-Rom through them, `fit` keeps
 * the fewest whose line stays within `tolerance`. Drawing curves share it.
 * @internal
 */
export function contourPoints(
  spec: ContourKind,
  input: readonly Point2[],
  tol: number,
  closed: boolean,
): { readonly points: Point2[]; readonly deviation: number } {
  if (spec.kind === 'polyline') return { points: [...input], deviation: 0 };
  if (spec.kind === 'spline') return { points: sampleSpline(input, tol, closed), deviation: 0 };
  // Halve the selection tolerance until the result (straight or smoothed) is within
  // `tolerance` of every sample; smoothing may otherwise overshoot between keys.
  let select = spec.smooth === true ? tol / 2 : tol;
  let points: Point2[] = [...input];
  let deviation = 0;
  for (let attempt = 0; ; attempt++) {
    const keys = simplify(input, select, closed).map((i) => input[i] as Point2);
    points = spec.smooth === true && keys.length >= 3 ? sampleSpline(keys, tol / 4, closed) : keys;
    deviation = outlineDeviation(input, points, closed);
    if (deviation <= tol || attempt >= 12) break;
    select /= 2;
  }
  return { points, deviation };
}

/**
 * Offset a counter-clockwise outline outward by `distance` (miter joins, each
 * miter limited to 4x the distance). For small distances against the feature size.
 */
export function growOutline(points: readonly Point2[], distance: number): Point2[] {
  const n = points.length;
  const normal = (a: Point2, b: Point2): Point2 => {
    const l = hypot2(b[0] - a[0], b[1] - a[1]);
    return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l];
  };
  return points.map((p, i) => {
    const n1 = normal(points[(i + n - 1) % n] as Point2, p);
    const n2 = normal(p, points[(i + 1) % n] as Point2);
    const miter = Math.min(1 / Math.max(1 + n1[0] * n2[0] + n1[1] * n2[1], 1e-9), 8);
    return [p[0] + distance * (n1[0] + n2[0]) * miter, p[1] + distance * (n1[1] + n2[1]) * miter];
  });
}
