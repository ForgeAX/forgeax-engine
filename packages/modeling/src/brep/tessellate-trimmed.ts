import { atan2 } from '../dmath';
import { CDT_FIRST_VERTEX, type Cdt, type CdtFailure, triangulateRings } from './cdt';
import { surfaceDerivatives, surfaceNormal, surfacePoint } from './surfaces';
import type { Surface } from './types';
import { dist3, dot3, len3, type P2, type P3 } from './vec';

/** One closed boundary ring of a trimmed face: parameter samples and the mesh vertex each one is. */
export interface TrimRing {
  readonly uv: readonly P2[];
  readonly ids: readonly number[];
}

export interface TrimmedOptions {
  /** Largest normal turn across an interior triangle edge, in radians. */
  readonly angle: number;
  /** Largest distance between a triangle and the surface, in metres (none when absent). */
  readonly chord?: number;
  /** Upper bound on boundary plus interior points. */
  readonly maxPoints: number;
  /** Minimum interior angle in radians; triangles below it are refined. Absent = no angle criterion. */
  readonly minAngle?: number;
  /** Opt-in cap on the interior edge length in metres (default: a quarter of the face extent). */
  readonly spacing?: number;
}

/** Interior parameter points to add (in order) and counter-clockwise triangles over boundary + interior points. */
export interface TrimmedTriangulation {
  readonly interior: readonly P2[];
  readonly triangles: readonly (readonly [number, number, number])[];
}

export type TrimmedFailure =
  | { readonly reason: CdtFailure; readonly point: number }
  | { readonly reason: 'non-finite-metric' | 'empty-region' };

export type TrimmedResult =
  | { readonly ok: true; readonly value: TrimmedTriangulation }
  | { readonly ok: false; readonly error: TrimmedFailure };

const METRIC_SAMPLES = 5;
/** Coarsest interior spacing as a fraction of the face's larger physical extent. */
const COARSEST = 1 / 4;
/** Smallest circumradius refined, in metric units; with empty circumcircles this bounds the point count. */
const MIN_RADIUS = 1 / 16;
/** A fallback edge midpoint must stay this far (metric units) from the edge's four local vertices. */
const MIN_GAP = 1 / 4;
/** Ruppert quality bound: a triangle with a smaller minimum angle is refined (radians). */
export const MIN_ANGLE = (25 * Math.PI) / 180;

function unitNormal(surface: Surface, u: number, v: number): P3 | undefined {
  const n = surfaceNormal(surface, u, v);
  const l = len3(n);
  return l > 0 && Number.isFinite(l) ? [n[0] / l, n[1] / l, n[2] / l] : undefined;
}

/**
 * The face's constant anisotropic metric: (u, v) is scaled per direction so that one unit is the
 * spacing that direction needs. A direction's spacing is the coarsest spacing, tightened by the angle
 * bound (normal turn per metre) and the chord bound (a sagitta k h^2 / 8 at curvature k), from the
 * largest rates sampled over the face box. A cylinder is fine around its axis and coarse along it.
 */
function faceMetric(surface: Surface, lo: P2, hi: P2, options: TrimmedOptions): P2 | undefined {
  let su = 0;
  let sv = 0;
  let ku = 0;
  let kv = 0;
  const du = (hi[0] - lo[0]) * 1e-4;
  const dv = (hi[1] - lo[1]) * 1e-4;
  const turn = (a: P2, b: P2, metres: number): number => {
    const na = unitNormal(surface, a[0], a[1]);
    const nb = unitNormal(surface, b[0], b[1]);
    return na === undefined || nb === undefined || !(metres > 0) ? 0 : dist3(na, nb) / metres;
  };
  for (let i = 0; i < METRIC_SAMPLES; i++) {
    for (let j = 0; j < METRIC_SAMPLES; j++) {
      const u = lo[0] + ((hi[0] - lo[0]) * (i + 0.5)) / METRIC_SAMPLES;
      const v = lo[1] + ((hi[1] - lo[1]) * (j + 0.5)) / METRIC_SAMPLES;
      const d = surfaceDerivatives(surface, u, v);
      const lu = len3(d.du);
      const lv = len3(d.dv);
      su += lu;
      sv += lv;
      if (du > 0) ku = Math.max(ku, turn([u - du, v], [u + du, v], 2 * du * lu));
      if (dv > 0) kv = Math.max(kv, turn([u, v - dv], [u, v + dv], 2 * dv * lv));
    }
  }
  const n = METRIC_SAMPLES * METRIC_SAMPLES;
  su /= n;
  sv /= n;
  const coarsest = Math.min(
    COARSEST * Math.max(su * (hi[0] - lo[0]), sv * (hi[1] - lo[1])),
    options.spacing ?? Number.POSITIVE_INFINITY,
  );
  const spacing = (k: number): number => {
    let h = coarsest;
    if (k > 0) {
      h = Math.min(h, options.angle / k);
      if (options.chord !== undefined) h = Math.min(h, 2 * Math.sqrt((2 * options.chord) / k));
    }
    return h;
  };
  const m: P2 = [su / spacing(ku), sv / spacing(kv)];
  return Number.isFinite(m[0]) && Number.isFinite(m[1]) && m[0] > 0 && m[1] > 0 ? m : undefined;
}

/** Circumcentre and squared circumradius; undefined for a (numerically) collinear triple. */
function circumcircle(a: P2, b: P2, c: P2): { p: P2; r2: number } | undefined {
  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const cx = c[0] - a[0];
  const cy = c[1] - a[1];
  const d = 2 * (bx * cy - by * cx);
  if (d === 0) return undefined;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ox = (cy * b2 - by * c2) / d;
  const oy = (bx * c2 - cx * b2) / d;
  const p: P2 = [a[0] + ox, a[1] + oy];
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? { p, r2: ox * ox + oy * oy } : undefined;
}

function gap2(p: P2, q: P2): number {
  return (q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]);
}

class Refiner {
  private readonly cdt: Cdt;
  private readonly surface: Surface;
  private readonly scale: P2;
  private readonly options: TrimmedOptions;
  private readonly at = new Map<number, P3>();
  private readonly normals = new Map<number, P3 | null>();

  constructor(cdt: Cdt, surface: Surface, scale: P2, options: TrimmedOptions) {
    this.cdt = cdt;
    this.surface = surface;
    this.scale = scale;
    this.options = options;
  }

  uv(v: number): P2 {
    const p = this.cdt.point(v);
    return [p[0] / this.scale[0], p[1] / this.scale[1]];
  }

  private pointAt(v: number): P3 {
    let p = this.at.get(v);
    if (p === undefined) {
      const q = this.uv(v);
      p = surfacePoint(this.surface, q[0], q[1]);
      this.at.set(v, p);
    }
    return p;
  }

  private normalAt(v: number): P3 | null {
    let n = this.normals.get(v);
    if (n === undefined) {
      const q = this.uv(v);
      n = unitNormal(this.surface, q[0], q[1]) ?? null;
      this.normals.set(v, n);
    }
    return n;
  }

  private sagitta(a: number, b: number): number {
    const p = this.uv(a);
    const q = this.uv(b);
    const m = surfacePoint(this.surface, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    const pa = this.pointAt(a);
    const pb = this.pointAt(b);
    return dist3(m, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]);
  }

  /** Smallest interior angle of the triangle, in the metric (uv) plane where the CDT lives. */
  private minAngleOf(v: readonly [number, number, number]): number {
    const p = v.map((i) => this.cdt.point(i)) as [P2, P2, P2];
    let min = Math.PI;
    for (let k = 0; k < 3; k++) {
      const a = p[k] as P2;
      const b = p[(k + 1) % 3] as P2;
      const c = p[(k + 2) % 3] as P2;
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const wx = c[0] - a[0];
      const wy = c[1] - a[1];
      const lu = Math.sqrt(ux * ux + uy * uy);
      const lw = Math.sqrt(wx * wx + wy * wy);
      if (lu === 0 || lw === 0) return 0;
      const cos = Math.min(1, Math.max(-1, (ux * wx + uy * wy) / (lu * lw)));
      min = Math.min(min, atan2(Math.sqrt(1 - cos * cos), cos));
    }
    return min;
  }

  /**
   * Whether a triangle needs a point: an interior edge longer than one metric unit, a normal turn
   * past the angle, or a sag past the chord. Constrained (boundary) edges are fixed, so their own
   * length and sagitta raise the thresholds: refinement never chases an error that only the shared
   * edge samples could remove.
   */
  bad(t: number): boolean {
    const cdt = this.cdt;
    const v = [cdt.vertexOf(t, 0), cdt.vertexOf(t, 1), cdt.vertexOf(t, 2)] as const;
    let size = 1;
    let sag = this.options.chord ?? Infinity;
    let longest = 0;
    let turn = 0;
    for (let k = 0; k < 3; k++) {
      const a = v[k] as number;
      const b = v[(k + 1) % 3] as number;
      const length = Math.sqrt(gap2(cdt.point(a), cdt.point(b)));
      if (cdt.isConstrained(t, k)) {
        size = Math.max(size, length);
        if (sag !== Infinity) sag = Math.max(sag, this.sagitta(a, b));
        continue;
      }
      longest = Math.max(longest, length);
      const na = this.normalAt(a);
      const nb = this.normalAt(b);
      if (na !== null && nb !== null) {
        const d = Math.min(1, Math.max(-1, dot3(na, nb)));
        turn = Math.max(turn, atan2(Math.sqrt(1 - d * d), d));
      }
    }
    if (longest > size || turn > this.options.angle) return true;
    if (this.options.minAngle !== undefined && this.minAngleOf(v) < this.options.minAngle)
      return true;
    if (sag === Infinity) return false;
    const q = [this.uv(v[0]), this.uv(v[1]), this.uv(v[2])] as const;
    const m = surfacePoint(
      this.surface,
      (q[0][0] + q[1][0] + q[2][0]) / 3,
      (q[0][1] + q[1][1] + q[2][1]) / 3,
    );
    const pa = this.pointAt(v[0]);
    const pb = this.pointAt(v[1]);
    const pc = this.pointAt(v[2]);
    const flat: P3 = [
      (pa[0] + pb[0] + pc[0]) / 3,
      (pa[1] + pb[1] + pc[1]) / 3,
      (pa[2] + pb[2] + pc[2]) / 3,
    ];
    return dist3(m, flat) > sag;
  }
}

/**
 * The midpoint of t's longest unconstrained edge when that edge is long and the midpoint keeps
 * `MIN_GAP` from the four vertices of the edge's two triangles; otherwise undefined.
 */
function edgeMidpoint(cdt: Cdt, t: number): P2 | undefined {
  let best = -1;
  let length2 = 1;
  for (let k = 0; k < 3; k++) {
    if (cdt.isConstrained(t, k)) continue;
    const l = gap2(cdt.point(cdt.vertexOf(t, k)), cdt.point(cdt.vertexOf(t, k + 1)));
    if (l > length2) {
      length2 = l;
      best = k;
    }
  }
  if (best < 0) return undefined;
  const a = cdt.point(cdt.vertexOf(t, best));
  const b = cdt.point(cdt.vertexOf(t, best + 1));
  const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const n = cdt.neighbour(t, best);
  const near = [cdt.vertexOf(t, best + 2)];
  if (n >= 0) for (let k = 0; k < 3; k++) near.push(cdt.vertexOf(n, k));
  for (const v of near) if (gap2(m, cdt.point(v)) < MIN_GAP * MIN_GAP) return undefined;
  return m;
}

/**
 * Constrained Delaunay triangulation of a trimmed face in its metric-scaled (u, v), refined until
 * every triangle meets the angle / chord / size bounds or cannot be split without touching the
 * boundary. Boundary points are the shared edge samples and are never moved or split, so the face
 * meets its neighbours exactly. A refinement point is a circumcentre (an empty circle of radius at
 * least `MIN_RADIUS`, so points never crowd) or, when that would leave the region or encroach a
 * boundary segment, the midpoint of a long interior edge. Fails closed on degenerate input or at
 * the point cap.
 */
export function triangulateTrimmed(
  surface: Surface,
  rings: readonly TrimRing[],
  options: TrimmedOptions,
): TrimmedResult {
  const points: P2[] = [];
  const indices: number[][] = [];
  let lo: P2 = [Infinity, Infinity];
  let hi: P2 = [-Infinity, -Infinity];
  for (const ring of rings) {
    const index: number[] = [];
    for (const p of ring.uv) {
      index.push(points.length);
      points.push(p);
      lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
      hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
    }
    indices.push(index);
  }
  const scale = faceMetric(surface, lo, hi, options);
  if (scale === undefined) return { ok: false, error: { reason: 'non-finite-metric' } };
  const built = triangulateRings(
    points.map((p) => [p[0] * scale[0], p[1] * scale[1]] as P2),
    indices,
  );
  if (!built.ok) return { ok: false, error: { reason: built.reason, point: built.at } };
  const cdt = built.value;
  const refiner = new Refiner(cdt, surface, scale, options);
  const queue: number[] = [];
  for (let t = 0; t < cdt.triangleCount; t++) if (cdt.isInside(t)) queue.push(t);
  while (queue.length > 0) {
    const t = queue.pop() as number;
    if (!cdt.isInside(t) || !refiner.bad(t)) continue;
    if (cdt.vertexCount - CDT_FIRST_VERTEX >= options.maxPoints) {
      return { ok: false, error: { reason: 'point-cap', point: options.maxPoints } };
    }
    const a = cdt.point(cdt.vertexOf(t, 0));
    const b = cdt.point(cdt.vertexOf(t, 1));
    const c = cdt.point(cdt.vertexOf(t, 2));
    const circle = circumcircle(a, b, c);
    let r =
      circle === undefined || circle.r2 < MIN_RADIUS * MIN_RADIUS
        ? undefined
        : cdt.insertInside(circle.p, t);
    if (r === undefined || !r.ok) {
      const m = edgeMidpoint(cdt, t);
      r = m === undefined ? undefined : cdt.insertInside(m, t);
    }
    if (r === undefined || !r.ok) continue;
    for (const s of cdt.touched) queue.push(s);
  }
  const triangles = cdt.triangles();
  if (triangles.length === 0) return { ok: false, error: { reason: 'empty-region' } };
  const interior: P2[] = [];
  for (let v = CDT_FIRST_VERTEX + points.length; v < cdt.vertexCount; v++) {
    interior.push(refiner.uv(v));
  }
  return { ok: true, value: { interior, triangles } };
}
