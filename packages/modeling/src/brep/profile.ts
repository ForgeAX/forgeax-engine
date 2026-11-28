import { hypot2 } from '../dmath';
import { tally } from './ops';
import type { P2 } from './vec';

/** Why a set of closed rings is not a valid planar region; `reason` is the stable `detail.reason` value. */
export interface RingDefect {
  readonly reason: string;
  readonly expected: string;
  readonly ids: Readonly<Record<string, number | readonly number[]>>;
}

/** Signed area of a closed ring in the plane: positive is counter-clockwise. */
export function area2(points: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as P2;
    const q = points[(i + 1) % points.length] as P2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** The ring without a repeated closing point, wound as requested. */
export function windPolygon(points: readonly P2[], counterClockwise: boolean): P2[] {
  const closed =
    points.length > 1 &&
    points[0]?.[0] === points[points.length - 1]?.[0] &&
    points[0]?.[1] === points[points.length - 1]?.[1];
  const ring = closed ? points.slice(0, -1) : points.slice();
  return area2(ring) > 0 === counterClockwise ? ring : ring.reverse();
}

/** `value` is an array of at least `min` finite [x, y] pairs. */
export function isPointList(value: unknown, min: number): value is readonly P2[] {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.every(
      (p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
    )
  );
}

function pointSegment(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return hypot2(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function orient(a: P2, b: P2, c: P2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Smallest distance between two segments; zero when they cross. */
function segmentGap(a: P2, b: P2, c: P2, d: P2): number {
  if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) return 0;
  return Math.min(
    pointSegment(a, c, d),
    pointSegment(b, c, d),
    pointSegment(c, a, b),
    pointSegment(d, a, b),
  );
}

function insidePolygon(p: P2, ring: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as P2;
    const b = ring[j] as P2;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

interface Seg {
  readonly ring: number;
  readonly index: number;
  readonly a: P2;
  readonly b: P2;
}

/**
 * Planar region precondition for closed rings (the first is the outline, the others holes): every ring is
 * simple (no crossing, touching or fold-back), rings do not touch each other, each hole lies inside the
 * outline and outside every other hole. `what` names the ring in the reason (`self-intersecting-<what>`).
 */
export function ringDefect(
  rings: readonly (readonly P2[])[],
  tol: number,
  what: string,
): RingDefect | undefined {
  const segs: Seg[] = [];
  for (let ring = 0; ring < rings.length; ring++) {
    const r = rings[ring] as readonly P2[];
    for (let index = 0; index < r.length; index++) {
      segs.push({ ring, index, a: r[index] as P2, b: r[(index + 1) % r.length] as P2 });
    }
  }
  for (const s of segs) {
    if (hypot2(s.b[0] - s.a[0], s.b[1] - s.a[1]) <= tol) {
      return {
        reason: 'degenerate-edge',
        expected: `${what} edges longer than the tolerance`,
        ids: { ring: s.ring, edge: s.index },
      };
    }
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] as Seg;
    const smin = [Math.min(s.a[0], s.b[0]) - tol, Math.min(s.a[1], s.b[1]) - tol];
    const smax = [Math.max(s.a[0], s.b[0]) + tol, Math.max(s.a[1], s.b[1]) + tol];
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j] as Seg;
      tally('segmentPairs');
      if (
        Math.max(t.a[0], t.b[0]) < (smin[0] as number) ||
        Math.min(t.a[0], t.b[0]) > (smax[0] as number) ||
        Math.max(t.a[1], t.b[1]) < (smin[1] as number) ||
        Math.min(t.a[1], t.b[1]) > (smax[1] as number)
      ) {
        continue;
      }
      const n = (rings[s.ring] as readonly P2[]).length;
      const adjacent =
        s.ring === t.ring && (t.index === s.index + 1 || (s.index === 0 && t.index === n - 1));
      if (adjacent) {
        const [first, second] = t.index === s.index + 1 ? [s, t] : [t, s];
        const turn = orient(first.a, first.b, second.b);
        const along =
          (first.b[0] - first.a[0]) * (second.b[0] - second.a[0]) +
          (first.b[1] - first.a[1]) * (second.b[1] - second.a[1]);
        if (
          Math.abs(turn) <=
            tol * Math.max(1, hypot2(first.b[0] - first.a[0], first.b[1] - first.a[1])) &&
          along < 0
        ) {
          return {
            reason: `self-intersecting-${what}`,
            expected: `${what} without fold-back edges`,
            ids: { ring: s.ring, edges: [first.index, second.index] },
          };
        }
        continue;
      }
      tally('segmentGaps');
      if (segmentGap(s.a, s.b, t.a, t.b) <= tol) {
        return {
          reason: `self-intersecting-${what}`,
          expected: `a simple ${what} whose edges and holes do not cross or touch`,
          ids: { rings: [s.ring, t.ring], edges: [s.index, t.index] },
        };
      }
    }
  }
  const outline = rings[0] as readonly P2[];
  for (let h = 1; h < rings.length; h++) {
    const first = (rings[h] as readonly P2[])[0] as P2;
    if (!insidePolygon(first, outline)) {
      return {
        reason: 'hole-outside-outline',
        expected: 'each hole strictly inside the outline',
        ids: { ring: h },
      };
    }
    for (let o = 1; o < rings.length; o++) {
      if (o !== h && insidePolygon(first, rings[o] as readonly P2[])) {
        return {
          reason: 'hole-inside-hole',
          expected: 'holes that do not nest',
          ids: { rings: [h, o] },
        };
      }
    }
  }
  return undefined;
}
