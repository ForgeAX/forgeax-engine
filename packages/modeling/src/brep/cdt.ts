import { orient2d } from '../predicates';
import type { P2 } from './vec';

/** 2^-53, the unit roundoff of f64. */
const EPSILON = 1.1102230246251565e-16;
/** Shewchuk's first-stage incircle error bound (Robust Adaptive Floating-Point Geometric Predicates, 1997). */
const ICC_ERR_BOUND = (10 + 96 * EPSILON) * EPSILON;

/**
 * Positive when `d` lies certainly inside the circle through the counter-clockwise `a, b, c`, 0 when the
 * float filter cannot decide. A flip taken only on a certain sign is an exact Delaunay improvement, so
 * Lawson flipping terminates; an undecided pair is left as it is (a near-cocircular, valid triangulation).
 */
export function incircleCertain(a: P2, b: P2, c: P2, d: P2): number {
  const adx = a[0] - d[0];
  const ady = a[1] - d[1];
  const bdx = b[0] - d[0];
  const bdy = b[1] - d[1];
  const cdx = c[0] - d[0];
  const cdy = c[1] - d[1];
  const bdxcdy = bdx * cdy;
  const cdxbdy = cdx * bdy;
  const cdxady = cdx * ady;
  const adxcdy = adx * cdy;
  const adxbdy = adx * bdy;
  const bdxady = bdx * ady;
  const alift = adx * adx + ady * ady;
  const blift = bdx * bdx + bdy * bdy;
  const clift = cdx * cdx + cdy * cdy;
  const det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
  const permanent =
    (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * alift +
    (Math.abs(cdxady) + Math.abs(adxcdy)) * blift +
    (Math.abs(adxbdy) + Math.abs(bdxady)) * clift;
  return Math.abs(det) > ICC_ERR_BOUND * permanent ? det : 0;
}

/** Why a constrained triangulation could not be built; the caller reports it as a partial model. */
export type CdtFailure =
  | 'duplicate-point'
  | 'point-outside'
  | 'point-on-constraint'
  | 'vertex-on-segment'
  | 'segments-cross'
  | 'recovery-limit'
  | 'point-cap';

export type CdtResult<T> = { ok: true; value: T } | { ok: false; reason: CdtFailure; at: number };

const SUPER = 3;
const WALK_LIMIT = 4096;

function okv<T>(value: T): CdtResult<T> {
  return { ok: true, value };
}

function no<T>(reason: CdtFailure, at: number): CdtResult<T> {
  return { ok: false, reason, at };
}

/**
 * Constrained Delaunay triangulation in the plane. Triangles are stored as vertex triples with
 * per-edge neighbours (edge k of triangle t joins vertices k and k+1; its neighbour shares it reversed)
 * and per-edge constraint flags. Vertices 0..2 form an enclosing super triangle; user vertices start at
 * 3. Orientation is exact (`orient2d`); incircle flips are taken only on a certain sign.
 */
export class Cdt {
  readonly xs: number[] = [];
  readonly ys: number[] = [];
  private readonly tv: number[] = [];
  private readonly tn: number[] = [];
  private readonly tc: number[] = [];
  /** Region parity per triangle after `classify`: 1 inside the constraints, 0 outside. */
  private readonly region: number[] = [];
  private readonly vt: number[] = [];
  private last = 0;
  /** Triangles changed by the latest operation (split or flip), for incremental refinement. */
  readonly touched: number[] = [];

  /** An empty triangulation whose super triangle encloses the box with a wide margin. */
  constructor(lo: P2, hi: P2) {
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-12);
    const cx = (lo[0] + hi[0]) / 2;
    const cy = (lo[1] + hi[1]) / 2;
    this.addVertex(cx - 64 * span, cy - 32 * span);
    this.addVertex(cx + 64 * span, cy - 32 * span);
    this.addVertex(cx, cy + 64 * span);
    this.setTri(0, 0, 1, 2, -1, -1, -1, 0, 0, 0);
  }

  get vertexCount(): number {
    return this.xs.length;
  }

  get triangleCount(): number {
    return this.tv.length / 3;
  }

  point(v: number): P2 {
    return [this.xs[v] as number, this.ys[v] as number];
  }

  vertexOf(t: number, k: number): number {
    return this.tv[3 * t + (k % 3)] as number;
  }

  neighbour(t: number, k: number): number {
    return this.tn[3 * t + (k % 3)] as number;
  }

  isConstrained(t: number, k: number): boolean {
    return this.tc[3 * t + (k % 3)] === 1;
  }

  isInside(t: number): boolean {
    return this.region[t] === 1;
  }

  private addVertex(x: number, y: number): number {
    this.xs.push(x);
    this.ys.push(y);
    this.vt.push(-1);
    return this.xs.length - 1;
  }

  private orient(a: number, b: number, c: number): number {
    return orient2d(
      this.xs[a] as number,
      this.ys[a] as number,
      this.xs[b] as number,
      this.ys[b] as number,
      this.xs[c] as number,
      this.ys[c] as number,
    );
  }

  private orientP(a: number, b: number, p: P2): number {
    return orient2d(
      this.xs[a] as number,
      this.ys[a] as number,
      this.xs[b] as number,
      this.ys[b] as number,
      p[0],
      p[1],
    );
  }

  private setTri(
    t: number,
    a: number,
    b: number,
    c: number,
    n0: number,
    n1: number,
    n2: number,
    c0: number,
    c1: number,
    c2: number,
  ): void {
    const o = 3 * t;
    this.tv[o] = a;
    this.tv[o + 1] = b;
    this.tv[o + 2] = c;
    this.tn[o] = n0;
    this.tn[o + 1] = n1;
    this.tn[o + 2] = n2;
    this.tc[o] = c0;
    this.tc[o + 1] = c1;
    this.tc[o + 2] = c2;
    if (this.region[t] === undefined) this.region[t] = 0;
    this.vt[a] = t;
    this.vt[b] = t;
    this.vt[c] = t;
    this.touched.push(t);
  }

  /** Points the neighbour `n` (which holds edge b -> a) back at `t`. */
  private relink(n: number, a: number, b: number, t: number): void {
    if (n < 0) return;
    for (let k = 0; k < 3; k++) {
      if (this.vertexOf(n, k) === b && this.vertexOf(n, k + 1) === a) {
        this.tn[3 * n + k] = t;
        return;
      }
    }
  }

  private edgeIndex(t: number, a: number, b: number): number {
    for (let k = 0; k < 3; k++) {
      if (this.vertexOf(t, k) === a && this.vertexOf(t, k + 1) === b) return k;
    }
    return -1;
  }

  /** Finds the triangle and slot holding the directed edge a -> b, rotating around a. */
  private findEdge(a: number, b: number): { t: number; k: number } | undefined {
    const start = this.vt[a] as number;
    let t = start;
    for (let guard = 0; guard < 4096 && t >= 0; guard++) {
      const i = [0, 1, 2].find((k) => this.vertexOf(t, k) === a) as number;
      if (this.vertexOf(t, i + 1) === b) return { t, k: i };
      t = this.neighbour(t, i + 2);
      if (t === start) break;
    }
    // A vertex on the super-triangle hull has an open fan; rotate the other way to cover it.
    t = start;
    for (let guard = 0; guard < 4096 && t >= 0; guard++) {
      const i = [0, 1, 2].find((k) => this.vertexOf(t, k) === a) as number;
      if (this.vertexOf(t, i + 1) === b) return { t, k: i };
      t = this.neighbour(t, i);
      if (t === start) break;
    }
    return undefined;
  }

  /** Triangle containing `p` (on its boundary allowed): a remembering visibility walk, then a scan. */
  private locate(p: P2, from: number): { t: number; zeros: number[] } | undefined {
    let t = from;
    for (let step = 0; step < WALK_LIMIT; step++) {
      let moved = false;
      const zeros: number[] = [];
      for (let j = 0; j < 3; j++) {
        const k = (j + step) % 3;
        const o = this.orientP(this.vertexOf(t, k), this.vertexOf(t, k + 1), p);
        if (o < 0) {
          const n = this.neighbour(t, k);
          if (n < 0) return undefined;
          t = n;
          moved = true;
          break;
        }
        if (o === 0) zeros.push(k);
      }
      if (!moved) return { t, zeros };
    }
    for (let s = 0; s < this.triangleCount; s++) {
      const zeros: number[] = [];
      let inside = true;
      for (let k = 0; k < 3 && inside; k++) {
        const o = this.orientP(this.vertexOf(s, k), this.vertexOf(s, k + 1), p);
        if (o < 0) inside = false;
        else if (o === 0) zeros.push(k);
      }
      if (inside) return { t: s, zeros };
    }
    return undefined;
  }

  /** Inserts `p` and restores the (constrained) Delaunay property around it. */
  insert(p: P2, from = this.last): CdtResult<number> {
    return this.insertWhere(p, from, false);
  }

  /** Inserts `p` only when it lies in an inside triangle (after `classify`); refinement never leaves the region. */
  insertInside(p: P2, from = this.last): CdtResult<number> {
    return this.insertWhere(p, from, true);
  }

  private insertWhere(p: P2, from: number, inside: boolean): CdtResult<number> {
    const at = this.xs.length;
    if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]))) return no('point-outside', at);
    const loc = this.locate(p, from < this.triangleCount ? from : 0);
    if (loc === undefined) return no('point-outside', at);
    if (inside && !this.isInside(loc.t)) return no('point-outside', at);
    if (inside && this.encroaches(loc.t, p)) return no('point-on-constraint', at);
    if (loc.zeros.length >= 2) return no('duplicate-point', at);
    const edge = loc.zeros[0];
    if (edge !== undefined) {
      if (this.isConstrained(loc.t, edge)) return no('point-on-constraint', at);
      if (this.neighbour(loc.t, edge) < 0) return no('point-outside', at);
      if (inside && !this.isInside(this.neighbour(loc.t, edge))) return no('point-outside', at);
    }
    this.touched.length = 0;
    const v = this.addVertex(p[0], p[1]);
    const stack: [number, number][] = [];
    if (edge === undefined) this.split3(loc.t, v, this.region[loc.t] as number, stack);
    else this.splitEdge(loc.t, edge, v, stack);
    this.legalize(stack);
    this.last = this.vt[v] as number;
    return okv(v);
  }

  /**
   * Whether `p` lies inside the diametral circle of a constrained edge of t or of its neighbours.
   * Boundary segments are never split, so a refinement point there could only start a cascade of
   * ever thinner triangles against the segment (Ruppert 1995 splits the segment instead).
   */
  private encroaches(t: number, p: P2): boolean {
    const near = [t, this.neighbour(t, 0), this.neighbour(t, 1), this.neighbour(t, 2)];
    for (const s of near) {
      if (s < 0) continue;
      for (let k = 0; k < 3; k++) {
        if (!this.isConstrained(s, k)) continue;
        const a = this.point(this.vertexOf(s, k));
        const b = this.point(this.vertexOf(s, k + 1));
        if ((a[0] - p[0]) * (b[0] - p[0]) + (a[1] - p[1]) * (b[1] - p[1]) < 0) return true;
      }
    }
    return false;
  }

  private split3(t: number, p: number, inside: number, stack: [number, number][]): void {
    const [a, b, c] = [this.vertexOf(t, 0), this.vertexOf(t, 1), this.vertexOf(t, 2)];
    const [n0, n1, n2] = [this.neighbour(t, 0), this.neighbour(t, 1), this.neighbour(t, 2)];
    const [c0, c1, c2] = [this.tc[3 * t], this.tc[3 * t + 1], this.tc[3 * t + 2]] as number[];
    const t1 = this.triangleCount;
    const t2 = t1 + 1;
    this.region[t1] = inside;
    this.region[t2] = inside;
    this.setTri(t, a, b, p, n0, t1, t2, c0 as number, 0, 0);
    this.setTri(t1, b, c, p, n1, t2, t, c1 as number, 0, 0);
    this.setTri(t2, c, a, p, n2, t, t1, c2 as number, 0, 0);
    this.relink(n1, b, c, t1);
    this.relink(n2, c, a, t2);
    stack.push([t, 0], [t1, 0], [t2, 0]);
  }

  private splitEdge(t: number, k: number, p: number, stack: [number, number][]): void {
    const a = this.vertexOf(t, k);
    const b = this.vertexOf(t, k + 1);
    const c = this.vertexOf(t, k + 2);
    const u = this.neighbour(t, k);
    const j = this.edgeIndex(u, b, a);
    const d = this.vertexOf(u, j + 2);
    const nbc = this.neighbour(t, k + 1);
    const nca = this.neighbour(t, k + 2);
    const fbc = this.tc[3 * t + ((k + 1) % 3)] as number;
    const fca = this.tc[3 * t + ((k + 2) % 3)] as number;
    const nad = this.neighbour(u, j + 1);
    const ndb = this.neighbour(u, j + 2);
    const fad = this.tc[3 * u + ((j + 1) % 3)] as number;
    const fdb = this.tc[3 * u + ((j + 2) % 3)] as number;
    const t1 = this.triangleCount;
    const t3 = t1 + 1;
    this.region[t1] = this.region[t] as number;
    this.region[t3] = this.region[u] as number;
    this.setTri(t, a, p, c, t3, t1, nca, 0, 0, fca);
    this.setTri(t1, p, b, c, u, nbc, t, 0, fbc, 0);
    this.setTri(u, b, p, d, t1, t3, ndb, 0, 0, fdb);
    this.setTri(t3, p, a, d, t, nad, u, 0, fad, 0);
    this.relink(nbc, b, c, t1);
    this.relink(nad, a, d, t3);
    stack.push([t, 2], [t1, 1], [u, 2], [t3, 1]);
  }

  /** Flips edge k of t (a -> b, apex c) with its neighbour (apex d) into the diagonal c - d. */
  private flip(t: number, k: number): { t: number; u: number; c: number; d: number } {
    const a = this.vertexOf(t, k);
    const b = this.vertexOf(t, k + 1);
    const c = this.vertexOf(t, k + 2);
    const u = this.neighbour(t, k);
    const j = this.edgeIndex(u, b, a);
    const d = this.vertexOf(u, j + 2);
    const nbc = this.neighbour(t, k + 1);
    const nca = this.neighbour(t, k + 2);
    const fbc = this.tc[3 * t + ((k + 1) % 3)] as number;
    const fca = this.tc[3 * t + ((k + 2) % 3)] as number;
    const nad = this.neighbour(u, j + 1);
    const ndb = this.neighbour(u, j + 2);
    const fad = this.tc[3 * u + ((j + 1) % 3)] as number;
    const fdb = this.tc[3 * u + ((j + 2) % 3)] as number;
    this.setTri(t, a, d, c, nad, u, nca, fad, 0, fca);
    this.setTri(u, d, b, c, ndb, nbc, t, fdb, fbc, 0);
    this.relink(nad, a, d, t);
    this.relink(nbc, b, c, u);
    return { t, u, c, d };
  }

  /** Lawson flips over (triangle, edge) pairs whose apex is the vertex just inserted. */
  private legalize(stack: [number, number][]): void {
    let guard = 0;
    while (stack.length > 0 && guard++ < 1 << 22) {
      const [t, k] = stack.pop() as [number, number];
      if (this.isConstrained(t, k)) continue;
      const u = this.neighbour(t, k);
      if (u < 0) continue;
      const a = this.vertexOf(t, k);
      const b = this.vertexOf(t, k + 1);
      const c = this.vertexOf(t, k + 2);
      const j = this.edgeIndex(u, b, a);
      if (j < 0) continue;
      const d = this.vertexOf(u, j + 2);
      if (incircleCertain(this.point(a), this.point(b), this.point(c), this.point(d)) <= 0) {
        continue;
      }
      this.flip(t, k);
      // After the flip t = (a, d, c) and u = (d, b, c): their outer edges face the apex c.
      stack.push([t, 0], [u, 0]);
    }
  }

  /**
   * Makes a -> b an edge and marks it constrained (Sloan 1993: flip the crossing edges while their
   * quadrilateral is strictly convex, then restore Delaunay on the new edges that do not cross).
   */
  constrain(a: number, b: number): CdtResult<void> {
    const crossing = this.crossings(a, b);
    if (!crossing.ok) return crossing;
    const queue = crossing.value;
    const fresh: [number, number][] = [];
    let guard = 0;
    const limit = 64 + 32 * queue.length * queue.length;
    while (queue.length > 0) {
      if (guard++ > limit) return no('recovery-limit', a);
      const [u, v] = queue.shift() as [number, number];
      const e = this.findEdge(u, v);
      if (e === undefined) return no('recovery-limit', a);
      const c = this.vertexOf(e.t, e.k + 2);
      const n = this.neighbour(e.t, e.k);
      const d = this.vertexOf(n, this.edgeIndex(n, v, u) + 2);
      const su = Math.sign(this.orient(c, d, u));
      const sv = Math.sign(this.orient(c, d, v));
      if (su * sv >= 0) {
        queue.push([u, v]);
        continue;
      }
      this.flip(e.t, e.k);
      const sc = Math.sign(this.orient(a, b, c));
      const sd = Math.sign(this.orient(a, b, d));
      if (sc * sd < 0) queue.push([c, d]);
      else fresh.push([c, d]);
    }
    const e = this.findEdge(a, b);
    if (e === undefined) return no('recovery-limit', a);
    this.markConstrained(e.t, e.k);
    let changed = true;
    for (let pass = 0; changed && pass < 64; pass++) {
      changed = false;
      for (const [c, d] of fresh) {
        const f = this.findEdge(c, d);
        if (f === undefined || this.isConstrained(f.t, f.k)) continue;
        const n = this.neighbour(f.t, f.k);
        if (n < 0) continue;
        const apex = this.vertexOf(f.t, f.k + 2);
        const opp = this.vertexOf(n, this.edgeIndex(n, d, c) + 2);
        if (incircleCertain(this.point(c), this.point(d), this.point(apex), this.point(opp)) > 0) {
          const r = this.flip(f.t, f.k);
          const stack: [number, number][] = [];
          for (const t of [r.t, r.u]) for (let k = 0; k < 3; k++) stack.push([t, k]);
          this.legalize(stack);
          changed = true;
        }
      }
    }
    return okv(undefined);
  }

  private markConstrained(t: number, k: number): void {
    this.tc[3 * t + k] = 1;
    const n = this.neighbour(t, k);
    if (n >= 0) {
      const j = this.edgeIndex(n, this.vertexOf(t, k + 1), this.vertexOf(t, k));
      if (j >= 0) this.tc[3 * n + j] = 1;
    }
  }

  /** Edges crossed by the open segment a -> b, each stored with its right end first. */
  private crossings(a: number, b: number): CdtResult<[number, number][]> {
    const out: [number, number][] = [];
    const start = this.vt[a] as number;
    let t = start;
    let found: [number, number] | undefined;
    for (let guard = 0; guard < 4096; guard++) {
      const i = [0, 1, 2].find((k) => this.vertexOf(t, k) === a) as number;
      const p = this.vertexOf(t, i + 1);
      const q = this.vertexOf(t, i + 2);
      if (p === b || q === b) return okv([]);
      const op = this.orient(a, p, b);
      const oq = this.orient(a, b, q);
      if (op === 0 && this.ahead(a, p, b)) return no('vertex-on-segment', p);
      if (op > 0 && oq > 0) {
        found = [p, q];
        break;
      }
      t = this.neighbour(t, i + 2);
      if (t < 0 || t === start) break;
    }
    if (found === undefined) return no('vertex-on-segment', a);
    let [p, q] = found;
    for (let guard = 0; guard < 1 << 20; guard++) {
      const e = this.findEdge(p, q);
      if (e === undefined) return no('recovery-limit', a);
      if (this.isConstrained(e.t, e.k)) return no('segments-cross', a);
      out.push([p, q]);
      const n = this.neighbour(e.t, e.k);
      if (n < 0) return no('recovery-limit', a);
      const r = this.vertexOf(n, this.edgeIndex(n, q, p) + 2);
      if (r === b) return okv(out);
      const o = this.orient(a, b, r);
      if (o === 0) return no('vertex-on-segment', r);
      if (o > 0) q = r;
      else p = r;
    }
    return no('recovery-limit', a);
  }

  /** Whether `p` lies on the ray a -> b before b (the caller knows a, p, b are collinear). */
  private ahead(a: number, p: number, b: number): boolean {
    const dx = (this.xs[b] as number) - (this.xs[a] as number);
    const dy = (this.ys[b] as number) - (this.ys[a] as number);
    const px = (this.xs[p] as number) - (this.xs[a] as number);
    const py = (this.ys[p] as number) - (this.ys[a] as number);
    const t = px * dx + py * dy;
    return t > 0 && t < dx * dx + dy * dy;
  }

  /**
   * Region parity by flood fill from the super triangle: crossing a constrained edge toggles it, so
   * triangles inside an outer loop and outside its holes get 1.
   */
  classify(): void {
    const level: number[] = new Array(this.triangleCount).fill(-1);
    let frontier = [this.vt[0] as number];
    level[frontier[0] as number] = 0;
    for (let depth = 0; frontier.length > 0; depth++) {
      const next: number[] = [];
      const stack = frontier.slice();
      while (stack.length > 0) {
        const t = stack.pop() as number;
        for (let k = 0; k < 3; k++) {
          const n = this.neighbour(t, k);
          if (n < 0 || level[n] !== -1) continue;
          if (this.isConstrained(t, k)) {
            next.push(n);
            continue;
          }
          level[n] = depth;
          stack.push(n);
        }
      }
      frontier = [];
      for (const n of next) {
        if (level[n] !== -1) continue;
        level[n] = depth + 1;
        frontier.push(n);
      }
    }
    for (let t = 0; t < this.triangleCount; t++) {
      const touchesSuper = [0, 1, 2].some((k) => this.vertexOf(t, k) < SUPER);
      this.region[t] = !touchesSuper && ((level[t] as number) & 1) === 1 ? 1 : 0;
    }
  }

  /** Inside triangles as counter-clockwise triples of user vertex indices (vertex - 3). */
  triangles(): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let t = 0; t < this.triangleCount; t++) {
      if (!this.isInside(t)) continue;
      out.push([
        this.vertexOf(t, 0) - SUPER,
        this.vertexOf(t, 1) - SUPER,
        this.vertexOf(t, 2) - SUPER,
      ]);
    }
    return out;
  }
}

/** Builds the constrained triangulation of closed rings (indices into `points`, each closed implicitly). */
export function triangulateRings(
  points: readonly P2[],
  rings: readonly (readonly number[])[],
): CdtResult<Cdt> {
  let lo: P2 = [Infinity, Infinity];
  let hi: P2 = [-Infinity, -Infinity];
  for (const p of points) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
  }
  const cdt = new Cdt(lo, hi);
  for (let i = 0; i < points.length; i++) {
    const r = cdt.insert(points[i] as P2);
    if (!r.ok) return no(r.reason, i);
  }
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = (ring[i] as number) + SUPER;
      const b = (ring[(i + 1) % ring.length] as number) + SUPER;
      const r = cdt.constrain(a, b);
      if (!r.ok) return no(r.reason, ring[i] as number);
    }
  }
  cdt.classify();
  return okv(cdt);
}

/** Offset of user vertex indices in a `Cdt` (the three super-triangle vertices come first). */
export const CDT_FIRST_VERTEX = SUPER;
