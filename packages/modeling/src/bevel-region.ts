import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from './errors';
import { cross, dot, normalize, type Tuple3 } from './geom';
import type { EditMesh } from './mesh';
import { convexPartition } from './polygon2d';
import { orient2d } from './predicates';

/**
 * Planar regions of a bevel (design 8): coplanar faces joined across the flat edges
 * that only partition a plane (convex pieces of a holed extrusion cap, strips of a
 * boolean cut face). The bevel moves the region's boundary as one polygon with holes
 * and partitions it again, so partition edges neither clamp the width nor fold.
 */

type P2 = readonly [number, number];

/** Corner values closer than this are equal (float32 storage of interpolated values). */
const VALUE_TOLERANCE = 1e-5;

/** Do the corner values of both faces agree at both ends of the edge of half `h`? */
export function cornersMatch(mesh: EditMesh, h: number): boolean {
  const pairs: readonly (readonly [number, number])[] = [
    [h, mesh.hNext[h ^ 1] as number],
    [mesh.hNext[h] as number, h ^ 1],
  ];
  for (const name of mesh.channels.keys()) {
    for (const [a, b] of pairs) {
      const x = mesh.corner(name, a);
      const y = mesh.corner(name, b);
      if (x === undefined || y === undefined) {
        if (x !== y) return false;
        continue;
      }
      for (let i = 0; i < x.length; i++) {
        if (Math.abs((x[i] as number) - (y[i] as number)) > VALUE_TOLERANCE) return false;
      }
    }
  }
  return true;
}

/**
 * Boundary loops of the faces `faces` joined across `joined` edges, as the boundary
 * halves in loop order. Undefined when a vertex is visited twice (a pinched region).
 */
export function regionBoundary(
  mesh: EditMesh,
  faces: readonly number[],
  joined: ReadonlySet<number>,
): number[][] | undefined {
  const boundary: number[] = [];
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) if (!joined.has(h >> 1)) boundary.push(h);
  }
  const visited = new Set<number>();
  const starts = new Set<number>();
  const loops: number[][] = [];
  for (const h0 of boundary) {
    if (visited.has(h0)) continue;
    const loop: number[] = [];
    let h = h0;
    do {
      const v = mesh.hVert[h] as number;
      if (visited.has(h) || starts.has(v) || loop.length > boundary.length) return undefined;
      visited.add(h);
      starts.add(v);
      loop.push(h);
      let g = mesh.hNext[h] as number;
      for (let guard = 0; joined.has(g >> 1); guard++) {
        if (guard > boundary.length + faces.length * 8) return undefined;
        g = mesh.hNext[g ^ 1] as number;
      }
      h = g;
    } while (h !== h0);
    loops.push(loop);
  }
  return visited.size === boundary.length ? loops : undefined;
}

/** A right-handed frame (u, w) of the plane with normal `n`. */
export function planeFrame(n: Tuple3): readonly [Tuple3, Tuple3] {
  const axis: Tuple3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(axis, n));
  return [u, cross(n, u)];
}

export function project(points: readonly Tuple3[], frame: readonly [Tuple3, Tuple3]): P2[] {
  const [u, w] = frame;
  return points.map((p) => [dot(p, u), dot(p, w)] as const);
}

function signedArea(loop: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i] as P2;
    const q = loop[(i + 1) % loop.length] as P2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Is the polygon with holes still valid: every loop keeps the orientation sign it had
 * (`signs`), encloses more than `minArea`, and no two edges of any loops meet except
 * neighbours at their shared corner?
 */
export function regionHolds(
  loops: readonly (readonly P2[])[],
  signs: readonly number[],
  minArea: number,
): boolean {
  for (const [i, loop] of loops.entries()) {
    const a = signedArea(loop);
    if (Math.abs(a) <= minArea || Math.sign(a) !== signs[i]) return false;
  }
  interface Segment {
    readonly loop: number;
    readonly index: number;
    readonly a: P2;
    readonly b: P2;
    readonly lo: number;
    readonly hi: number;
  }
  const segments: Segment[] = [];
  for (const [l, loop] of loops.entries()) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as P2;
      const b = loop[(i + 1) % loop.length] as P2;
      segments.push({
        loop: l,
        index: i,
        a,
        b,
        lo: Math.min(a[0], b[0]),
        hi: Math.max(a[0], b[0]),
      });
    }
  }
  segments.sort((x, y) => x.lo - y.lo);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] as Segment;
    for (let j = i + 1; j < segments.length; j++) {
      const t = segments[j] as Segment;
      if (t.lo > s.hi) break;
      if (s.loop === t.loop) {
        const n = (loops[s.loop] as readonly P2[]).length;
        const gap = Math.abs(s.index - t.index);
        if (gap === 1 || gap === n - 1) {
          // Neighbours share one corner; they fail only by folding back along each other.
          const first = (s.index + 1) % n === t.index ? s : t;
          const second = first === s ? t : s;
          if (n > 2 && foldsBack(first.a, first.b, second.b)) return false;
          continue;
        }
      }
      if (Math.max(s.a[1], s.b[1]) < Math.min(t.a[1], t.b[1])) continue;
      if (Math.max(t.a[1], t.b[1]) < Math.min(s.a[1], s.b[1])) continue;
      if (meet(s.a, s.b, t.a, t.b)) return false;
    }
  }
  return true;
}

function turn(a: P2, b: P2, c: P2): number {
  return orient2d(a[0], a[1], b[0], b[1], c[0], c[1]);
}

function within(a: P2, b: P2, p: P2): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

/** Do the closed segments ab and cd share a point? */
function meet(a: P2, b: P2, c: P2, d: P2): boolean {
  const d1 = turn(c, d, a);
  const d2 = turn(c, d, b);
  const d3 = turn(a, b, c);
  const d4 = turn(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return (
    (d1 === 0 && within(c, d, a)) ||
    (d2 === 0 && within(c, d, b)) ||
    (d3 === 0 && within(a, b, c)) ||
    (d4 === 0 && within(a, b, d))
  );
}

/** Does the path p -> corner -> q turn back along itself (collinear, overlapping)? */
function foldsBack(p: P2, corner: P2, q: P2): boolean {
  if (turn(p, corner, q) !== 0) return false;
  return (p[0] - corner[0]) * (q[0] - corner[0]) + (p[1] - corner[1]) * (q[1] - corner[1]) > 0;
}

/** Normalized corner turn below which a corner counts as straight (the export SLIVER). */
const STRAIGHT = 1e-6;

/** Does `q` lie within `tolerance` of the segment ab, strictly between its ends? */
function nearChord(q: P2, a: P2, b: P2, tolerance: number): boolean {
  const ab = [b[0] - a[0], b[1] - a[1]] as const;
  const aq = [q[0] - a[0], q[1] - a[1]] as const;
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = ab[0] * aq[0] + ab[1] * aq[1];
  if (l2 === 0 || t <= 0 || t >= l2) return false;
  const off = ab[0] * aq[1] - ab[1] * aq[0];
  return off * off <= tolerance * tolerance * l2;
}

/**
 * Convex faces covering the region: loops of indices into the flattened loops. Straight
 * corners (points inserted on an edge, or a run of points within `tolerance` of the chord
 * past them) are left out of the partition and put back on the piece edge they lie on, so
 * no piece is a zero-area sliver of collinear points.
 */
export function partitionRegion(
  loops: readonly (readonly P2[])[],
  tolerance = 0,
): Result<number[][], ModelingError> {
  const points: P2[] = [];
  const indexed: number[][] = [];
  for (const loop of loops) indexed.push(loop.map((p) => points.push(p) - 1));
  /** Essential index -> the straight indices that follow it on its loop. */
  const between = new Map<number, number[]>();
  const essential = indexed.map((loop) => {
    const n = loop.length;
    const pointAt = (k: number) => points[loop[((k % n) + n) % n] as number] as P2;
    const bend = (k: number) => {
      const [a, b, c] = [pointAt(k - 1), pointAt(k), pointAt(k + 1)];
      const ab = [a[0] - b[0], a[1] - b[1]] as const;
      const cb = [c[0] - b[0], c[1] - b[1]] as const;
      const span = ab[0] * ab[0] + ab[1] * ab[1] + cb[0] * cb[0] + cb[1] * cb[1];
      return {
        turn: span > 0 ? Math.abs(turn(a, b, c)) / span : 0,
        back: ab[0] * cb[0] + ab[1] * cb[1] >= 0,
      };
    };
    // Walk from the sharpest corner, dropping points while the run since the last kept
    // point stays within the tolerance of the chord to the next one.
    let first = 0;
    for (let k = 1; k < n; k++) if (bend(k).turn > bend(first).turn) first = k;
    const kept: number[] = [loop[first] as number];
    let anchor = pointAt(first);
    let run: P2[] = [];
    for (let j = 1; j < n; j++) {
      const k = first + j;
      const { turn: t, back } = bend(k);
      const b = pointAt(k);
      const straight =
        !back &&
        (t <= STRAIGHT ||
          [...run, b].every((q) => nearChord(q, anchor, pointAt(k + 1), tolerance)));
      if (straight) {
        run.push(b);
        continue;
      }
      kept.push(loop[k % n] as number);
      anchor = b;
      run = [];
    }
    if (kept.length < 3) return loop;
    const at = new Set(kept);
    let last = kept.at(-1) as number;
    const start = loop.indexOf(kept[0] as number);
    for (let k = 0; k < loop.length; k++) {
      const i = loop[(start + k) % loop.length] as number;
      if (at.has(i)) last = i;
      else between.set(last, [...(between.get(last) ?? []), i]);
    }
    return kept;
  });
  const next = new Map<number, number>();
  for (const loop of essential) {
    for (const [k, i] of loop.entries()) next.set(i, loop[(k + 1) % loop.length] as number);
  }
  const outer = essential.findIndex((loop) => signedArea(loop.map((i) => points[i] as P2)) > 0);
  const pieces = convexPartition(
    points,
    essential[outer] as number[],
    essential.filter((_, i) => i !== outer),
  );
  if (!pieces.ok) return pieces;
  return ok(
    pieces.value.map((piece) =>
      piece.flatMap((i, k) =>
        next.get(i) === piece[(k + 1) % piece.length] ? [i, ...(between.get(i) ?? [])] : [i],
      ),
    ),
  );
}
