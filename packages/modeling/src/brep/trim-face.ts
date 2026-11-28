import { curvePoint, pcurvePoint } from './curves';
import { surfaceDomain, surfaceInverse } from './surfaces';
import type { TrimPeriods } from './trim';
import type { Coedge, Edge, Shape, Surface } from './types';
import { dist3, type P2, type P3 } from './vec';

/**
 * E1b step 2: classify a 3D point against the trimmed domain of one face.
 *
 * A point is `in` or `out`; it is `on` when it lies within `band` (3D) of a true boundary edge,
 * which is never guessed as either side. Seam edges (one edge used twice by the face) and
 * degenerate pole/apex edges are not boundary: crossing them stays inside the face.
 *
 * The (u, v) test is a winding number over the periodic cover against the loops' pcurves. Each
 * curved pcurve is a chord polyline; a query inside a chord's deviation lens subdivides that chord
 * on the true pcurve, so the polyline never decides a point the curve would decide differently.
 */
export type TrimClass = 'in' | 'out' | 'on';

interface Seg {
  readonly a: P2;
  readonly b: P2;
  readonly ta: number;
  readonly tb: number;
  readonly coedge: Coedge;
  readonly dev: number;
}

interface Ring {
  readonly outer: boolean;
  readonly segs: readonly Seg[];
}

interface BoundaryEdge {
  readonly edge: Edge;
  readonly lo: readonly number[];
  readonly hi: readonly number[];
}

export interface FaceTrim {
  readonly shape: Shape;
  readonly face: number;
  readonly surface: Surface;
  readonly periods: TrimPeriods;
  readonly band: number;
  readonly rings: readonly Ring[];
  readonly boundary: readonly BoundaryEdge[];
  readonly box: {
    readonly u0: number;
    readonly u1: number;
    readonly v0: number;
    readonly v1: number;
  };
}

const CURVED_SEGMENTS = 32;
const LENS_SAFETY = 2;
const MAX_REFINE = 40;
const EDGE_SAMPLES = 64;
const GOLDEN = 0.6180339887498949;
const SEARCH = 60;

function chordDistance(p: P2, a: P2, b: P2): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const l2 = ex * ex + ey * ey;
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / l2));
  const dx = p[0] - a[0] - t * ex;
  const dy = p[1] - a[1] - t * ey;
  return Math.sqrt(dx * dx + dy * dy);
}

function makeSeg(coedge: Coedge, ta: number, tb: number): Seg {
  const a = pcurvePoint(coedge.pcurve, ta);
  const b = pcurvePoint(coedge.pcurve, tb);
  if (coedge.pcurve.kind === 'line') return { a, b, ta, tb, coedge, dev: 0 };
  let dev = 0;
  for (const s of [0.25, 0.5, 0.75]) {
    dev = Math.max(dev, chordDistance(pcurvePoint(coedge.pcurve, ta + (tb - ta) * s), a, b));
  }
  const scale = Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]), 1);
  return { a, b, ta, tb, coedge, dev: LENS_SAFETY * dev + 1e-14 * scale };
}

/** The trim of face `f` of `shape`; `band` defaults to the shape tolerance. */
export function faceTrim(shape: Shape, f: number, band = shape.tol): FaceTrim {
  const face = shape.faces[f] as Shape['faces'][number];
  const surface = shape.surfaces[face.surface] as Surface;
  const dom = surfaceDomain(surface);
  const uses = new Map<number, number>();
  for (const l of face.loops) {
    for (const c of (shape.loops[l] as Shape['loops'][number]).coedges) {
      const e = (shape.coedges[c] as Coedge).edge;
      uses.set(e, (uses.get(e) ?? 0) + 1);
    }
  }
  const rings: Ring[] = [];
  const boundary: BoundaryEdge[] = [];
  const box = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
  for (const l of face.loops) {
    const loop = shape.loops[l] as Shape['loops'][number];
    const segs: Seg[] = [];
    for (const c of loop.coedges) {
      const co = shape.coedges[c] as Coedge;
      const e = shape.edges[co.edge] as Edge;
      const ta = co.reversed ? e.t1 : e.t0;
      const tb = co.reversed ? e.t0 : e.t1;
      const n = co.pcurve.kind === 'line' ? 1 : CURVED_SEGMENTS;
      for (let k = 0; k < n; k++) {
        const s = makeSeg(co, ta + ((tb - ta) * k) / n, ta + ((tb - ta) * (k + 1)) / n);
        segs.push(s);
        for (const q of [s.a, s.b]) {
          box.u0 = Math.min(box.u0, q[0] - s.dev);
          box.u1 = Math.max(box.u1, q[0] + s.dev);
          box.v0 = Math.min(box.v0, q[1] - s.dev);
          box.v1 = Math.max(box.v1, q[1] + s.dev);
        }
      }
      if (e.curve >= 0 && uses.get(co.edge) === 1 && !boundary.some((b) => b.edge === e)) {
        const pts: P3[] = [];
        for (let k = 0; k <= EDGE_SAMPLES; k++) {
          pts.push(
            curvePoint(
              shape.curves[e.curve] as Shape['curves'][number],
              e.t0 + ((e.t1 - e.t0) * k) / EDGE_SAMPLES,
            ),
          );
        }
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (const p of pts) {
          for (let i = 0; i < 3; i++) {
            lo[i] = Math.min(lo[i] as number, p[i] as number);
            hi[i] = Math.max(hi[i] as number, p[i] as number);
          }
        }
        boundary.push({ edge: e, lo, hi });
      }
    }
    rings.push({ outer: loop.outer, segs });
  }
  return {
    shape,
    face: f,
    surface,
    periods: { u: dom.uPeriod, v: dom.vPeriod },
    band,
    rings,
    boundary,
    box,
  };
}

/**
 * Ray-height tolerance for the half-open crossing rule. The same closing vertex of a periodic circle can
 * evaluate to y = 7e-17 at t = 2pi and y = 0 at t = 0; comparing exactly would count its crossing on one
 * side only, so heights within this band count as equal to the ray.
 */
const RAY_HEIGHT_EPS = 1e-11;

/** Sunday's crossing contribution of one directed segment to the winding number around `p`. */
function crossing(a: P2, b: P2, p: P2): number {
  const py = p[1] + RAY_HEIGHT_EPS;
  const side = (b[0] - a[0]) * (py - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
  if (a[1] <= py) return b[1] > py && side > 0 ? 1 : 0;
  return b[1] <= py && side < 0 ? -1 : 0;
}

/** Winding contribution of the true pcurve piece `s`, refined wherever `p` lies in its lens. */
function segWinding(s: Seg, p: P2, depth: number): number {
  if (s.dev === 0 || depth >= MAX_REFINE || chordDistance(p, s.a, s.b) > s.dev) {
    return crossing(s.a, s.b, p);
  }
  const tm = 0.5 * (s.ta + s.tb);
  return (
    segWinding(makeSeg(s.coedge, s.ta, tm), p, depth + 1) +
    segWinding(makeSeg(s.coedge, tm, s.tb), p, depth + 1)
  );
}

function shifts(x: number, lo: number, hi: number, period: number): number[] {
  if (period <= 0) return [0];
  const ks: number[] = [];
  for (let k = Math.ceil((lo - x) / period); x + k * period <= hi; k++) ks.push(k);
  return ks;
}

/** Whether (u, v), on the periodic cover, lies inside the face's loops. */
export function inFaceUv(trim: FaceTrim, uv: P2): boolean {
  const { box, periods } = trim;
  for (const ku of shifts(uv[0], box.u0, box.u1, periods.u)) {
    for (const kv of shifts(uv[1], box.v0, box.v1, periods.v)) {
      const q: P2 = [uv[0] + ku * periods.u, uv[1] + kv * periods.v];
      let outer = false;
      let hole = false;
      for (const r of trim.rings) {
        let w = 0;
        for (const s of r.segs) w += segWinding(s, q, 0);
        if (w === 0) continue;
        if (r.outer) outer = true;
        else hole = true;
      }
      if (outer && !hole) return true;
    }
  }
  return false;
}

/** Distance from `p` to the nearest boundary edge whose box is within `limit`; `limit` when none is nearer. */
export function boundaryDistance(trim: FaceTrim, p: P3, limit: number): number {
  let best = limit;
  for (const b of trim.boundary) {
    let outside = 0;
    for (let i = 0; i < 3; i++) {
      const d = Math.max(
        (b.lo[i] as number) - (p[i] as number),
        (p[i] as number) - (b.hi[i] as number),
        0,
      );
      outside = Math.max(outside, d);
    }
    if (outside >= best) continue;
    const curve = trim.shape.curves[b.edge.curve] as Shape['curves'][number];
    const at = (t: number) => dist3(curvePoint(curve, t), p);
    const { t0, t1 } = b.edge;
    let k0 = 0;
    let dk = Infinity;
    for (let k = 0; k <= EDGE_SAMPLES; k++) {
      const d = at(t0 + ((t1 - t0) * k) / EDGE_SAMPLES);
      if (d < dk) {
        dk = d;
        k0 = k;
      }
    }
    let lo = t0 + ((t1 - t0) * Math.max(0, k0 - 1)) / EDGE_SAMPLES;
    let hi = t0 + ((t1 - t0) * Math.min(EDGE_SAMPLES, k0 + 1)) / EDGE_SAMPLES;
    let x1 = hi - GOLDEN * (hi - lo);
    let x2 = lo + GOLDEN * (hi - lo);
    let f1 = at(x1);
    let f2 = at(x2);
    for (let k = 0; k < SEARCH; k++) {
      if (f1 < f2) {
        hi = x2;
        x2 = x1;
        f2 = f1;
        x1 = hi - GOLDEN * (hi - lo);
        f1 = at(x1);
      } else {
        lo = x1;
        x1 = x2;
        f1 = f2;
        x2 = lo + GOLDEN * (hi - lo);
        f2 = at(x2);
      }
    }
    best = Math.min(best, dk, f1, f2);
  }
  return best;
}

/**
 * Class of a 3D point on (or within tolerance of) the face's surface. `uv`, when given, is the
 * point's parameter on any sheet of the cover; otherwise the closest-point inverse supplies it.
 */
export function classifyOnFace(trim: FaceTrim, p: P3, uv?: P2): TrimClass {
  if (boundaryDistance(trim, p, 2 * trim.band) <= trim.band) return 'on';
  const q =
    uv ??
    (() => {
      const inv = surfaceInverse(trim.surface, p);
      return [inv.u, inv.v] as P2;
    })();
  return inFaceUv(trim, q) ? 'in' : 'out';
}
