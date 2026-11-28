import { pushAll } from '../arrays';
import { cross3, dist3, dot3, type P3, sub3 } from './vec';

type Pt = readonly [number, number];
type Segment = readonly [P3, P3];

interface Region {
  readonly outer: readonly P3[];
  readonly holes: readonly (readonly P3[])[];
}

function projector(normal: P3): (p: P3) => Pt {
  const [nx, ny, nz] = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])];
  return nx >= ny && nx >= nz
    ? (q) => [q[1], q[2]]
    : ny >= nz
      ? (q) => [q[2], q[0]]
      : (q) => [q[0], q[1]];
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointSegmentDistance(p: P3, a: P3, b: P3): number {
  const edge = sub3(b, a);
  const t = Math.max(0, Math.min(1, dot3(sub3(p, a), edge) / dot3(edge, edge)));
  return dist3(p, [a[0] + edge[0] * t, a[1] + edge[1] * t, a[2] + edge[2] * t]);
}

function signedArea(ring: readonly P3[], normal: P3): number {
  const origin = ring[0] as P3;
  let s = 0;
  for (let i = 1; i + 1 < ring.length; i++) {
    s += dot3(normal, cross3(sub3(ring[i] as P3, origin), sub3(ring[i + 1] as P3, origin)));
  }
  return s / 2;
}

function containsPoint(ring: readonly P3[], point: P3, project: (p: P3) => Pt): boolean {
  const [pu, pv] = project(point);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [au, av] = project(ring[i] as P3);
    const [bu, bv] = project(ring[j] as P3);
    if (av > pv !== bv > pv && pu < ((bu - au) * (pv - av)) / (bv - av) + au) inside = !inside;
  }
  return inside;
}

function ringEdges(ring: readonly P3[]): Segment[] {
  return ring.map((p, i) => [p, ring[(i + 1) % ring.length] as P3] as const);
}

/**
 * A bridge h-o is usable when it touches no ring edge or earlier bridge except at its own
 * endpoints, passes no vertex within `tol`, and runs through the face interior.
 */
function visible(
  h: P3,
  o: P3,
  edges: readonly Segment[],
  region: Region,
  project: (p: P3) => Pt,
  tol: number,
): boolean {
  const [hp, op] = [project(h), project(o)];
  for (const [a, b] of edges) {
    const ends = [a, b].filter((p) => dist3(p, h) > tol && dist3(p, o) > tol);
    if (ends.some((p) => pointSegmentDistance(p, h, o) <= tol)) return false;
    if (dist3(a, h) <= tol || dist3(a, o) <= tol || dist3(b, h) <= tol || dist3(b, o) <= tol)
      continue;
    const [ap, bp] = [project(a), project(b)];
    if (orient(hp, op, ap) * orient(hp, op, bp) < 0 && orient(ap, bp, hp) * orient(ap, bp, op) < 0)
      return false;
  }
  const mid: P3 = [(h[0] + o[0]) / 2, (h[1] + o[1]) / 2, (h[2] + o[2]) / 2];
  return (
    containsPoint(region.outer, mid, project) &&
    !region.holes.some((hole) => containsPoint(hole, mid, project))
  );
}

function arc(ring: readonly P3[], from: number, to: number): P3[] {
  const out: P3[] = [];
  for (let i = from; ; i = (i + 1) % ring.length) {
    out.push(ring[i] as P3);
    if (i === to) return out;
  }
}

function cutOnce(region: Region, normal: P3, tol: number): [Region, Region] | null {
  const project = projector(normal);
  const hole = region.holes[0] as readonly P3[];
  const edges = [region.outer, ...region.holes].flatMap(ringEdges);
  const candidates: { hi: number; oi: number; length: number }[] = [];
  for (let hi = 0; hi < hole.length; hi++) {
    for (let oi = 0; oi < region.outer.length; oi++) {
      candidates.push({
        hi,
        oi,
        length: dist3(hole[hi] as P3, region.outer[oi] as P3),
      });
    }
  }
  candidates.sort((x, y) => x.length - y.length);
  const usable = (c: { hi: number; oi: number }, extra: readonly Segment[]): boolean =>
    visible(hole[c.hi] as P3, region.outer[c.oi] as P3, [...edges, ...extra], region, project, tol);
  const first = candidates.find((c) => usable(c, []));
  if (first === undefined) return null;
  const bridge: Segment = [hole[first.hi] as P3, region.outer[first.oi] as P3];
  const second = candidates.find(
    (c) => c.hi !== first.hi && c.oi !== first.oi && usable(c, [bridge]),
  );
  if (second === undefined) return null;

  const { hi: h1, oi: o1 } = first;
  const { hi: h2, oi: o2 } = second;
  const sideA = [...arc(region.outer, o1, o2), ...arc(hole, h2, h1)];
  const sideB = [...arc(region.outer, o2, o1), ...arc(hole, h1, h2)];
  const rest = region.holes.slice(1);
  const place = (ring: readonly P3[]): readonly (readonly P3[])[] =>
    rest.filter((other) => containsPoint(ring, other[0] as P3, project));
  const [restA, restB] = [place(sideA), place(sideB)];
  if (restA.length + restB.length !== rest.length) return null;
  const areaA = signedArea(sideA, normal);
  const areaB = signedArea(sideB, normal);
  const total = signedArea(region.outer, normal) + signedArea(hole, normal);
  if (!(areaA > 0) || !(areaB > 0) || Math.abs(areaA + areaB - total) > tol * Math.abs(total) * 8)
    return null;
  return [
    { outer: sideA, holes: restA },
    { outer: sideB, holes: restB },
  ];
}

/**
 * Cut a planar face with holes into simple hole-free polygons by joining each hole to the outer ring
 * with two disjoint visible bridges, so that every piece is a simple counter-clockwise ring about
 * `normal`. The pieces tile the face exactly and their vertices are the original ring vertices; the
 * boolean's coplanar merge cancels the bridges again. Null when no bridge pair exists.
 */
export function cutHolesIntoPolygons(
  outer: readonly P3[],
  holes: readonly (readonly P3[])[],
  normal: P3,
  tol: number,
): P3[][] | null {
  const ccw = (ring: readonly P3[], want: 1 | -1): P3[] =>
    signedArea(ring, normal) * want >= 0 ? ring.slice() : ring.slice().reverse();
  const pending: Region[] = [{ outer: ccw(outer, 1), holes: holes.map((hole) => ccw(hole, -1)) }];
  const done: P3[][] = [];
  while (pending.length > 0) {
    const region = pending.pop() as Region;
    if (region.holes.length === 0) {
      done.push(region.outer.slice());
      continue;
    }
    const cut = cutOnce(region, normal, tol);
    if (cut === null) return null;
    pushAll(pending, cut);
  }
  return done;
}
