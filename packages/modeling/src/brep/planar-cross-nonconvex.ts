import { ok, type Result } from '@forgeax/engine-types';
import { minOf } from '../arrays';
import type { ModelingError } from '../errors';
import { splitPlanarPolygon } from './planar-split';
import { brepFail } from './types';
import { cross3, dist3, dot3, len3, type P3, sub3, unit3 } from './vec';

/** One planar face of a solid as the boolean sees it: boundary ring, a plane point, outward normal. */
export interface RayFace {
  readonly points: readonly P3[];
  readonly holes: readonly (readonly P3[])[];
  readonly origin: P3;
  readonly outward: P3;
}

export type RayLocation = 'inside' | 'outside' | 'on' | 'ambiguous';

function newell(poly: readonly P3[]): P3 {
  const origin = poly[0] as P3;
  let n: P3 = [0, 0, 0];
  for (let i = 1; i + 1 < poly.length; i++) {
    const c = cross3(sub3(poly[i] as P3, origin), sub3(poly[i + 1] as P3, origin));
    n = [n[0] + c[0], n[1] + c[1], n[2] + c[2]];
  }
  return n;
}

function inTriangle(p: P3, a: P3, b: P3, c: P3, normal: P3): boolean {
  return (
    dot3(cross3(sub3(b, a), sub3(p, a)), normal) >= 0 &&
    dot3(cross3(sub3(c, b), sub3(p, b)), normal) >= 0 &&
    dot3(cross3(sub3(a, c), sub3(p, c)), normal) >= 0
  );
}

/**
 * A point strictly inside a simple polygon (counter-clockwise about `normal`): the vertex mean for a
 * convex ring, otherwise the centroid of its largest ear. Null when no ear exists (degenerate ring).
 */
export function interiorPoint(poly: readonly P3[], normal: P3): P3 | null {
  const n = poly.length;
  const turns = poly.map((_, i) => {
    const a = poly[i] as P3;
    const b = poly[(i + 1) % n] as P3;
    const c = poly[(i + 2) % n] as P3;
    return dot3(cross3(sub3(b, a), sub3(c, b)), normal);
  });
  if (turns.every((t) => t >= 0)) {
    const sum: [number, number, number] = [0, 0, 0];
    for (const p of poly) {
      sum[0] += p[0];
      sum[1] += p[1];
      sum[2] += p[2];
    }
    return [sum[0] / n, sum[1] / n, sum[2] / n];
  }
  let best: P3 | null = null;
  let bestArea = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i] as P3;
    const b = poly[(i + 1) % n] as P3;
    const c = poly[(i + 2) % n] as P3;
    const area = dot3(cross3(sub3(b, a), sub3(c, b)), normal);
    if (!(area > bestArea)) continue;
    const blocked = poly.some(
      (p, k) => k !== i && k !== (i + 1) % n && k !== (i + 2) % n && inTriangle(p, a, b, c, normal),
    );
    if (blocked) continue;
    bestArea = area;
    best = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  }
  return best;
}

function segmentDistance(p: P3, a: P3, b: P3): number {
  const edge = sub3(b, a);
  const t = Math.max(0, Math.min(1, dot3(sub3(p, a), edge) / dot3(edge, edge)));
  return dist3(p, [a[0] + edge[0] * t, a[1] + edge[1] * t, a[2] + edge[2] * t]);
}

/** Crossing-number containment in the polygon's plane (drop the dominant normal axis). */
function contains(poly: readonly P3[], p: P3, normal: P3): boolean {
  const [nx, ny, nz] = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])];
  const project = (q: P3): [number, number] =>
    nx >= ny && nx >= nz ? [q[1], q[2]] : ny >= nz ? [q[2], q[0]] : [q[0], q[1]];
  const [pu, pv] = project(p);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [au, av] = project(poly[i] as P3);
    const [bu, bv] = project(poly[j] as P3);
    if (av > pv !== bv > pv && pu < ((bu - au) * (pv - av)) / (bv - av) + au) inside = !inside;
  }
  return inside;
}

function boundaryDistance(poly: readonly P3[], p: P3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < poly.length; i++) {
    best = Math.min(best, segmentDistance(p, poly[i] as P3, poly[(i + 1) % poly.length] as P3));
  }
  return best;
}

function faceBoundaryDistance(face: RayFace, p: P3): number {
  return Math.min(
    boundaryDistance(face.points, p),
    minOf(face.holes.map((h) => boundaryDistance(h, p))),
  );
}

/** Containment in the face region: inside the outer ring and outside every hole. */
function faceContains(face: RayFace, p: P3): boolean {
  return (
    contains(face.points, p, face.outward) && !face.holes.some((h) => contains(h, p, face.outward))
  );
}

/**
 * The faces whose region holds `point` and whose plane carries every vertex of `polygon` within
 * `tol`: the faces a coplanar piece lies on. Several only when the solid repeats a plane there.
 */
export function containingFaces(
  polygon: readonly P3[],
  point: P3,
  faces: readonly RayFace[],
  tol: number,
): RayFace[] {
  return faces.filter(
    (face) =>
      polygon.every((p) => Math.abs(dot3(sub3(p, face.origin), face.outward)) <= tol) &&
      faceContains(face, point),
  );
}

const RAYS: readonly P3[] = [
  unit3([0.5773, 0.3141, 0.7592]),
  unit3([-0.2718, 0.6928, 0.6671]),
  unit3([0.4142, -0.7173, 0.5736]),
  unit3([-0.8113, -0.2399, 0.5321]),
];

/**
 * Point-in-solid by ray parity against the solid's planar faces. A ray whose hit lies within `10 * tol`
 * of any face boundary is discarded and the next fixed direction is tried; 'ambiguous' when all are.
 */
export function locateByRay(point: P3, faces: readonly RayFace[], tol: number): RayLocation {
  const band = tol * 10;
  for (const face of faces) {
    const d = dot3(sub3(point, face.origin), face.outward);
    if (Math.abs(d) > tol) continue;
    if (faceContains(face, point) || faceBoundaryDistance(face, point) <= band) return 'on';
  }
  for (const ray of RAYS) {
    let crossings = 0;
    let clean = true;
    for (const face of faces) {
      const denom = dot3(ray, face.outward);
      if (denom === 0) continue;
      const t = -dot3(sub3(point, face.origin), face.outward) / denom;
      if (t <= 0) continue;
      const hit: P3 = [point[0] + ray[0] * t, point[1] + ray[1] * t, point[2] + ray[2] * t];
      if (faceBoundaryDistance(face, hit) <= band) {
        clean = false;
        break;
      }
      if (faceContains(face, hit)) crossings += 1;
    }
    if (clean) return crossings % 2 === 1 ? 'inside' : 'outside';
  }
  return 'ambiguous';
}

/**
 * Split a simple polygon (boundary points already inserted at every section endpoint) along a plane
 * that crosses it in `endpoints.length / 2` disjoint chords: sort the endpoints along the section
 * line and join consecutive pairs. Fails closed when a chord cannot be placed in any piece.
 */
export function splitAlongChords(
  inserted: readonly P3[],
  endpoints: readonly P3[],
  planeNormal: P3,
  tol: number,
): Result<P3[][], ModelingError> {
  const direction = unit3(cross3(planeNormal, newell(inserted)));
  if (len3(direction) === 0)
    return brepFail('brep-ssi-unsupported', 'a closed planar crossing boolean', {
      reason: 'planar-cross-section-direction',
    });
  const sorted = [...endpoints].sort((a, b) => dot3(a, direction) - dot3(b, direction));
  let pieces: P3[][] = [inserted.slice()];
  for (let k = 0; k + 1 < sorted.length; k += 2) {
    const p = sorted[k] as P3;
    const q = sorted[k + 1] as P3;
    let placed = false;
    for (let pi = 0; pi < pieces.length && !placed; pi++) {
      const piece = pieces[pi] as P3[];
      const ia = piece.findIndex((c) => dist3(c, p) <= tol);
      const ib = piece.findIndex((c) => dist3(c, q) <= tol);
      if (ia < 0 || ib < 0) continue;
      const split = splitPlanarPolygon(piece, ia, ib, tol);
      if (!split.ok) continue;
      pieces = [
        ...pieces.slice(0, pi),
        [...split.value.first],
        [...split.value.second],
        ...pieces.slice(pi + 1),
      ];
      placed = true;
    }
    if (!placed)
      return brepFail('brep-ssi-unsupported', 'a closed planar crossing boolean', {
        reason: 'planar-cross-chord-split',
        chord: k / 2,
      });
  }
  return ok(pieces);
}

/** Connected components of a face set joined by shared directed-edge endpoints (vertex-id rings). */
export function componentCount(rings: readonly (readonly number[])[][]): number {
  const parent = rings.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  const owner = new Map<string, number>();
  rings.forEach((face, fi) => {
    for (const ring of face) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i] as number;
        const b = ring[(i + 1) % ring.length] as number;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const seen = owner.get(key);
        if (seen === undefined) owner.set(key, fi);
        else parent[find(fi)] = find(seen);
      }
    }
  });
  return new Set(rings.map((_, i) => find(i))).size;
}
