import { minOf } from '../arrays';
import { hypot2 } from '../dmath';
import type { TrimRing } from './tessellate-trimmed';
import type { P2 } from './vec';

/**
 * Boundary-row front for a planar trimmed face. Each trim ring gets one layer of quads: its samples
 * stay on the boundary and an inner ring is offset into the material by a fraction of the ring's
 * shortest edge, clamped to the local clearance to other boundaries. A ring whose web is narrower
 * than two rows is skipped (it keeps its boundary and gets no row). The caller meshes the region
 * inside the inner rings with the ordinary CDT and matching.
 */

/** Offset depth as a fraction of the ring's shortest edge length. */
const ROW_DEPTH = 0.5;
/** A row may use at most this share of the clearance between its vertex and the other boundaries. */
const WEB_SHARE = 0.4;
/** Inner points must stay this fraction of their depth away from every non-incident boundary segment. */
const ROW_CLEAR = 0.5;
const EPS = 1e-12;

export type RowFrontResult =
  | {
      readonly ok: true;
      /** Inner ring per trim ring; a skipped ring repeats its boundary. */
      readonly inner: readonly (readonly P2[])[];
      /** Rings whose web is narrower than two rows; they get no row quads. */
      readonly skipped: readonly boolean[];
    }
  | { readonly ok: false };

export function rowFrontInner(rings: readonly TrimRing[]): RowFrontResult {
  const outer = rings[0];
  if (outer === undefined) return { ok: false };
  const material = (p: P2): boolean =>
    insideRing(outer.uv, p) && rings.slice(1).every((h) => !insideRing(h.uv, p));

  const depths: number[] = [];
  const clearances: number[][] = [];
  const skipped: boolean[] = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r] as TrimRing;
    const n = ring.uv.length;
    if (n < 3) return { ok: false };
    let shortest = Infinity;
    for (let k = 0; k < n; k++) {
      const len = dist(ring.uv[k] as P2, ring.uv[(k + 1) % n] as P2);
      if (len <= EPS) return { ok: false };
      shortest = Math.min(shortest, len);
    }
    const depth = ROW_DEPTH * shortest;
    const side = materialSide(ring, depth, material);
    if (side === 0) return { ok: false };
    depths.push(depth);
    const clear = ring.uv.map((_, k) => clearance(rings, r, k));
    clearances.push(clear);
    skipped.push(clear.some((c) => c < 2 * depth));
  }

  const inner: P2[][] = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r] as TrimRing;
    const n = ring.uv.length;
    if (skipped[r]) {
      inner.push(ring.uv.slice());
      continue;
    }
    const depth = depths[r] as number;
    const side = materialSide(ring, depth, material);
    const normals = ring.uv.map((_, k) =>
      edgeNormal(ring.uv[k] as P2, ring.uv[(k + 1) % n] as P2, side),
    );
    // One depth per ring keeps the row quads close to rectangles; the smallest clamped clearance sets it.
    const ringDepth = Math.min(depth, minOf((clearances[r] as number[]).map((c) => WEB_SHARE * c)));
    const points: P2[] = [];
    for (let k = 0; k < n; k++) {
      const nPrev = normals[(k + n - 1) % n] as P2;
      const nNext = normals[k] as P2;
      const sum: P2 = [nPrev[0] + nNext[0], nPrev[1] + nNext[1]];
      const len = hypot2(sum[0], sum[1]);
      const v: P2 = len <= EPS ? nNext : [sum[0] / len, sum[1] / len];
      const cos = Math.max(v[0] * nNext[0] + v[1] * nNext[1], 0.5);
      const dk = ringDepth;
      if (dk <= EPS) return { ok: false };
      const p = ring.uv[k] as P2;
      points.push([p[0] + (dk * v[0]) / cos, p[1] + (dk * v[1]) / cos]);
    }
    inner.push(points);
  }

  // Every inner point must lie in the material and clear the boundary it does not belong to.
  for (let r = 0; r < rings.length; r++) {
    if (skipped[r]) continue;
    const pts = inner[r] as P2[];
    const ring = rings[r] as TrimRing;
    for (let k = 0; k < pts.length; k++) {
      const q = pts[k] as P2;
      const dk = dist(q, ring.uv[k] as P2);
      if (!material(q)) return { ok: false };
      for (let s = 0; s < rings.length; s++) {
        const other = rings[s] as TrimRing;
        const m = other.uv.length;
        for (let j = 0; j < m; j++) {
          if (s === r && (j === k || (j + 1) % m === k)) continue;
          const d = segDist(q, other.uv[j] as P2, other.uv[(j + 1) % m] as P2);
          if (d < ROW_CLEAR * dk) return { ok: false };
        }
      }
    }
  }

  // Row quads must be convex, and the inner rings must stay simple and clear of the boundary.
  for (let r = 0; r < rings.length; r++) {
    if (skipped[r]) continue;
    const ring = rings[r] as TrimRing;
    const pts = inner[r] as P2[];
    const n = ring.uv.length;
    for (let k = 0; k < n; k++) {
      const quad = [
        ring.uv[k] as P2,
        ring.uv[(k + 1) % n] as P2,
        pts[(k + 1) % n] as P2,
        pts[k] as P2,
      ];
      if (!convexQuad(quad)) return { ok: false };
    }
  }
  const segments: { a: P2; b: P2 }[] = [];
  rings.forEach((ring, r) => {
    const n = ring.uv.length;
    const pts = inner[r] as P2[];
    for (let k = 0; k < n; k++) {
      segments.push({ a: ring.uv[k] as P2, b: ring.uv[(k + 1) % n] as P2 });
      segments.push({ a: pts[k] as P2, b: pts[(k + 1) % n] as P2 });
    }
  });
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] as { a: P2; b: P2 };
    for (let j = i + 1; j < segments.length; j++) {
      const t = segments[j] as { a: P2; b: P2 };
      if (crosses(s.a, s.b, t.a, t.b)) return { ok: false };
    }
  }
  return { ok: true, inner, skipped };
}

/** Distance from boundary vertex k of ring r to the nearest segment it does not touch. */
function clearance(rings: readonly TrimRing[], r: number, k: number): number {
  const p = (rings[r] as TrimRing).uv[k] as P2;
  let best = Infinity;
  rings.forEach((ring, s) => {
    const m = ring.uv.length;
    for (let j = 0; j < m; j++) {
      if (s === r && (j === k || (j + 1) % m === k)) continue;
      best = Math.min(best, segDist(p, ring.uv[j] as P2, ring.uv[(j + 1) % m] as P2));
    }
  });
  return best;
}

/** Sign (+1 or -1) of the edge normal that points into the material, probed on the first edge. */
function materialSide(ring: TrimRing, depth: number, material: (p: P2) => boolean): number {
  const a = ring.uv[0] as P2;
  const b = ring.uv[1] as P2;
  const n = edgeNormal(a, b, 1);
  const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const probe = 0.05 * depth;
  if (material([mid[0] + n[0] * probe, mid[1] + n[1] * probe])) return 1;
  if (material([mid[0] - n[0] * probe, mid[1] - n[1] * probe])) return -1;
  return 0;
}

function edgeNormal(a: P2, b: P2, side: number): P2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = hypot2(dx, dy) || 1;
  return [(-dy / len) * side, (dx / len) * side];
}

function convexQuad(q: readonly P2[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i] as P2;
    const b = q[(i + 1) % 4] as P2;
    const c = q[(i + 2) % 4] as P2;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) <= EPS) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function insideRing(ring: readonly P2[], p: P2): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i] as P2;
    const b = ring[j] as P2;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function dist(a: P2, b: P2): number {
  return hypot2(a[0] - b[0], a[1] - b[1]);
}

function segDist(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 <= EPS ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return hypot2(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function crosses(a: P2, b: P2, c: P2, d: P2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function orient(a: P2, b: P2, c: P2): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(v) <= EPS ? 0 : Math.sign(v);
}
