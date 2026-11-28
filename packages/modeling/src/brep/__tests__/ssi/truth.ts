import type { Tuple3 } from '../../../geom';
import { type NurbsSurface, surfaceDomain, surfacePoint } from '../../../nurbs';

/**
 * Ground truth of one surface pair by dense sampling, independent of any intersection algorithm:
 * the first surface (`grid`) is sampled on an `n x n` (u, v) grid, `g` is the signed function of the
 * other surface (zero on it, `undefined` outside its patch), and the zero set of `g` over the grid is
 * traced by marching squares with edge bisection on the exact functions. A branch is a connected
 * component of that zero set; seams of closed directions are identified.
 */
export interface Truth {
  readonly grid: NurbsSurface;
  readonly periodicU: boolean;
  readonly periodicV: boolean;
  g(q: Tuple3): number | undefined;
}

export interface Branch {
  readonly closed: boolean;
  /** Ordered points on the grid surface with `g = 0` to bisection accuracy; a closed branch does not repeat its first point. */
  readonly points: readonly Tuple3[];
}

interface Node {
  readonly u: number;
  readonly v: number;
  readonly neighbours: number[];
}

const BISECT = 60;

/** Branches of the intersection of the pair at sampling resolution `n`. */
export function trace(truth: Truth, n: number): Branch[] {
  const [[u0, u1], [v0, v1]] = surfaceDomain(truth.grid);
  const nu = n;
  const nv = n;
  const vertU = truth.periodicU ? nu : nu + 1;
  const vertV = truth.periodicV ? nv : nv + 1;
  const uAt = (i: number): number => u0 + ((u1 - u0) * i) / nu;
  const vAt = (j: number): number => v0 + ((v1 - v0) * j) / nv;
  const value = new Array<number | undefined>(vertU * vertV);
  for (let i = 0; i < vertU; i++) {
    for (let j = 0; j < vertV; j++) {
      value[i * vertV + j] = truth.g(surfacePoint(truth.grid, uAt(i), vAt(j)));
    }
  }
  const val = (i: number, j: number): number | undefined =>
    value[(i % vertU) * vertV + (j % vertV)];
  const positive = (x: number): boolean => x >= 0;

  const nodes: Node[] = [];
  const index = new Map<string, number>();
  const node = (horizontal: boolean, i: number, j: number): number => {
    const key = `${horizontal ? 'h' : 'v'},${i % vertU},${j % vertV}`;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length;
      index.set(key, id);
      const a = val(i, j) as number;
      const fa = (t: number): number | undefined => {
        const u = horizontal ? uAt(i) + (uAt(i + 1) - uAt(i)) * t : uAt(i);
        const v = horizontal ? vAt(j) : vAt(j) + (vAt(j + 1) - vAt(j)) * t;
        return truth.g(surfacePoint(truth.grid, u, v));
      };
      let lo = 0;
      let hi = 1;
      const loPositive = positive(a);
      for (let k = 0; k < BISECT; k++) {
        const mid = (lo + hi) / 2;
        const f = fa(mid);
        if (f !== undefined && positive(f) === loPositive) lo = mid;
        else hi = mid;
      }
      const t = (lo + hi) / 2;
      nodes.push({
        u: horizontal ? uAt(i) + (uAt(i + 1) - uAt(i)) * t : uAt(i),
        v: horizontal ? vAt(j) : vAt(j) + (vAt(j + 1) - vAt(j)) * t,
        neighbours: [],
      });
    }
    return id;
  };
  const link = (a: number, b: number): void => {
    (nodes[a] as Node).neighbours.push(b);
    (nodes[b] as Node).neighbours.push(a);
  };

  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const c00 = val(i, j);
      const c10 = val(i + 1, j);
      const c11 = val(i + 1, j + 1);
      const c01 = val(i, j + 1);
      if (c00 === undefined || c10 === undefined || c11 === undefined || c01 === undefined)
        continue;
      const s00 = positive(c00);
      const s10 = positive(c10);
      const s11 = positive(c11);
      const s01 = positive(c01);
      const bottom = s00 !== s10;
      const right = s10 !== s11;
      const top = s01 !== s11;
      const left = s00 !== s01;
      const crossings = [bottom, right, top, left].filter(Boolean).length;
      if (crossings === 0) continue;
      const B = bottom ? node(true, i, j) : -1;
      const R = right ? node(false, i + 1, j) : -1;
      const T = top ? node(true, i, j + 1) : -1;
      const L = left ? node(false, i, j) : -1;
      if (crossings === 2) {
        const ids = [B, R, T, L].filter((x) => x >= 0);
        link(ids[0] as number, ids[1] as number);
      } else {
        const centre = truth.g(
          surfacePoint(truth.grid, (uAt(i) + uAt(i + 1)) / 2, (vAt(j) + vAt(j + 1)) / 2),
        );
        const joined = centre !== undefined && positive(centre) === s00;
        if (joined) {
          link(B, R);
          link(T, L);
        } else {
          link(B, L);
          link(R, T);
        }
      }
    }
  }

  const seen = new Array<boolean>(nodes.length).fill(false);
  const branches: Branch[] = [];
  const walk = (start: number): Branch => {
    const order: number[] = [];
    let prev = -1;
    let cur = start;
    for (;;) {
      seen[cur] = true;
      order.push(cur);
      const next = (nodes[cur] as Node).neighbours.find((x) => x !== prev && !seen[x]);
      if (next === undefined) break;
      prev = cur;
      cur = next;
    }
    const first = nodes[order[0] as number] as Node;
    const last = nodes[order[order.length - 1] as number] as Node;
    const closed = first.neighbours.length === 2 && last.neighbours.includes(order[0] as number);
    return {
      closed,
      points: order.map((id) => {
        const p = nodes[id] as Node;
        return surfacePoint(truth.grid, p.u, p.v);
      }),
    };
  };
  for (let id = 0; id < nodes.length; id++) {
    if (!seen[id] && (nodes[id] as Node).neighbours.length === 1) branches.push(walk(id));
  }
  for (let id = 0; id < nodes.length; id++) {
    if (!seen[id]) branches.push(walk(id));
  }
  return branches;
}

export function arcLength(points: readonly Tuple3[], closed: boolean): number {
  let sum = 0;
  const m = points.length;
  for (let k = 0; k < (closed ? m : m - 1); k++) {
    const a = points[k] as Tuple3;
    const b = points[(k + 1) % m] as Tuple3;
    sum += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return sum;
}

/** Diagonal of the box around both control nets: the length the E3 spike measures its positional error against. */
export function diagonal(...surfaces: readonly NurbsSurface[]): number {
  const lo: Tuple3 = [Infinity, Infinity, Infinity];
  const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (const s of surfaces) {
    for (const row of s.points) {
      for (const p of row) {
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k] as number, p[k] as number);
          hi[k] = Math.max(hi[k] as number, p[k] as number);
        }
      }
    }
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

function segmentDistance(p: Tuple3, a: Tuple3, b: Tuple3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const len2 = (ab[0] as number) ** 2 + (ab[1] as number) ** 2 + (ab[2] as number) ** 2;
  const t =
    len2 === 0
      ? 0
      : Math.min(
          1,
          Math.max(
            0,
            ((ap[0] as number) * (ab[0] as number) +
              (ap[1] as number) * (ab[1] as number) +
              (ap[2] as number) * (ab[2] as number)) /
              len2,
          ),
        );
  return Math.hypot(
    p[0] - a[0] - (ab[0] as number) * t,
    p[1] - a[1] - (ab[1] as number) * t,
    p[2] - a[2] - (ab[2] as number) * t,
  );
}

/** Distance from `p` to the nearest segment of the polylines `found`. */
export function distanceToPolylines(p: Tuple3, found: readonly (readonly Tuple3[])[]): number {
  let best = Infinity;
  for (const line of found) {
    for (let k = 0; k + 1 < line.length; k++) {
      best = Math.min(best, segmentDistance(p, line[k] as Tuple3, line[k + 1] as Tuple3));
    }
  }
  return best;
}

export interface Recovery {
  readonly branches: number;
  readonly recovered: number;
  /** Largest distance from a reference point on a recovered branch to the found curves. */
  readonly maxError: number;
}

/**
 * Score curves found by an intersection algorithm against the reference branches: a branch longer
 * than `minLength` counts as recovered when every one of its points lies within `tolerance` of the
 * found polylines; `maxError` is taken over the recovered branches only.
 */
export function recovery(
  reference: readonly Branch[],
  found: readonly (readonly Tuple3[])[],
  tolerance: number,
  minLength: number,
): Recovery {
  let branches = 0;
  let recovered = 0;
  let maxError = 0;
  for (const b of reference) {
    if (arcLength(b.points, b.closed) < minLength) continue;
    branches++;
    let worst = 0;
    for (const p of b.points) worst = Math.max(worst, distanceToPolylines(p, found));
    if (worst <= tolerance) {
      recovered++;
      maxError = Math.max(maxError, worst);
    }
  }
  return { branches, recovered, maxError };
}
