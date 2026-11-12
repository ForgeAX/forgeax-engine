/**
 * Triangle bounding volume hierarchy of the bake job (design 4.1 `bake` baseline):
 * binned surface area heuristic splits (16 bins per axis), at most
 * four triangles per leaf,
 * closest and any hit ray queries (both triangle sides) and nearest-point queries.
 * Closest hits and nearest points break ties by triangle index, so query results do not
 * depend on the tree. Arithmetic is plain float64, so queries are deterministic in every
 * realm.
 */
const LEAF = 4;
/**
 * @internal Build and hit rules of a tree. The default is SAH splits with exact hits (a hit
 * outside its triangle's box is near-parallel round-off and is dropped), so results do not
 * depend on the tree. `median` builds the old median tree; `exactHits: false` keeps the
 * round-off hits.
 */
export interface BvhOptions {
  readonly median?: boolean;
  readonly exactHits?: boolean;
}

/**
 * @internal The tree shrinkwrap and layer queries were tuned on (median splits,
 * round-off hits kept): their outputs stay byte-identical. The bake and the shut-line gauge use
 * the default.
 */
export const LEGACY_BVH: BvhOptions = { median: true, exactHits: false };

/** Box growth over the root diagonal (plus one meter): far above `EDGE_SLACK` times an edge. */
const BOX_PAD = 1e-8;
/** Relative and absolute slack of node pruning against rounding (see `slab`). */
const PRUNE_SLACK = 1e-9;
/** SAH bins per axis. */
const BINS = 16;
/** Tree depth past which splits are median splits. */
const SAH_DEPTH = 48;

/** Barycentric slack so rays through a shared edge or vertex hit one of its triangles. */
const EDGE_SLACK = 1e-9;

export interface RayHit {
  readonly triangle: number;
  readonly t: number;
  /** Barycentric weights of the triangle's second and third vertex. */
  readonly u: number;
  readonly v: number;
}

export interface NearestPoint {
  readonly triangle: number;
  readonly u: number;
  readonly v: number;
  readonly distanceSquared: number;
}

const finite3 = (v: readonly number[]) =>
  Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

export class TriangleBvh {
  /** Node boxes: six values per node (min xyz, max xyz). */
  private readonly box: Float64Array;
  /** Inner nodes: left child (right = left + 1) ; leaves: -1 - first triangle slot. */
  private readonly child: Int32Array;
  private readonly count: Uint8Array;
  private readonly order: Int32Array;
  /** Margin the boxes grow by; hits must lie within it of their triangle's box. */
  private readonly pad: number = 0;
  private readonly exactHits: boolean;
  /** Pruning safety margin (0 on the legacy tree). */
  private readonly slack: number;
  /** Node visits since construction, for the job's work meter. */
  visits = 0;

  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;

  constructor(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    /** @internal Tree and hit rules other than the default (see `LEGACY_BVH`). */
    options: BvhOptions = {},
  ) {
    this.positions = positions;
    this.indices = indices;
    const median = options.median === true;
    this.exactHits = options.exactHits !== false;
    this.slack = this.exactHits ? PRUNE_SLACK : 0;
    const triangles = indices.length / 3;
    const vertices = positions.length / 3;
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i] as number;
      if (!(Number.isInteger(v) && v >= 0 && v < vertices)) {
        throw new RangeError(`triangle index ${i} is ${v}, outside the ${vertices} positions`);
      }
    }
    for (let i = 0; i < positions.length; i++) {
      if (!Number.isFinite(positions[i])) {
        throw new RangeError(`position value ${i} is not finite`);
      }
    }
    const centroid = new Float64Array(triangles * 3);
    const lo = new Float64Array(triangles * 3);
    const hi = new Float64Array(triangles * 3);
    for (let t = 0; t < triangles; t++) {
      for (let c = 0; c < 3; c++) {
        let a = Infinity;
        let b = -Infinity;
        for (let k = 0; k < 3; k++) {
          const x = positions[(indices[t * 3 + k] as number) * 3 + c] as number;
          a = Math.min(a, x);
          b = Math.max(b, x);
        }
        lo[t * 3 + c] = a;
        hi[t * 3 + c] = b;
        centroid[t * 3 + c] = (a + b) / 2;
      }
    }
    const order = Int32Array.from({ length: triangles }, (_, i) => i);
    /**
     * Best binned SAH split of order[start, end): partitions the slice in place (stable,
     * so ties keep triangle order) and returns the first right index, or undefined when
     * no bin boundary separates the centroids.
     */
    const sahSplit = (start: number, end: number, cb: readonly number[]): number | undefined => {
      let best: { cost: number; axis: number; bin: number } | undefined;
      const binOf = (t: number, axis: number) => {
        const lo = cb[axis] as number;
        const extent = (cb[axis + 3] as number) - lo;
        return Math.min(
          BINS - 1,
          Math.floor((((centroid[t * 3 + axis] as number) - lo) / extent) * BINS),
        );
      };
      for (let axis = 0; axis < 3; axis++) {
        if (!((cb[axis + 3] as number) - (cb[axis] as number) > 0)) continue;
        const count = new Int32Array(BINS);
        const box = Array.from({ length: BINS }, () => [
          Infinity,
          Infinity,
          Infinity,
          -Infinity,
          -Infinity,
          -Infinity,
        ]);
        for (let i = start; i < end; i++) {
          const t = order[i] as number;
          const b = binOf(t, axis);
          count[b] = (count[b] as number) + 1;
          const bb = box[b] as number[];
          for (let c = 0; c < 3; c++) {
            bb[c] = Math.min(bb[c] as number, lo[t * 3 + c] as number);
            bb[c + 3] = Math.max(bb[c + 3] as number, hi[t * 3 + c] as number);
          }
        }
        const area = (b: readonly number[]) => {
          const x = (b[3] as number) - (b[0] as number);
          const y = (b[4] as number) - (b[1] as number);
          const z = (b[5] as number) - (b[2] as number);
          return x * y + y * z + z * x;
        };
        const grow = (into: number[], b: readonly number[]) => {
          for (let c = 0; c < 3; c++) {
            into[c] = Math.min(into[c] as number, b[c] as number);
            into[c + 3] = Math.max(into[c + 3] as number, b[c + 3] as number);
          }
        };
        const rightArea = new Float64Array(BINS);
        const rightCount = new Int32Array(BINS);
        const acc = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        let n = 0;
        for (let b = BINS - 1; b > 0; b--) {
          grow(acc, box[b] as number[]);
          n += count[b] as number;
          rightArea[b] = n > 0 ? area(acc) : 0;
          rightCount[b] = n;
        }
        const left = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        let m = 0;
        for (let b = 1; b < BINS; b++) {
          grow(left, box[b - 1] as number[]);
          m += count[b - 1] as number;
          const r = rightCount[b] as number;
          if (m === 0 || r === 0) continue;
          const cost = area(left) * m + (rightArea[b] as number) * r;
          if (best === undefined || cost < best.cost) best = { cost, axis, bin: b };
        }
      }
      if (best === undefined) return undefined;
      const { axis, bin } = best;
      const slice = Array.from(order.subarray(start, end));
      const left = slice.filter((t) => binOf(t, axis) < bin);
      const right = slice.filter((t) => binOf(t, axis) >= bin);
      order.set(left, start);
      order.set(right, start + left.length);
      return start + left.length;
    };
    const boxes: number[] = [];
    const children: number[] = [];
    const counts: number[] = [];
    const build = (node: number, start: number, end: number, depth: number) => {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      const cb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = start; i < end; i++) {
        const t = order[i] as number;
        for (let c = 0; c < 3; c++) {
          b[c] = Math.min(b[c] as number, lo[t * 3 + c] as number);
          b[c + 3] = Math.max(b[c + 3] as number, hi[t * 3 + c] as number);
          cb[c] = Math.min(cb[c] as number, centroid[t * 3 + c] as number);
          cb[c + 3] = Math.max(cb[c + 3] as number, centroid[t * 3 + c] as number);
        }
      }
      for (let c = 0; c < 6; c++) boxes[node * 6 + c] = b[c] as number;
      if (end - start <= LEAF) {
        children[node] = -1 - start;
        counts[node] = end - start;
        return;
      }
      // Deep chains fall back to median splits, which bound the depth by log2 of the count.
      const at = !median && depth < SAH_DEPTH ? sahSplit(start, end, cb) : undefined;
      let mid: number;
      if (at === undefined) {
        let axis = 0;
        for (let c = 1; c < 3; c++) {
          if (
            (cb[c + 3] as number) - (cb[c] as number) >
            (cb[axis + 3] as number) - (cb[axis] as number)
          )
            axis = c;
        }
        const slice = Array.from(order.subarray(start, end)).sort(
          (x, y) =>
            (centroid[x * 3 + axis] as number) - (centroid[y * 3 + axis] as number) || x - y,
        );
        order.set(slice, start);
        mid = (start + end) >> 1;
      } else {
        mid = at;
      }
      const left = children.length;
      children[node] = left;
      counts[node] = 0;
      children.push(0, 0);
      counts.push(0, 0);
      build(left, start, mid, depth + 1);
      build(left + 1, mid, end, depth + 1);
    };
    children.push(0);
    counts.push(0);
    if (triangles > 0) build(0, 0, triangles, 0);
    // Boxes grow by a margin above the triangle test's edge slack: a hit the slack admits just
    // outside a triangle is never culled by its (tighter or looser) box, so no tree loses it.
    const pad = !this.exactHits
      ? 0
      : BOX_PAD *
        Math.sqrt(
          [0, 1, 2].reduce((sum, c) => {
            const d = (boxes[c + 3] as number) - (boxes[c] as number) || 0;
            return sum + d * d;
          }, 0) + 1,
        );
    this.box = Float64Array.from(boxes, (v, i) => (i % 6 < 3 ? v - pad : v + pad));
    this.pad = pad;
    this.child = Int32Array.from(children);
    this.count = Uint8Array.from(counts);
    this.order = order;
  }

  get nodes(): number {
    return this.child.length;
  }

  private corner(t: number, k: number, c: number): number {
    return this.positions[(this.indices[t * 3 + k] as number) * 3 + c] as number;
  }

  /** Entry distance of a ray into a node box, or Infinity. */
  private slab(node: number, o: readonly number[], inv: readonly number[], tmax: number): number {
    let near = 0;
    // Conservative by a rounding margin: a box whose computed entry lands a few ulps past
    // the closest hit so far is still visited, so the result never depends on the tree.
    // (A legacy tree has no slack: Infinity * 0 would make an unbounded ray miss every box.)
    let far = this.slack === 0 ? tmax : tmax + tmax * this.slack + this.slack;
    for (let c = 0; c < 3; c++) {
      const lo = this.box[node * 6 + c] as number;
      const hi = this.box[node * 6 + c + 3] as number;
      const x = o[c] as number;
      if (!Number.isFinite(inv[c] as number)) {
        if (x < lo || x > hi) return Infinity;
        continue;
      }
      const a = (lo - x) * (inv[c] as number);
      const b = (hi - x) * (inv[c] as number);
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    return near <= far ? near : Infinity;
  }

  /** Moller-Trumbore, both sides; t in [0, tmax] (a ray starting on a surface hits it at 0; the legacy tree keeps (0, tmax]). */
  private intersect(t: number, o: readonly number[], d: readonly number[], tmax: number) {
    const ax = this.corner(t, 0, 0);
    const ay = this.corner(t, 0, 1);
    const az = this.corner(t, 0, 2);
    const e1 = [this.corner(t, 1, 0) - ax, this.corner(t, 1, 1) - ay, this.corner(t, 1, 2) - az];
    const e2 = [this.corner(t, 2, 0) - ax, this.corner(t, 2, 1) - ay, this.corner(t, 2, 2) - az];
    const [dx, dy, dz] = d as [number, number, number];
    const px = dy * (e2[2] as number) - dz * (e2[1] as number);
    const py = dz * (e2[0] as number) - dx * (e2[2] as number);
    const pz = dx * (e2[1] as number) - dy * (e2[0] as number);
    const det = (e1[0] as number) * px + (e1[1] as number) * py + (e1[2] as number) * pz;
    if (det === 0) return undefined;
    const inv = 1 / det;
    const sx = (o[0] as number) - ax;
    const sy = (o[1] as number) - ay;
    const sz = (o[2] as number) - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < -EDGE_SLACK || u > 1 + EDGE_SLACK) return undefined;
    const qx = sy * (e1[2] as number) - sz * (e1[1] as number);
    const qy = sz * (e1[0] as number) - sx * (e1[2] as number);
    const qz = sx * (e1[1] as number) - sy * (e1[0] as number);
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -EDGE_SLACK || u + v > 1 + EDGE_SLACK) return undefined;
    const hit = ((e2[0] as number) * qx + (e2[1] as number) * qy + (e2[2] as number) * qz) * inv;
    if (!(hit <= tmax && (this.exactHits ? hit >= 0 : hit > 0))) return undefined;
    // A ray almost in the triangle's plane gets a hit distance from round-off; a hit point
    // outside the triangle's box is that, and dropping it keeps every result inside every
    // box that holds the triangle, so the tree never decides it.
    for (let c = 0; this.exactHits && c < 3; c++) {
      const x = (o[c] as number) + (d[c] as number) * hit;
      const a = this.corner(t, 0, c);
      const b = this.corner(t, 1, c);
      const e = this.corner(t, 2, c);
      if (x < Math.min(a, b, e) - this.pad || x > Math.max(a, b, e) + this.pad) return undefined;
    }
    const cu = Math.min(1, Math.max(0, u));
    const cv = Math.min(1 - cu, Math.max(0, v));
    return { t: hit === 0 ? 0 : hit, u: cu, v: cv };
  }

  /** Closest hit within (0, tmax] among accepted triangles, or the first hit found when `any` is set. */
  raycast(
    o: readonly number[],
    d: readonly number[],
    tmax: number,
    any = false,
    accept?: (triangle: number) => boolean,
  ): RayHit | undefined {
    if (this.order.length === 0) return undefined;
    const inv = [1 / (d[0] as number), 1 / (d[1] as number), 1 / (d[2] as number)];
    let best: RayHit | undefined;
    let limit = tmax;
    const stack = [0];
    while (stack.length > 0) {
      const node = stack.pop() as number;
      this.visits++;
      if (this.slab(node, o, inv, limit) === Infinity) continue;
      const c = this.child[node] as number;
      if (c < 0) {
        const start = -1 - c;
        for (let i = start; i < start + (this.count[node] as number); i++) {
          const t = this.order[i] as number;
          if (accept !== undefined && !accept(t)) continue;
          const hit = this.intersect(t, o, d, limit);
          if (hit === undefined) continue;
          if (best === undefined || hit.t < best.t || (hit.t === best.t && t < best.triangle)) {
            best = { triangle: t, ...hit };
            limit = hit.t;
          }
          if (any) return best;
        }
        continue;
      }
      const a = this.slab(c, o, inv, limit);
      const b = this.slab(c + 1, o, inv, limit);
      if (a <= b) {
        if (b !== Infinity) stack.push(c + 1);
        if (a !== Infinity) stack.push(c);
      } else {
        if (a !== Infinity) stack.push(c);
        stack.push(c + 1);
      }
    }
    return best;
  }

  private boxDistance(node: number, p: readonly number[]): number {
    let s = 0;
    for (let c = 0; c < 3; c++) {
      const x = p[c] as number;
      const a = this.box[node * 6 + c] as number;
      const b = this.box[node * 6 + c + 3] as number;
      const d = x < a ? a - x : x > b ? x - b : 0;
      s += d * d;
    }
    return s;
  }

  /** Closest point of one triangle to p (Ericson, Real-Time Collision Detection 5.1.5). */
  private closest(t: number, p: readonly number[]): NearestPoint {
    const a = [this.corner(t, 0, 0), this.corner(t, 0, 1), this.corner(t, 0, 2)];
    const b = [this.corner(t, 1, 0), this.corner(t, 1, 1), this.corner(t, 1, 2)];
    const c = [this.corner(t, 2, 0), this.corner(t, 2, 1), this.corner(t, 2, 2)];
    const sub = (x: number[], y: readonly number[]) => [
      (x[0] as number) - (y[0] as number),
      (x[1] as number) - (y[1] as number),
      (x[2] as number) - (y[2] as number),
    ];
    const dot = (x: number[], y: number[]) =>
      (x[0] as number) * (y[0] as number) +
      (x[1] as number) * (y[1] as number) +
      (x[2] as number) * (y[2] as number);
    const ab = sub(b, a);
    const ac = sub(c, a);
    const ap = sub(p as number[], a);
    const at = (u: number, v: number): NearestPoint => {
      const q = [0, 1, 2].map(
        (k) => (a[k] as number) + u * (ab[k] as number) + v * (ac[k] as number) - (p[k] as number),
      );
      return { triangle: t, u, v, distanceSquared: dot(q, q) };
    };
    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return at(0, 0);
    const bp = sub(p as number[], b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return at(1, 0);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
    const cp = sub(p as number[], c);
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return at(0, 1);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      return at(1 - w, w);
    }
    const denom = va + vb + vc;
    if (!(denom > 0)) return at(0, 0);
    return at(vb / denom, vc / denom);
  }

  /** The nearest surface point to p among accepted triangles. */
  nearest(p: readonly number[], accept?: (triangle: number) => boolean): NearestPoint | undefined {
    if (this.order.length === 0 || !finite3(p)) return undefined;
    let best: NearestPoint | undefined;
    const stack: [number, number][] = [[0, this.boxDistance(0, p)]];
    while (stack.length > 0) {
      const [node, distance] = stack.pop() as [number, number];
      this.visits++;
      if (
        best !== undefined &&
        distance > best.distanceSquared + best.distanceSquared * this.slack + this.slack
      )
        continue;
      const c = this.child[node] as number;
      if (c < 0) {
        const start = -1 - c;
        for (let i = start; i < start + (this.count[node] as number); i++) {
          const t = this.order[i] as number;
          if (accept !== undefined && !accept(t)) continue;
          const q = this.closest(t, p);
          if (
            best === undefined ||
            q.distanceSquared < best.distanceSquared ||
            (q.distanceSquared === best.distanceSquared && t < best.triangle)
          ) {
            best = q;
          }
        }
        continue;
      }
      const a = this.boxDistance(c, p);
      const b = this.boxDistance(c + 1, p);
      if (a <= b) {
        stack.push([c + 1, b], [c, a]);
      } else {
        stack.push([c, a], [c + 1, b]);
      }
    }
    return best;
  }
}
