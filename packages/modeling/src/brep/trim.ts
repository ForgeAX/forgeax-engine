import type { P2 } from './vec';

/**
 * Winding number of the closed polyline `poly` around `p` (signed crossing count; D. Sunday's
 * rule, which counts upward and downward crossings of the ray through `p`).
 */
export function windingNumber(poly: readonly P2[], p: P2): number {
  let w = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i] as P2;
    const b = poly[(i + 1) % n] as P2;
    const side = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
    if (a[1] <= p[1]) {
      if (b[1] > p[1] && side > 0) w += 1;
    } else if (b[1] <= p[1] && side < 0) {
      w -= 1;
    }
  }
  return w;
}

/** One closed trim loop in (u, v), in the periodic cover; `outer` loops bound, holes exclude. */
export interface TrimLoop {
  readonly points: readonly P2[];
  readonly outer: boolean;
}

/** Whole periods of the surface (0 = not periodic), as in `SurfaceDomain`. */
export interface TrimPeriods {
  readonly u: number;
  readonly v: number;
}

/**
 * Point-in-trim classification over the periodic cover. A point is inside when some integer
 * shift of it by the periods lies inside an outer loop (nonzero winding) and inside no hole.
 * Only shifts that can meet the loops' bounding box are tested.
 */
export function inTrim(loops: readonly TrimLoop[], p: P2, periods: TrimPeriods): boolean {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const l of loops) {
    for (const q of l.points) {
      minU = Math.min(minU, q[0]);
      maxU = Math.max(maxU, q[0]);
      minV = Math.min(minV, q[1]);
      maxV = Math.max(maxV, q[1]);
    }
  }
  const range = (x: number, lo: number, hi: number, period: number): number[] => {
    if (period <= 0) return [0];
    const ks: number[] = [];
    for (let k = Math.ceil((lo - x) / period); x + k * period <= hi; k++) ks.push(k);
    return ks;
  };
  for (const ku of range(p[0], minU, maxU, periods.u)) {
    for (const kv of range(p[1], minV, maxV, periods.v)) {
      const q: P2 = [p[0] + ku * periods.u, p[1] + kv * periods.v];
      let outer = false;
      let hole = false;
      for (const l of loops) {
        if (windingNumber(l.points, q) === 0) continue;
        if (l.outer) outer = true;
        else hole = true;
      }
      if (outer && !hole) return true;
    }
  }
  return false;
}
