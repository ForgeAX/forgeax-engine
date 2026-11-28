import { ok, type Result } from '@forgeax/engine-types';
import { minOf } from '../arrays';
import type { ModelingError } from '../errors';
import { orient2d } from '../predicates';
import { splitPlanarPolygon } from './planar-split';
import { brepFail, type Surface } from './types';
import { cross3, dot3, type P3, sub3, unit3 } from './vec';

type Plane = Surface & { readonly kind: 'plane' };

function refuse(reason: string, ids: Record<string, unknown> = {}): Result<never, ModelingError> {
  return brepFail('brep-ssi-unsupported', 'a closed planar crossing boolean', {
    reason: `planar-cross-${reason}`,
    ...ids,
  });
}

/** Distances at or below this band are rounding of an exact zero: the point lies on the plane. */
export function numericalBand(polygon: readonly P3[], plane: Plane): number {
  let scale = 1;
  for (const point of polygon) {
    scale = Math.max(scale, Math.abs(point[0]), Math.abs(point[1]), Math.abs(point[2]));
  }
  for (const value of plane.frame.o) scale = Math.max(scale, Math.abs(value));
  return Number.EPSILON * scale * 64;
}

function newell(poly: readonly P3[]): P3 {
  const n: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as P3;
    const b = poly[(i + 1) % poly.length] as P3;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** Drops the dominant normal axis; coordinates are copied, so the 2D predicates stay exact. */
function projector(normal: P3): (p: P3) => readonly [number, number] {
  const [nx, ny, nz] = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])];
  return nx >= ny && nx >= nz
    ? (q) => [q[1], q[2]]
    : ny >= nz
      ? (q) => [q[2], q[0]]
      : (q) => [q[0], q[1]];
}

/** Non-zero winding number with exact orientation tests; `p` must not lie on the boundary. */
function strictlyInside(ring: readonly P3[], p: P3, normal: P3): boolean {
  const project = projector(normal);
  const [px, py] = project(p);
  let winding = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = project(ring[i] as P3);
    const [bx, by] = project(ring[(i + 1) % ring.length] as P3);
    if (ay <= py) {
      if (by > py && orient2d(ax, ay, bx, by, px, py) > 0) winding += 1;
    } else if (by <= py && orient2d(ax, ay, bx, by, px, py) < 0) winding -= 1;
  }
  return winding !== 0;
}

/**
 * Sections a simple planar polygon by a plane, including the degenerate positions a repeated cut
 * produces. Each vertex is classified on, above or below the plane (the band only absorbs rounding;
 * a distance between the band and `tol` is refused). New vertices appear only where an edge crosses
 * the plane strictly; a vertex already on the plane is reused as a section site. Along the section
 * line the sites are taken in order, and the stretch between two consecutive sites becomes a chord
 * only when it runs through the polygon interior: a stretch that is a boundary edge already
 * separates the two sides, and a stretch outside the polygon is skipped. The polygon is then split
 * along every chord, and every piece must lie on one side. Null when the plane does not cross the
 * interior (all vertices on one side or on the plane).
 */
export function sectionPolygon(
  polygon: readonly P3[],
  plane: Plane,
  tol: number,
): Result<readonly P3[][] | null, ModelingError> {
  const signed = polygon.map((p) => dot3(sub3(p, plane.frame.o), plane.frame.z));
  const exact = numericalBand(polygon, plane);
  const grey = signed.filter((d) => Math.abs(d) > exact && Math.abs(d) <= tol);
  if (grey.length > 0) return refuse('tolerance-contact', { distance: minOf(grey.map(Math.abs)) });
  const side = signed.map((d) => (d > exact ? 1 : d < -exact ? -1 : 0));
  if (!side.includes(1) || !side.includes(-1)) return ok(null);

  const ring: P3[] = [];
  const sideOf = new Map<P3, number>();
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    const a = polygon[i] as P3;
    const b = polygon[j] as P3;
    ring.push(a);
    sideOf.set(a, side[i] as number);
    if ((side[i] as number) * (side[j] as number) === -1) {
      const da = signed[i] as number;
      const t = da / (da - (signed[j] as number));
      const crossing: P3 = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ];
      ring.push(crossing);
      sideOf.set(crossing, 0);
    }
  }

  const normal = newell(polygon);
  const direction = unit3(cross3(plane.frame.z, normal));
  if (dot3(direction, direction) === 0) return refuse('section-direction');
  const sites = ring
    .map((p, index) => ({ p, index, s: dot3(p, direction) }))
    .filter((site) => sideOf.get(site.p) === 0)
    .sort((x, y) => x.s - y.s);
  const n = ring.length;
  const single = sites.length === 2;
  const chords: [P3, P3][] = [];
  for (let k = 0; k + 1 < sites.length; k++) {
    const a = sites[k] as (typeof sites)[number];
    const b = sites[k + 1] as (typeof sites)[number];
    if (!(b.s - a.s > tol)) return refuse('section-coincident-sites', { site: k });
    if ((a.index + 1) % n === b.index || (b.index + 1) % n === a.index) continue;
    const mid: P3 = [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2, (a.p[2] + b.p[2]) / 2];
    // A single chord is split from its first vertex in walk order; several chords keep section order.
    if (strictlyInside(ring, mid, normal))
      chords.push(single && a.index > b.index ? [b.p, a.p] : [a.p, b.p]);
  }
  if (chords.length === 0) return refuse('section-without-chord');

  let pieces: P3[][] = [ring];
  for (let k = 0; k < chords.length; k++) {
    const [p, q] = chords[k] as [P3, P3];
    let placed = false;
    for (let pi = 0; pi < pieces.length && !placed; pi++) {
      const piece = pieces[pi] as P3[];
      const ia = piece.indexOf(p);
      const ib = piece.indexOf(q);
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
    if (!placed) return refuse('chord-split', { chord: k });
  }
  for (const piece of pieces) {
    const sides = piece.map((p) => sideOf.get(p) as number);
    if (sides.includes(1) && sides.includes(-1)) return refuse('section-two-sided-piece');
  }
  return ok(pieces);
}
