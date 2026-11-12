import type { Tuple3 } from '../geom';
import { pointTriangleDistance, triangleContact } from '../intersect';

type P = readonly [number, number, number];

/** Closest distance between segments pq and rs. */
function segmentDistance(p: P, q: P, r: P, s: P): number {
  const d1: Tuple3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const d2: Tuple3 = [s[0] - r[0], s[1] - r[1], s[2] - r[2]];
  const w: Tuple3 = [p[0] - r[0], p[1] - r[1], p[2] - r[2]];
  const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
  const e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
  const f = d2[0] * w[0] + d2[1] * w[1] + d2[2] * w[2];
  let sc = 0;
  let tc = 0;
  if (a <= 0 && e <= 0) {
    sc = 0;
    tc = 0;
  } else if (a <= 0) {
    tc = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1[0] * w[0] + d1[1] * w[1] + d1[2] * w[2];
    if (e <= 0) {
      sc = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
      const denom = a * e - b * b;
      sc = denom > 0 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      tc = (b * sc + f) / e;
      if (tc < 0) {
        tc = 0;
        sc = Math.min(1, Math.max(0, -c / a));
      } else if (tc > 1) {
        tc = 1;
        sc = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const x = w[0] + d1[0] * sc - d2[0] * tc;
  const y = w[1] + d1[1] * sc - d2[1] * tc;
  const z = w[2] + d1[2] * sc - d2[2] * tc;
  return Math.sqrt(x * x + y * y + z * z);
}

/** Distance between two triangles that share no vertex (0 when they touch or cross). */
export function triangleDistance(t1: readonly P[], t2: readonly P[]): number {
  if (triangleContact(t1, t2) !== 'none') return 0;
  let d = Infinity;
  for (let i = 0; i < 3; i++) {
    d = Math.min(d, pointTriangleDistance(t1[i] as P, t2), pointTriangleDistance(t2[i] as P, t1));
    for (let j = 0; j < 3; j++) {
      d = Math.min(
        d,
        segmentDistance(t1[i] as P, t1[(i + 1) % 3] as P, t2[j] as P, t2[(j + 1) % 3] as P),
      );
    }
  }
  return d;
}

/**
 * Triangles over shared vertex positions in a uniform grid, kept current as a
 * simplification moves them: the clearance guard of `simplify` (no collapse brings a
 * triangle closer than `clearance` to one it shares no vertex with, unless the pair was
 * already that close).
 */
export class ClearanceGrid {
  private readonly cells = new Map<number, Set<number>>();
  private readonly at = new Map<number, number[]>();
  private readonly box = new Map<number, [Tuple3, Tuple3]>();

  private readonly position: (v: number) => Tuple3;
  /** Corners of triangle id, or undefined once it is gone. */
  private readonly corners: (id: number) => readonly [number, number, number] | undefined;
  private readonly cell: number;
  readonly clearance: number;

  constructor(
    position: (v: number) => Tuple3,
    corners: (id: number) => readonly [number, number, number] | undefined,
    cell: number,
    clearance: number,
  ) {
    this.position = position;
    this.corners = corners;
    this.cell = cell;
    this.clearance = clearance;
  }

  /** Cell keys over a box: cell indices packed into one exact integer (2^17 cells per axis). */
  private keys(lo: Tuple3, hi: Tuple3): number[] {
    const out: number[] = [];
    const [i0, j0, k0] = lo.map((x) => Math.floor(x / this.cell)) as Tuple3;
    const [i1, j1, k1] = hi.map((x) => Math.floor(x / this.cell)) as Tuple3;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++)
          out.push(((i & 0x1ffff) * 0x20000 + (j & 0x1ffff)) * 0x20000 + (k & 0x1ffff));
    return out;
  }

  private bounds(points: readonly Tuple3[], grow: number): [Tuple3, Tuple3] {
    const lo: Tuple3 = [Infinity, Infinity, Infinity];
    const hi: Tuple3 = [-Infinity, -Infinity, -Infinity];
    for (const p of points) {
      for (let d = 0; d < 3; d++) {
        lo[d] = Math.min(lo[d] as number, (p[d] as number) - grow);
        hi[d] = Math.max(hi[d] as number, (p[d] as number) + grow);
      }
    }
    return [lo, hi];
  }

  insert(id: number): void {
    const c = this.corners(id);
    if (c === undefined) return;
    const [lo, hi] = this.bounds(
      c.map((v) => this.position(v)),
      0,
    );
    const keys = this.keys(lo, hi);
    this.box.set(id, [lo, hi]);
    for (const key of keys) {
      const set = this.cells.get(key);
      if (set === undefined) this.cells.set(key, new Set([id]));
      else set.add(id);
    }
    this.at.set(id, keys);
  }

  remove(id: number): void {
    for (const key of this.at.get(id) ?? []) this.cells.get(key)?.delete(id);
    this.at.delete(id);
    this.box.delete(id);
  }

  /**
   * Whether moving the triangles `before` (ids) to `after` (corner and position lists)
   * keeps every other triangle at least `clearance` away, or no closer than before.
   */
  allows(
    before: readonly number[],
    after: readonly { readonly corners: readonly number[]; readonly points: readonly Tuple3[] }[],
  ): boolean {
    const own = new Set(before);
    const old = before.map((id) => {
      const corners = this.corners(id) as readonly number[];
      return { corners, points: corners.map((v) => this.position(v)) };
    });
    const [lo, hi] = this.bounds(
      after.flatMap((t) => t.points),
      this.clearance,
    );
    const seen = new Set<number>();
    for (const key of this.keys(lo, hi)) {
      for (const id of this.cells.get(key) ?? []) {
        if (own.has(id) || seen.has(id)) continue;
        seen.add(id);
        const box = this.box.get(id);
        if (
          box === undefined ||
          [0, 1, 2].some(
            (d) =>
              (box[0][d] as number) > (hi[d] as number) ||
              (box[1][d] as number) < (lo[d] as number),
          )
        )
          continue;
        const corners = this.corners(id);
        if (corners === undefined) continue;
        const points = corners.map((v) => this.position(v));
        const apart = (t: { readonly corners: readonly number[] }) =>
          !t.corners.some((v) => corners.includes(v));
        let next = Infinity;
        for (const t of after)
          if (apart(t)) next = Math.min(next, triangleDistance(t.points, points));
        if (next >= this.clearance) continue;
        let prev = Infinity;
        for (const t of old)
          if (apart(t)) prev = Math.min(prev, triangleDistance(t.points, points));
        if (next < prev) return false;
      }
    }
    return true;
  }
}
