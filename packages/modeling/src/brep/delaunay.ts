import { orient2d } from '../predicates';
import type { P2 } from './vec';

/**
 * Delaunay triangulation of `points` by Bowyer-Watson cavity insertion (Bowyer 1981; Watson 1981)
 * in a super triangle that encloses every point. Triangles are index triples into `points`, in
 * insertion order. The cost is O(n^2) in the worst case; callers bound `n`.
 */
export function delaunay(points: readonly P2[]): number[][] {
  const n = points.length;
  if (n < 3) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-12);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const all: P2[] = [
    ...points,
    [cx - 20 * span, cy - span],
    [cx, cy + 20 * span],
    [cx + 20 * span, cy - span],
  ];
  let tris: number[][] = [[n, n + 1, n + 2]];
  for (let i = 0; i < n; i++) {
    const p = all[i] as P2;
    const bad: number[][] = [];
    const keep: number[][] = [];
    for (const t of tris) {
      if (inCircumcircle(all, t, p)) bad.push(t);
      else keep.push(t);
    }
    const edges = new Map<string, [number, number, number]>();
    for (const t of bad) {
      for (let k = 0; k < 3; k++) {
        const a = t[k] as number;
        const b = t[(k + 1) % 3] as number;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [a, b, 0]);
      }
    }
    for (const [a, b] of edges.values()) keep.push([a, b, i]);
    tris = keep;
  }
  return tris.filter((t) => (t[0] as number) < n && (t[1] as number) < n && (t[2] as number) < n);
}

function inCircumcircle(all: readonly P2[], t: readonly number[], p: P2): boolean {
  const a = all[t[0] as number] as P2;
  const b = all[t[1] as number] as P2;
  const c = all[t[2] as number] as P2;
  const ax = a[0] - p[0];
  const ay = a[1] - p[1];
  const bx = b[0] - p[0];
  const by = b[1] - p[1];
  const cx = c[0] - p[0];
  const cy = c[1] - p[1];
  const det =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);
  const orient = orient2d(a[0], a[1], b[0], b[1], c[0], c[1]);
  return orient > 0 ? det > 0 : det < 0;
}
