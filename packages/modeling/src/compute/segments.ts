import type { Tuple3 } from '../geom';

export interface SegmentHit {
  readonly vertex: number;
  /** Parameter along the segment, strictly between its ends. */
  readonly t: number;
}

/**
 * Vertices lying on a segment: within `eps` of it and farther than `eps` from both
 * ends, ordered from `a` to `b`. `sorted` lists candidate vertex ids by ascending x.
 */
export function verticesOnSegment(
  a: number,
  b: number,
  positions: readonly Tuple3[],
  sorted: readonly number[],
  eps: number,
): SegmentHit[] {
  const p = positions[a] as Tuple3;
  const q = positions[b] as Tuple3;
  const d: Tuple3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  if (len2 <= 4 * eps * eps) return [];
  const len = Math.sqrt(len2);
  const lo = Math.min(p[0], q[0]) - eps;
  const hi = Math.max(p[0], q[0]) + eps;
  let first = 0;
  let last = sorted.length;
  while (first < last) {
    const mid = (first + last) >> 1;
    if (((positions[sorted[mid] as number] as Tuple3)[0] as number) < lo) first = mid + 1;
    else last = mid;
  }
  const hits: SegmentHit[] = [];
  for (let i = first; i < sorted.length; i++) {
    const v = sorted[i] as number;
    const w = positions[v] as Tuple3;
    if (w[0] > hi) break;
    if (v === a || v === b) continue;
    const r: Tuple3 = [w[0] - p[0], w[1] - p[1], w[2] - p[2]];
    const s = (r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) / len2;
    if (s * len <= eps || (1 - s) * len <= eps) continue;
    const e: Tuple3 = [r[0] - d[0] * s, r[1] - d[1] * s, r[2] - d[2] * s];
    if (e[0] * e[0] + e[1] * e[1] + e[2] * e[2] > eps * eps) continue;
    hits.push({ vertex: v, t: s });
  }
  return hits.sort((x, y) => x.t - y.t || x.vertex - y.vertex);
}

/**
 * Resolve T-junctions in a polygon soup: every directed edge without its reverse
 * takes, in order, the vertices of other unmatched edges that lie on it. Repeats
 * until stable (a pass can expose further unmatched sub-edges).
 */
export function segmentInsertions(
  input: readonly (readonly number[])[],
  positions: readonly Tuple3[],
  eps: number,
): { loops: number[][]; inserted: number } {
  let loops = input.map((l) => [...l]);
  let inserted = 0;
  for (let pass = 0; pass < 8; pass++) {
    const directed = new Set<string>();
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        directed.add(`${loop[i]},${loop[(i + 1) % loop.length]}`);
      }
    }
    const open = new Set<number>();
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i] as number;
        const b = loop[(i + 1) % loop.length] as number;
        if (!directed.has(`${b},${a}`)) {
          open.add(a);
          open.add(b);
        }
      }
    }
    if (open.size === 0) break;
    const sorted = [...open].sort(
      (x, y) => (positions[x] as Tuple3)[0] - (positions[y] as Tuple3)[0] || x - y,
    );
    let changed = 0;
    loops = loops.map((loop) => {
      const out: number[] = [];
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i] as number;
        const b = loop[(i + 1) % loop.length] as number;
        out.push(a);
        if (directed.has(`${b},${a}`)) continue;
        for (const hit of verticesOnSegment(a, b, positions, sorted, eps)) {
          if (loop.includes(hit.vertex) || out.includes(hit.vertex)) continue;
          out.push(hit.vertex);
          changed++;
        }
      }
      return out;
    });
    inserted += changed;
    if (changed === 0) break;
  }
  return { loops, inserted };
}
