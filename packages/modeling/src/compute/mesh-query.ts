import { atan2 } from '../dmath';
import type { Tuple3 } from '../geom';

const AXES = [0, 1, 2] as const;

/**
 * Geometric queries shared by the voxel and remesh jobs: closest points on
 * triangles, a uniform-grid triangle index, Hausdorff sampling and a truncated
 * symmetric pseudo-inverse solve. Pure IEEE arithmetic (+ - * / sqrt) and `dmath` only.
 */

export interface ClosestPoint {
  /** Squared distance from the query point. */
  readonly distance2: number;
  readonly point: Tuple3;
  /** Barycentric weights of the closest point for the triangle corners a, b, c. */
  readonly weights: Tuple3;
}

function settle(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  u: number,
  v: number,
  w: number,
  out: Float64Array | undefined,
): number {
  const qx = ax * u + bx * v + cx * w;
  const qy = ay * u + by * v + cy * w;
  const qz = az * u + bz * v + cz * w;
  if (out !== undefined) {
    out[0] = qx;
    out[1] = qy;
    out[2] = qz;
    out[3] = u;
    out[4] = v;
    out[5] = w;
  }
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Squared distance from p to triangle abc (Ericson, Real-Time Collision Detection
 * 5.1.5); `out` receives the closest point and its barycentric weights. A
 * zero-area triangle answers with its closest corner or edge.
 */
export function triangleDistance2(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out?: Float64Array,
): number {
  const ab0 = bx - ax;
  const ab1 = by - ay;
  const ab2 = bz - az;
  const ac0 = cx - ax;
  const ac1 = cy - ay;
  const ac2 = cz - az;
  const ap0 = px - ax;
  const ap1 = py - ay;
  const ap2 = pz - az;
  const d1 = ab0 * ap0 + ab1 * ap1 + ab2 * ap2;
  const d2 = ac0 * ap0 + ac1 * ap1 + ac2 * ap2;
  if (d1 <= 0 && d2 <= 0)
    return settle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, 1, 0, 0, out);
  const bp0 = px - bx;
  const bp1 = py - by;
  const bp2 = pz - bz;
  const d3 = ab0 * bp0 + ab1 * bp1 + ab2 * bp2;
  const d4 = ac0 * bp0 + ac1 * bp1 + ac2 * bp2;
  if (d3 >= 0 && d4 <= d3)
    return settle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, 0, 1, 0, out);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return settle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, 1 - v, v, 0, out);
  }
  const cp0 = px - cx;
  const cp1 = py - cy;
  const cp2 = pz - cz;
  const d5 = ab0 * cp0 + ab1 * cp1 + ab2 * cp2;
  const d6 = ac0 * cp0 + ac1 * cp1 + ac2 * cp2;
  if (d6 >= 0 && d5 <= d6)
    return settle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, 0, 0, 1, out);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return settle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, 1 - w, 0, w, out);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return settle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, 0, 1 - w, w, out);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  if (Number.isFinite(v) && Number.isFinite(w)) {
    return settle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, 1 - v - w, v, w, out);
  }
  // Zero-area triangle: the closest of its edges.
  const scratch = new Float64Array(6);
  let best = Infinity;
  for (const [ex, ey, ez, fx, fy, fz, k] of [
    [ax, ay, az, bx, by, bz, 0],
    [bx, by, bz, cx, cy, cz, 1],
    [cx, cy, cz, ax, ay, az, 2],
  ] as const) {
    const d = segmentDistance2(px, py, pz, ex, ey, ez, fx, fy, fz, scratch);
    if (d < best) {
      best = d;
      if (out !== undefined) {
        const t = scratch[4] as number;
        const weights = [0, 0, 0];
        weights[k] = 1 - t;
        weights[(k + 1) % 3] = t;
        out.set([scratch[0] as number, scratch[1] as number, scratch[2] as number, ...weights]);
      }
    }
  }
  return best;
}

/** Squared distance from p to segment ef; `out` receives the closest point and weights [1 - t, t, 0]. */
export function segmentDistance2(
  px: number,
  py: number,
  pz: number,
  ex: number,
  ey: number,
  ez: number,
  fx: number,
  fy: number,
  fz: number,
  out?: Float64Array,
): number {
  const d0 = fx - ex;
  const d1 = fy - ey;
  const d2 = fz - ez;
  const len2 = d0 * d0 + d1 * d1 + d2 * d2;
  let t = len2 > 0 ? ((px - ex) * d0 + (py - ey) * d1 + (pz - ez) * d2) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return settle(px, py, pz, ex, ey, ez, fx, fy, fz, 0, 0, 0, 1 - t, t, 0, out);
}

/** Closest point of triangle abc to p. */
export function closestOnTriangle(p: Tuple3, a: Tuple3, b: Tuple3, c: Tuple3): ClosestPoint {
  const out = new Float64Array(6);
  const distance2 = triangleDistance2(
    p[0],
    p[1],
    p[2],
    a[0],
    a[1],
    a[2],
    b[0],
    b[1],
    b[2],
    c[0],
    c[1],
    c[2],
    out,
  );
  return {
    distance2,
    point: [out[0] as number, out[1] as number, out[2] as number],
    weights: [out[3] as number, out[4] as number, out[5] as number],
  };
}

export interface IndexHit extends ClosestPoint {
  /** Index of the primitive (triangle or segment) in the index's order. */
  readonly index: number;
}

/**
 * Uniform grid over triangles (or segments: repeat the second point as the third),
 * each stored in every cell its bounding box overlaps. `closest` searches rings of
 * cells outward, skipping cells farther than the best hit, until no closer
 * primitive can exist; ties keep the lower index.
 */
export class PrimitiveGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly min: Tuple3;
  private readonly cell: number;
  private readonly dims: Tuple3;
  private readonly mark: Int32Array;
  private query = 0;
  private readonly scratch = new Float64Array(6);
  private readonly best = new Float64Array(6);
  readonly count: number;

  private readonly points: Float64Array;
  /** Three point indices per primitive; a segment repeats its second point. */
  private readonly corners: Int32Array;

  constructor(points: Float64Array, corners: Int32Array, cellSize?: number) {
    this.points = points;
    this.corners = corners;
    this.count = corners.length / 3;
    this.mark = new Int32Array(this.count);
    const min: Tuple3 = [Infinity, Infinity, Infinity];
    const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
    let extent = 0;
    for (let t = 0; t < this.count; t++) {
      const lo: Tuple3 = [Infinity, Infinity, Infinity];
      const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 3; k++) {
        const v = corners[t * 3 + k] as number;
        for (const d of AXES) {
          const x = points[v * 3 + d] as number;
          if (x < lo[d]) lo[d] = x;
          if (x > hi[d]) hi[d] = x;
        }
      }
      extent += Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      for (const d of AXES) {
        if (lo[d] < min[d]) min[d] = lo[d];
        if (hi[d] > max[d]) max[d] = hi[d];
      }
    }
    if (this.count === 0) {
      this.min = [0, 0, 0];
      this.cell = 1;
      this.dims = [1, 1, 1];
      return;
    }
    const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-12);
    // About one primitive across a cell, at most 160 cells per axis.
    this.cell = Math.max(cellSize ?? extent / this.count, span / 160, 1e-12);
    this.min = min;
    this.dims = AXES.map((d) =>
      Math.max(1, Math.floor((max[d] - min[d]) / this.cell) + 1),
    ) as Tuple3;
    for (let t = 0; t < this.count; t++) {
      const lo: Tuple3 = [0, 0, 0];
      const hi: Tuple3 = [0, 0, 0];
      for (const d of AXES) {
        let a = Infinity;
        let b = -Infinity;
        for (let k = 0; k < 3; k++) {
          const x = points[(corners[t * 3 + k] as number) * 3 + d] as number;
          if (x < a) a = x;
          if (x > b) b = x;
        }
        lo[d] = this.clampCell(d, Math.floor((a - min[d]) / this.cell));
        hi[d] = this.clampCell(d, Math.floor((b - min[d]) / this.cell));
      }
      for (let z = lo[2]; z <= hi[2]; z++) {
        for (let y = lo[1]; y <= hi[1]; y++) {
          for (let x = lo[0]; x <= hi[0]; x++) {
            const key = this.key(x, y, z);
            const list = this.cells.get(key);
            if (list === undefined) this.cells.set(key, [t]);
            else list.push(t);
          }
        }
      }
    }
  }

  private clampCell(d: 0 | 1 | 2, i: number): number {
    const n = this.dims[d];
    return i < 0 ? 0 : i >= n ? n - 1 : i;
  }

  private key(x: number, y: number, z: number): number {
    return x + this.dims[0] * (y + this.dims[1] * z);
  }

  /** Corner point indices of primitive t. */
  primitive(t: number): [number, number, number] {
    return [
      this.corners[t * 3] as number,
      this.corners[t * 3 + 1] as number,
      this.corners[t * 3 + 2] as number,
    ];
  }

  private distance2(t: number, px: number, py: number, pz: number, out: Float64Array): number {
    const pts = this.points;
    const a = (this.corners[t * 3] as number) * 3;
    const b = (this.corners[t * 3 + 1] as number) * 3;
    const c = (this.corners[t * 3 + 2] as number) * 3;
    if (b === c) {
      return segmentDistance2(
        px,
        py,
        pz,
        pts[a] as number,
        pts[a + 1] as number,
        pts[a + 2] as number,
        pts[b] as number,
        pts[b + 1] as number,
        pts[b + 2] as number,
        out,
      );
    }
    return triangleDistance2(
      px,
      py,
      pz,
      pts[a] as number,
      pts[a + 1] as number,
      pts[a + 2] as number,
      pts[b] as number,
      pts[b + 1] as number,
      pts[b + 2] as number,
      pts[c] as number,
      pts[c + 1] as number,
      pts[c + 2] as number,
      out,
    );
  }

  /** Primitives in the cells that the box around p with half-size `radius` overlaps, ascending. */
  near(p: Tuple3, radius: number): number[] {
    if (this.count === 0) return [];
    this.query++;
    const query = this.query;
    const lo = AXES.map((d) =>
      this.clampCell(d, Math.floor((p[d] - radius - this.min[d]) / this.cell)),
    ) as Tuple3;
    const hi = AXES.map((d) =>
      this.clampCell(d, Math.floor((p[d] + radius - this.min[d]) / this.cell)),
    ) as Tuple3;
    const out: number[] = [];
    for (let z = lo[2]; z <= hi[2]; z++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        for (let x = lo[0]; x <= hi[0]; x++) {
          for (const t of this.cells.get(this.key(x, y, z)) ?? []) {
            if (this.mark[t] === query) continue;
            this.mark[t] = query;
            out.push(t);
          }
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /**
   * Closest primitive to p among those `accept` admits, or undefined when none is
   * admitted; `visit` counts the primitives tested (work units).
   */
  closest(
    p: Tuple3,
    accept?: (t: number) => boolean,
    visit?: (n: number) => void,
  ): IndexHit | undefined {
    if (this.count === 0) return undefined;
    this.query++;
    const query = this.query;
    const h = this.cell;
    const c = AXES.map((d) => Math.floor((p[d] - this.min[d]) / h)) as Tuple3;
    let inner = Infinity;
    for (const d of AXES) {
      const f = p[d] - (this.min[d] + c[d] * h);
      inner = Math.min(inner, f, h - f);
    }
    const reach = Math.max(
      ...AXES.map((d) => Math.max(Math.abs(c[d]), Math.abs(this.dims[d] - 1 - c[d]))),
    );
    let bestD2 = Infinity;
    let bestT = -1;
    const scratch = this.scratch;
    const best = this.best;
    for (let r = 0; r <= reach; r++) {
      if (r > 0 && bestT >= 0) {
        const bound = (r - 1) * h + inner;
        if (bound * bound > bestD2) break;
      }
      let tested = 0;
      for (let z = c[2] - r; z <= c[2] + r; z++) {
        if (z < 0 || z >= this.dims[2]) continue;
        const dz = Math.max(0, this.min[2] + z * h - p[2], p[2] - (this.min[2] + (z + 1) * h));
        for (let y = c[1] - r; y <= c[1] + r; y++) {
          if (y < 0 || y >= this.dims[1]) continue;
          const dy = Math.max(0, this.min[1] + y * h - p[1], p[1] - (this.min[1] + (y + 1) * h));
          const shellYZ = Math.abs(z - c[2]) === r || Math.abs(y - c[1]) === r;
          for (let x = c[0] - r; x <= c[0] + r; x++) {
            if (x < 0 || x >= this.dims[0]) continue;
            if (!shellYZ && Math.abs(x - c[0]) !== r) continue;
            const list = this.cells.get(this.key(x, y, z));
            if (list === undefined) continue;
            const dx = Math.max(0, this.min[0] + x * h - p[0], p[0] - (this.min[0] + (x + 1) * h));
            if (dx * dx + dy * dy + dz * dz > bestD2) continue;
            for (const t of list) {
              if (this.mark[t] === query) continue;
              this.mark[t] = query;
              if (accept !== undefined && !accept(t)) continue;
              tested++;
              const d2 = this.distance2(t, p[0], p[1], p[2], scratch);
              if (d2 < bestD2 || (d2 === bestD2 && t < bestT)) {
                bestD2 = d2;
                bestT = t;
                best.set(scratch);
              }
            }
          }
        }
      }
      visit?.(tested + 1);
    }
    if (bestT < 0) return undefined;
    return {
      distance2: bestD2,
      point: [best[0] as number, best[1] as number, best[2] as number],
      weights: [best[3] as number, best[4] as number, best[5] as number],
      index: bestT,
    };
  }
}

/**
 * Parameter t in [0, 1] where segment ab crosses triangle pqr (Moller-Trumbore), or
 * undefined when it misses or runs parallel to it.
 */
export function segmentTriangle(
  a: Tuple3,
  b: Tuple3,
  p: Tuple3,
  q: Tuple3,
  r: Tuple3,
): number | undefined {
  const d: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e1: Tuple3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const e2: Tuple3 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  const h: Tuple3 = [
    d[1] * e2[2] - d[2] * e2[1],
    d[2] * e2[0] - d[0] * e2[2],
    d[0] * e2[1] - d[1] * e2[0],
  ];
  const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (det === 0) return undefined;
  const inv = 1 / det;
  const s: Tuple3 = [a[0] - p[0], a[1] - p[1], a[2] - p[2]];
  const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) * inv;
  if (u < 0 || u > 1) return undefined;
  const k: Tuple3 = [
    s[1] * e1[2] - s[2] * e1[1],
    s[2] * e1[0] - s[0] * e1[2],
    s[0] * e1[1] - s[1] * e1[0],
  ];
  const v = (d[0] * k[0] + d[1] * k[1] + d[2] * k[2]) * inv;
  if (v < 0 || u + v > 1) return undefined;
  const t = (e2[0] * k[0] + e2[1] * k[1] + e2[2] * k[2]) * inv;
  return t >= 0 && t <= 1 ? t : undefined;
}

/** Area-weighted samples of a triangle soup: corners, edge midpoints and centroids. */
export function surfaceSamples(points: Float64Array, corners: Int32Array): Tuple3[] {
  const out: Tuple3[] = [];
  const seen = new Set<number>();
  const at = (i: number): Tuple3 => [
    points[i * 3] as number,
    points[i * 3 + 1] as number,
    points[i * 3 + 2] as number,
  ];
  for (let t = 0; t < corners.length / 3; t++) {
    const tri = [corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]] as number[];
    for (const v of tri) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(at(v));
      }
    }
    const [a, b, c] = tri.map(at) as [Tuple3, Tuple3, Tuple3];
    out.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      out.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]);
    }
  }
  return out;
}

/**
 * The surface area each `surfaceSamples` sample stands for, in its order: a quarter of its
 * triangle for the centroid and each edge midpoint, zero for corners.
 */
export function surfaceSampleAreas(points: Float64Array, corners: Int32Array): Float64Array {
  const out: number[] = [];
  const seen = new Set<number>();
  for (let t = 0; t < corners.length / 3; t++) {
    const [a, b, c] = [corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]] as number[] as [
      number,
      number,
      number,
    ];
    for (const v of [a, b, c])
      if (!seen.has(v)) {
        seen.add(v);
        out.push(0);
      }
    const e1 = [0, 1, 2].map((k) => (points[b * 3 + k] as number) - (points[a * 3 + k] as number));
    const e2 = [0, 1, 2].map((k) => (points[c * 3 + k] as number) - (points[a * 3 + k] as number));
    const n = [
      (e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number),
      (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number),
      (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number),
    ] as Tuple3;
    const quarter = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) / 8;
    out.push(quarter, quarter, quarter, quarter);
  }
  return Float64Array.from(out);
}

/**
 * The soup with every triangle split into n x n similar triangles on a lattice of its own
 * points, n = ceil(longest edge / spacing): samples of the result lie at most about
 * spacing / 2 apart.
 */
export function refineSoup(soup: Soup, spacing: number): Soup {
  const points: number[] = [];
  const corners: number[] = [];
  const p = soup.points;
  for (let t = 0; t < soup.corners.length / 3; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => soup.corners[t * 3 + k] as number) as [
      number,
      number,
      number,
    ];
    const at = (v: number, k: number) => p[v * 3 + k] as number;
    const edge = (u: number, v: number) => {
      const d = [0, 1, 2].map((k) => at(v, k) - at(u, k)) as Tuple3;
      return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    };
    const n = Math.max(1, Math.ceil(Math.max(edge(a, b), edge(b, c), edge(c, a)) / spacing));
    const base = points.length / 3;
    const index = (i: number, j: number) => base + (i * (2 * n + 3 - i)) / 2 + j;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n - i; j++)
        for (let k = 0; k < 3; k++)
          points.push(at(a, k) + ((at(b, k) - at(a, k)) * i) / n + ((at(c, k) - at(a, k)) * j) / n);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n - i; j++) {
        corners.push(index(i, j), index(i + 1, j), index(i, j + 1));
        if (j + 1 < n - i) corners.push(index(i + 1, j), index(i + 1, j + 1), index(i, j + 1));
      }
  }
  return { points: Float64Array.from(points), corners: Int32Array.from(corners) };
}

export interface Soup {
  readonly points: Float64Array;
  readonly corners: Int32Array;
}

export interface SampledDistances {
  /** `surfaceSamples(from)`, in its order. */
  readonly samples: Tuple3[];
  /** Unsigned distance from each sample to `to`; NaN when no triangle of `to` is found. */
  readonly distance: Float64Array;
  /** Triangle of `to` holding the closest point; -1 when none. */
  readonly closest: Int32Array;
  /** Closest point on `to`, 3 per sample (NaN when none). */
  readonly point: Float64Array;
  /** Barycentric weights of the closest point on its triangle, 3 per sample (NaN when none). */
  readonly weights: Float64Array;
}

/**
 * One-sided sampled distance from the surface `from` to the surface `to`: every
 * sample of `from` (corners, edge midpoints, centroids) with its closest point on
 * `to`. The single distance owner for Hausdorff, coverage and signed deviation.
 */
export function sampleDistances(
  from: Soup,
  to: Soup,
  visit?: (n: number) => void,
): SampledDistances {
  const grid = new PrimitiveGrid(to.points, to.corners);
  const samples = surfaceSamples(from.points, from.corners);
  const distance = new Float64Array(samples.length).fill(Number.NaN);
  const closest = new Int32Array(samples.length).fill(-1);
  const point = new Float64Array(samples.length * 3).fill(Number.NaN);
  const weights = new Float64Array(samples.length * 3).fill(Number.NaN);
  for (let i = 0; i < samples.length; i++) {
    const hit = grid.closest(samples[i] as Tuple3, undefined, visit);
    if (hit === undefined) continue;
    distance[i] = Math.sqrt(hit.distance2);
    closest[i] = hit.index;
    point[i * 3] = hit.point[0];
    point[i * 3 + 1] = hit.point[1];
    point[i * 3 + 2] = hit.point[2];
    weights.set(hit.weights, i * 3);
  }
  return { samples, distance, closest, point, weights };
}

/**
 * Two-sided sampled Hausdorff distance between two triangle soups: the largest
 * distance from a sample of either surface to the other surface, plus the mean of
 * both directions.
 */
export function hausdorff(
  a: Soup,
  b: Soup,
  visit?: (n: number) => void,
): { readonly max: number; readonly mean: number } {
  let max = 0;
  let sum = 0;
  let n = 0;
  for (const { distance } of [sampleDistances(a, b, visit), sampleDistances(b, a, visit)]) {
    for (const d of distance) {
      if (Number.isNaN(d)) continue;
      if (d > max) max = d;
      sum += d;
      n++;
    }
  }
  return { max, mean: n === 0 ? 0 : sum / n };
}

export interface SideDeviation {
  /** Largest distance of a sample on this side. */
  readonly max: number;
  /** Area-weighted 95th percentile over all samples, zero for those on the other side. */
  readonly p95: number;
}

/**
 * One-sided deviation of the surface `from` from the closed, outward-oriented surface `to`,
 * split by side: `inside` measures samples below `to`, `outside` above it. The side is the
 * sign along the angle-weighted pseudo-normal of the closest feature (face, edge or vertex),
 * so a sample off a sharp edge or corner keeps its true side.
 * Edges and vertices are shared through `to`'s point indices; an unwelded soup signs by
 * the closest face alone.
 */
export function signedDeviation(
  from: Soup,
  to: Soup,
): { readonly inside: SideDeviation; readonly outside: SideDeviation } {
  const normals = new PseudoNormals(to);
  const sampled = sampleDistances(from, to);
  const area = surfaceSampleAreas(from.points, from.corners);
  const n = sampled.samples.length;
  const inside = new Float64Array(n);
  const outside = new Float64Array(n);
  const max = [0, 0];
  for (let i = 0; i < n; i++) {
    const d = sampled.distance[i] as number;
    if (!(d > 0)) continue;
    const s = sampled.samples[i] as Tuple3;
    const q = [0, 1, 2].map((k) => sampled.point[i * 3 + k] as number) as Tuple3;
    const w = [0, 1, 2].map((k) => sampled.weights[i * 3 + k] as number) as Tuple3;
    const m = normals.at(sampled.closest[i] as number, w);
    const side = (s[0] - q[0]) * m[0] + (s[1] - q[1]) * m[1] + (s[2] - q[2]) * m[2] < 0 ? 0 : 1;
    (side === 0 ? inside : outside)[i] = d;
    if (d > (max[side] as number)) max[side] = d;
  }
  const p95 = (values: Float64Array) => {
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => (values[a] as number) - (values[b] as number) || a - b,
    );
    let total = 0;
    for (const a of area) total += a;
    let acc = 0;
    for (const i of order) {
      acc += area[i] as number;
      if (acc >= 0.95 * total) return values[i] as number;
    }
    return 0;
  };
  return {
    inside: { max: max[0] as number, p95: p95(inside) },
    outside: { max: max[1] as number, p95: p95(outside) },
  };
}

/** A barycentric weight at most this is zero: the closest point lies on the opposite edge. */
const ON_FEATURE = 1e-9;

/** Angle-weighted pseudo-normals of a soup's faces, edges and vertices. */
class PseudoNormals {
  private readonly face: Float64Array;
  private readonly vertex: Float64Array;
  private readonly edge = new Map<number, Tuple3>();
  private readonly corners: Int32Array;
  private readonly count: number;

  constructor(soup: Soup) {
    const { points, corners } = soup;
    this.corners = corners;
    this.count = points.length / 3;
    const triangles = corners.length / 3;
    this.face = new Float64Array(triangles * 3);
    this.vertex = new Float64Array(points.length);
    const at = (v: number): Tuple3 => [
      points[v * 3] as number,
      points[v * 3 + 1] as number,
      points[v * 3 + 2] as number,
    ];
    for (let t = 0; t < triangles; t++) {
      const v = [0, 1, 2].map((k) => corners[t * 3 + k] as number);
      const p = v.map(at);
      const nrm = unit(
        cross(sub3(p[1] as Tuple3, p[0] as Tuple3), sub3(p[2] as Tuple3, p[0] as Tuple3)),
      );
      this.face.set(nrm, t * 3);
      for (let k = 0; k < 3; k++) {
        const o = p[k] as Tuple3;
        const e1 = sub3(p[(k + 1) % 3] as Tuple3, o);
        const e2 = sub3(p[(k + 2) % 3] as Tuple3, o);
        const c = cross(e1, e2);
        const angle = atan2(
          Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]),
          e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2],
        );
        const vi = v[k] as number;
        for (let d = 0; d < 3; d++)
          this.vertex[vi * 3 + d] =
            (this.vertex[vi * 3 + d] as number) + angle * (nrm[d] as number);
        const key = this.key(v[(k + 1) % 3] as number, v[(k + 2) % 3] as number);
        const sum = this.edge.get(key) ?? [0, 0, 0];
        this.edge.set(key, [sum[0] + nrm[0], sum[1] + nrm[1], sum[2] + nrm[2]]);
      }
    }
  }

  /** Pseudo-normal (unnormalized) at the point of triangle t with barycentric weights w. */
  at(t: number, w: Tuple3): Tuple3 {
    const zero = w.map((x) => x <= ON_FEATURE);
    const zeros = zero.filter(Boolean).length;
    const v = (k: number) => this.corners[t * 3 + k] as number;
    if (zeros >= 2) {
      const k = zero.indexOf(false);
      const vi = v(k < 0 ? 0 : k);
      return [
        this.vertex[vi * 3] as number,
        this.vertex[vi * 3 + 1] as number,
        this.vertex[vi * 3 + 2] as number,
      ];
    }
    if (zeros === 1) {
      const k = zero.indexOf(true);
      const e = this.edge.get(this.key(v((k + 1) % 3), v((k + 2) % 3)));
      if (e !== undefined) return e;
    }
    return [
      this.face[t * 3] as number,
      this.face[t * 3 + 1] as number,
      this.face[t * 3 + 2] as number,
    ];
  }

  private key(a: number, b: number): number {
    return a < b ? a * this.count + b : b * this.count + a;
  }
}

function sub3(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(a: Tuple3): Tuple3 {
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** Signed volume of a closed triangle soup with outward orientation. */
export function soupVolume(points: Float64Array, corners: Int32Array): number {
  let volume = 0;
  for (let t = 0; t < corners.length / 3; t++) {
    const a = (corners[t * 3] as number) * 3;
    const b = (corners[t * 3 + 1] as number) * 3;
    const c = (corners[t * 3 + 2] as number) * 3;
    const ax = points[a] as number;
    const ay = points[a + 1] as number;
    const az = points[a + 2] as number;
    const bx = points[b] as number;
    const by = points[b + 1] as number;
    const bz = points[b + 2] as number;
    const cx = points[c] as number;
    const cy = points[c + 1] as number;
    const cz = points[c + 2] as number;
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

/**
 * Solve the symmetric system A x = b (n x n, row-major) in the least-squares sense
 * with a truncated eigen-decomposition (cyclic Jacobi): eigenvalues below
 * `relativeCutoff` times the largest are dropped, so rank-deficient systems return
 * the minimum-norm solution. Returns the solution and the rank kept.
 */
export function solveSymmetric(
  n: number,
  matrix: ArrayLike<number>,
  rhs: ArrayLike<number>,
  relativeCutoff: number,
): { readonly x: number[]; readonly rank: number } {
  const a = Array.from(matrix, (v) => v as number);
  const v: number[] = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    let diag = 0;
    for (let p = 0; p < n; p++) {
      diag += Math.abs(a[p * n + p] as number);
      for (let q = p + 1; q < n; q++) off += Math.abs(a[p * n + q] as number);
    }
    if (off <= 1e-15 * diag || off < 1e-300) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q] as number;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = ((a[q * n + q] as number) - (a[p * n + p] as number)) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p] as number;
          const akq = a[k * n + q] as number;
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k] as number;
          const aqk = a[q * n + k] as number;
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p] as number;
          const vkq = v[k * n + q] as number;
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let largest = 0;
  for (let k = 0; k < n; k++) largest = Math.max(largest, Math.abs(a[k * n + k] as number));
  const cutoff = largest * relativeCutoff;
  const x: number[] = new Array(n).fill(0);
  let rank = 0;
  for (let k = 0; k < n; k++) {
    const lambda = a[k * n + k] as number;
    if (Math.abs(lambda) <= cutoff || lambda === 0) continue;
    rank++;
    let proj = 0;
    for (let i = 0; i < n; i++) proj += (v[i * n + k] as number) * (rhs[i] as number);
    const coefficient = proj / lambda;
    for (let i = 0; i < n; i++) x[i] = (x[i] as number) + coefficient * (v[i * n + k] as number);
  }
  return { x, rank };
}
