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
 * @internal Build option: `median` uses equal-count median splits instead of SAH (used by SAH benchmarks).
 */
export interface BvhOptions {
  readonly median?: boolean;
}

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
  /** Node visits since construction, for the job's work meter. */
  visits = 0;

  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;

  constructor(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    /** @internal Tree build options (see `BvhOptions`). */
    options: BvhOptions = {},
  ) {
    this.positions = positions;
    this.indices = indices;
    const median = options.median === true;
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
    const binCounts = new Int32Array(BINS);
    const binBoxes = new Float64Array(BINS * 6);
    const rightArea = new Float64Array(BINS);
    const rightCount = new Int32Array(BINS);
    const partScratch = new Int32Array(triangles);
    const areaOf = (
      x0: number,
      y0: number,
      z0: number,
      x1: number,
      y1: number,
      z1: number,
    ): number => {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      return dx * dy + dy * dz + dz * dx;
    };
    /**
     * Best binned SAH split of order[start, end): partitions the slice in place (stable,
     * so ties keep triangle order) and returns the first right index, or undefined when
     * no bin boundary separates the centroids.
     */
    const sahSplit = (start: number, end: number, cb: readonly number[]): number | undefined => {
      let bestCost = Infinity;
      let bestAxis = -1;
      let bestBin = -1;
      for (let axis = 0; axis < 3; axis++) {
        const cLo = cb[axis] as number;
        const extent = (cb[axis + 3] as number) - cLo;
        if (!(extent > 0)) continue;
        const invExtent = BINS / extent;
        binCounts.fill(0);
        for (let b = 0; b < BINS; b++) {
          const o = b * 6;
          binBoxes[o] = Infinity;
          binBoxes[o + 1] = Infinity;
          binBoxes[o + 2] = Infinity;
          binBoxes[o + 3] = -Infinity;
          binBoxes[o + 4] = -Infinity;
          binBoxes[o + 5] = -Infinity;
        }
        for (let i = start; i < end; i++) {
          const t = order[i] as number;
          const b = Math.min(
            BINS - 1,
            Math.floor(((centroid[t * 3 + axis] as number) - cLo) * invExtent),
          );
          binCounts[b] = (binCounts[b] as number) + 1;
          const o = b * 6;
          const t3 = t * 3;
          const lx = lo[t3] as number;
          const ly = lo[t3 + 1] as number;
          const lz = lo[t3 + 2] as number;
          const hx = hi[t3] as number;
          const hy = hi[t3 + 1] as number;
          const hz = hi[t3 + 2] as number;
          if (lx < (binBoxes[o] as number)) binBoxes[o] = lx;
          if (ly < (binBoxes[o + 1] as number)) binBoxes[o + 1] = ly;
          if (lz < (binBoxes[o + 2] as number)) binBoxes[o + 2] = lz;
          if (hx > (binBoxes[o + 3] as number)) binBoxes[o + 3] = hx;
          if (hy > (binBoxes[o + 4] as number)) binBoxes[o + 4] = hy;
          if (hz > (binBoxes[o + 5] as number)) binBoxes[o + 5] = hz;
        }
        let ax0 = Infinity,
          ay0 = Infinity,
          az0 = Infinity,
          ax1 = -Infinity,
          ay1 = -Infinity,
          az1 = -Infinity;
        let n = 0;
        for (let b = BINS - 1; b > 0; b--) {
          const o = b * 6;
          if ((binBoxes[o] as number) < ax0) ax0 = binBoxes[o] as number;
          if ((binBoxes[o + 1] as number) < ay0) ay0 = binBoxes[o + 1] as number;
          if ((binBoxes[o + 2] as number) < az0) az0 = binBoxes[o + 2] as number;
          if ((binBoxes[o + 3] as number) > ax1) ax1 = binBoxes[o + 3] as number;
          if ((binBoxes[o + 4] as number) > ay1) ay1 = binBoxes[o + 4] as number;
          if ((binBoxes[o + 5] as number) > az1) az1 = binBoxes[o + 5] as number;
          n += binCounts[b] as number;
          rightArea[b] = n > 0 ? areaOf(ax0, ay0, az0, ax1, ay1, az1) : 0;
          rightCount[b] = n;
        }
        let lx0 = Infinity,
          ly0 = Infinity,
          lz0 = Infinity,
          lx1 = -Infinity,
          ly1 = -Infinity,
          lz1 = -Infinity;
        let m = 0;
        for (let b = 1; b < BINS; b++) {
          const o = (b - 1) * 6;
          if ((binBoxes[o] as number) < lx0) lx0 = binBoxes[o] as number;
          if ((binBoxes[o + 1] as number) < ly0) ly0 = binBoxes[o + 1] as number;
          if ((binBoxes[o + 2] as number) < lz0) lz0 = binBoxes[o + 2] as number;
          if ((binBoxes[o + 3] as number) > lx1) lx1 = binBoxes[o + 3] as number;
          if ((binBoxes[o + 4] as number) > ly1) ly1 = binBoxes[o + 4] as number;
          if ((binBoxes[o + 5] as number) > lz1) lz1 = binBoxes[o + 5] as number;
          m += binCounts[b - 1] as number;
          const r = rightCount[b] as number;
          if (m === 0 || r === 0) continue;
          const cost = areaOf(lx0, ly0, lz0, lx1, ly1, lz1) * m + (rightArea[b] as number) * r;
          if (cost < bestCost) {
            bestCost = cost;
            bestAxis = axis;
            bestBin = b;
          }
        }
      }
      if (bestAxis < 0) return undefined;
      const cLo = cb[bestAxis] as number;
      const invExtent = BINS / ((cb[bestAxis + 3] as number) - cLo);
      let leftLen = 0;
      for (let i = start; i < end; i++) {
        const t = order[i] as number;
        const b = Math.min(
          BINS - 1,
          Math.floor(((centroid[t * 3 + bestAxis] as number) - cLo) * invExtent),
        );
        if (b < bestBin) partScratch[leftLen++] = t;
      }
      let rightPos = leftLen;
      for (let i = start; i < end; i++) {
        const t = order[i] as number;
        const b = Math.min(
          BINS - 1,
          Math.floor(((centroid[t * 3 + bestAxis] as number) - cLo) * invExtent),
        );
        if (b >= bestBin) partScratch[rightPos++] = t;
      }
      order.set(partScratch.subarray(0, end - start), start);
      return start + leftLen;
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
    const pad =
      BOX_PAD *
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

  /** @internal Stackless preorder for a device-side occlusion query. */
  _appendOcclusionTree(nodes: number[], triangles: number[]): number {
    if (this.order.length === 0) return -1;
    const visit = (node: number) => {
      const record = nodes.length;
      for (let c = 0; c < 3; c++) nodes.push(this.box[node * 6 + c] as number);
      nodes.push(0);
      for (let c = 3; c < 6; c++) nodes.push(this.box[node * 6 + c] as number);
      nodes.push(0);
      const child = this.child[node] as number;
      if (child < 0) {
        nodes[record + 3] = -(triangles.length / 12) - 1;
        const start = -1 - child;
        const count = this.count[node] as number;
        for (let i = start; i < start + count; i++) {
          const t = this.order[i] as number;
          for (let k = 0; k < 3; k++) {
            for (let c = 0; c < 3; c++) {
              const a = this.corner(t, 0, c);
              triangles.push(k === 0 ? a : this.corner(t, k, c) - a);
            }
            triangles.push(0);
          }
        }
        nodes[record + 7] = (nodes.length / 8) * 16 + count;
      } else {
        visit(child);
        visit(child + 1);
        nodes[record + 7] = (nodes.length / 8) * 16;
      }
    };
    const root = nodes.length / 8;
    visit(0);
    return root;
  }

  /**
   * @internal Stackless preorder for GPU correspondence + AO raycasting.
   * Node layout (32 bytes): low(f32x3), first(i32), high(f32x3), endAndCount(u32).
   * Tri layout (64 bytes): a(f32x3), triId(u32), e1(f32x3), flags(u32), e2(f32x3), slot(u32), faceN(f32x3), pad(u32).
   * Normal layout (48 bytes): n0(f32x3), 0, n1(f32x3), 0, n2(f32x3), 0.
   */
  _appendBakeTree(
    nodesF32: number[],
    nodesI32Mask: number[],
    trisF32: number[],
    trisU32: number[],
    triNormals: number[],
    globalMap: ArrayLike<number>,
    detail: {
      readonly normal: Float32Array;
      readonly indices: Uint32Array;
      readonly triangleSlot: Int32Array;
    },
    faceNormal: Float64Array,
    floater: Uint8Array,
    stray: Uint8Array,
  ): number {
    if (this.order.length === 0) return -1;
    const visit = (node: number) => {
      const record = nodesF32.length;
      for (let c = 0; c < 3; c++) nodesF32.push(this.box[node * 6 + c] as number);
      nodesF32.push(0);
      for (let c = 3; c < 6; c++) nodesF32.push(this.box[node * 6 + c] as number);
      nodesF32.push(0);
      const child = this.child[node] as number;
      if (child < 0) {
        const triStart = trisF32.length / 16;
        nodesI32Mask.push(record + 3, -triStart - 1);
        const start = -1 - child;
        const count = this.count[node] as number;
        for (let i = start; i < start + count; i++) {
          const local = this.order[i] as number;
          const gt = globalMap[local] as number;
          const ax = this.corner(local, 0, 0);
          const ay = this.corner(local, 0, 1);
          const az = this.corner(local, 0, 2);
          const e1x = this.corner(local, 1, 0) - ax;
          const e1y = this.corner(local, 1, 1) - ay;
          const e1z = this.corner(local, 1, 2) - az;
          const e2x = this.corner(local, 2, 0) - ax;
          const e2y = this.corner(local, 2, 1) - ay;
          const e2z = this.corner(local, 2, 2) - az;
          const baseIdx = trisF32.length;
          const fl = ((floater[gt] ?? 0) & 1) | (((stray[gt] ?? 0) & 1) << 1);
          const slot = detail.triangleSlot[gt] ?? 0;
          trisF32.push(
            ax,
            ay,
            az,
            0,
            e1x,
            e1y,
            e1z,
            0,
            e2x,
            e2y,
            e2z,
            0,
            faceNormal[gt * 3] as number,
            faceNormal[gt * 3 + 1] as number,
            faceNormal[gt * 3 + 2] as number,
            0,
          );
          trisU32.push(baseIdx + 3, gt >>> 0, baseIdx + 7, fl >>> 0, baseIdx + 11, slot >>> 0);
          for (let k = 0; k < 3; k++) {
            const vi = (detail.indices[gt * 3 + k] as number) * 3;
            triNormals.push(
              detail.normal[vi] as number,
              detail.normal[vi + 1] as number,
              detail.normal[vi + 2] as number,
              0,
            );
          }
        }
        nodesI32Mask.push(record + 7, (nodesF32.length / 8) * 16 + count);
      } else {
        visit(child);
        visit(child + 1);
        nodesI32Mask.push(record + 7, (nodesF32.length / 8) * 16);
      }
    };
    const root = nodesF32.length / 8;
    visit(0);
    return root;
  }

  private corner(t: number, k: number, c: number): number {
    return this.positions[(this.indices[t * 3 + k] as number) * 3 + c] as number;
  }

  /** Entry distance of a ray into a node box, or Infinity. */
  private slab(node: number, o: readonly number[], inv: readonly number[], tmax: number): number {
    let near = 0;
    // Conservative by a rounding margin: a box whose computed entry lands a few ulps past
    // the closest hit so far is still visited, so the result never depends on the tree.
    let far = Number.isFinite(tmax) ? tmax + tmax * PRUNE_SLACK + PRUNE_SLACK : tmax;
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

  /** Moller-Trumbore, both sides; t in [0, tmax] (or (minT, tmax] when minT is set). */
  private intersect(
    t: number,
    o: readonly number[],
    d: readonly number[],
    tmax: number,
    minT?: number,
  ) {
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
    if (!(hit <= tmax && (minT === undefined ? hit >= 0 : hit > minT))) return undefined;
    // A ray almost in the triangle's plane gets a hit distance from round-off; a hit point
    // outside the triangle's box is that, and dropping it keeps every result inside every
    // box that holds the triangle, so the tree never decides it.
    for (let c = 0; c < 3; c++) {
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

  /** Closest hit within [0, tmax] (or (minT, tmax]) among accepted triangles, or the first hit found when `any` is set. */
  raycast(
    o: readonly number[],
    d: readonly number[],
    tmax: number,
    any = false,
    accept?: (triangle: number) => boolean,
    minT?: number,
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
          const hit = this.intersect(t, o, d, limit, minT);
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
  private closest(t: number, px: number, py: number, pz: number): NearestPoint {
    const pos = this.positions;
    const idx = this.indices;
    const i0 = (idx[t * 3] as number) * 3;
    const i1 = (idx[t * 3 + 1] as number) * 3;
    const i2 = (idx[t * 3 + 2] as number) * 3;
    const ax = pos[i0] as number;
    const ay = pos[i0 + 1] as number;
    const az = pos[i0 + 2] as number;
    const abx = (pos[i1] as number) - ax;
    const aby = (pos[i1 + 1] as number) - ay;
    const abz = (pos[i1 + 2] as number) - az;
    const acx = (pos[i2] as number) - ax;
    const acy = (pos[i2 + 1] as number) - ay;
    const acz = (pos[i2 + 2] as number) - az;
    const apx = px - ax;
    const apy = py - ay;
    const apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let u = 0;
    let v = 0;
    if (d1 <= 0 && d2 <= 0) {
      u = 0;
      v = 0;
    } else {
      const bpx = px - (ax + abx);
      const bpy = py - (ay + aby);
      const bpz = pz - (az + abz);
      const d3 = abx * bpx + aby * bpy + abz * bpz;
      const d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) {
        u = 1;
        v = 0;
      } else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          u = d1 / (d1 - d3);
          v = 0;
        } else {
          const cpx = px - (ax + acx);
          const cpy = py - (ay + acy);
          const cpz = pz - (az + acz);
          const d5 = abx * cpx + aby * cpy + abz * cpz;
          const d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) {
            u = 0;
            v = 1;
          } else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) {
              u = 0;
              v = d2 / (d2 - d6);
            } else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
                u = 1 - w;
                v = w;
              } else {
                const denom = va + vb + vc;
                if (denom > 0) {
                  u = vb / denom;
                  v = vc / denom;
                }
              }
            }
          }
        }
      }
    }
    const qx = ax + u * abx + v * acx - px;
    const qy = ay + u * aby + v * acy - py;
    const qz = az + u * abz + v * acz - pz;
    return { triangle: t, u, v, distanceSquared: qx * qx + qy * qy + qz * qz };
  }

  /** The nearest surface point to p among accepted triangles. */
  nearest(p: readonly number[], accept?: (triangle: number) => boolean): NearestPoint | undefined {
    if (this.order.length === 0 || !finite3(p)) return undefined;
    const px = p[0] as number;
    const py = p[1] as number;
    const pz = p[2] as number;
    let best: NearestPoint | undefined;
    let bestD2 = Infinity;
    let bestTri = -1;
    const stackNode = new Int32Array(128);
    const stackDist = new Float64Array(128);
    let sp = 1;
    stackNode[0] = 0;
    stackDist[0] = this.boxDistance(0, p);
    const slack = PRUNE_SLACK;
    while (sp > 0) {
      sp--;
      const node = stackNode[sp] as number;
      const distance = stackDist[sp] as number;
      this.visits++;
      if (best !== undefined && distance > bestD2 + bestD2 * slack + slack) continue;
      const c = this.child[node] as number;
      if (c < 0) {
        const start = -1 - c;
        const end = start + (this.count[node] as number);
        for (let i = start; i < end; i++) {
          const t = this.order[i] as number;
          if (accept !== undefined && !accept(t)) continue;
          const q = this.closest(t, px, py, pz);
          if (
            best === undefined ||
            q.distanceSquared < bestD2 ||
            (q.distanceSquared === bestD2 && t < bestTri)
          ) {
            best = q;
            bestD2 = q.distanceSquared;
            bestTri = t;
          }
        }
        continue;
      }
      const a = this.boxDistance(c, p);
      const b = this.boxDistance(c + 1, p);
      if (a <= b) {
        stackNode[sp] = c + 1;
        stackDist[sp] = b;
        sp++;
        stackNode[sp] = c;
        stackDist[sp] = a;
        sp++;
      } else {
        stackNode[sp] = c;
        stackDist[sp] = a;
        sp++;
        stackNode[sp] = c + 1;
        stackDist[sp] = b;
        sp++;
      }
    }
    return best;
  }
}
