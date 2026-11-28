import type { Curve, Shape, Surface } from './types';
import { add3, cross3, dot3, type P3, scale3, sub3 } from './vec';

/**
 * Circle holes carried whole through the planar crossing boolean. A carried hole is a cylinder face
 * whose two circle edges are the single-coedge inner loops of two planar faces perpendicular to its
 * axis (a drilled through hole). The planar crossing never splits such a hole: it is admitted only
 * when no face of the other solid comes within the hole radius of the axis (`clearOfFaces`), so every
 * bounded chord misses every circle, and each circle loop is later attached to the result face that
 * contains its centre (`holdsCircle`).
 */
export interface CarriedLateral {
  readonly face: number;
  /** A point on the cylinder face at mid-height, for in/out classification against the other solid. */
  readonly probe: P3;
  readonly axis: P3;
  readonly centre: P3;
  readonly radius: number;
  /** The two inner loops (on planar faces) that share this face's circle edges. */
  readonly loops: readonly [number, number];
}

export interface CircleHole {
  readonly face: number;
  readonly loop: number;
  readonly centre: P3;
  readonly radius: number;
  readonly lateral: number;
}

export interface CarriedHoles {
  readonly laterals: readonly CarriedLateral[];
  readonly holes: readonly CircleHole[];
  readonly lateralFaces: ReadonlySet<number>;
  readonly holeLoops: ReadonlySet<number>;
}

type Circle = Extract<Curve, { kind: 'circle' }>;

function singleCircleLoop(shape: Shape, loop: number): { edge: number; curve: Circle } | null {
  const l = shape.loops[loop];
  if (l === undefined || l.outer || l.coedges.length !== 1) return null;
  const edge = shape.coedges[l.coedges[0] as number]?.edge ?? -1;
  const e = shape.edges[edge];
  const curve = e === undefined || e.curve < 0 ? undefined : shape.curves[e.curve];
  return curve?.kind === 'circle' ? { edge, curve } : null;
}

/** The carried holes of `shape`, or null when any curved face is not a drilled through hole. */
export function carriedHoles(shape: Shape): CarriedHoles | null {
  const holeByEdge = new Map<number, { face: number; loop: number; curve: Circle }>();
  for (let f = 0; f < shape.faces.length; f++) {
    const face = shape.faces[f] as Shape['faces'][number];
    if (shape.surfaces[face.surface]?.kind !== 'plane') continue;
    for (const loop of face.loops) {
      const c = singleCircleLoop(shape, loop);
      if (c !== null) holeByEdge.set(c.edge, { face: f, loop, curve: c.curve });
    }
  }
  const laterals: CarriedLateral[] = [];
  const holes: CircleHole[] = [];
  for (let f = 0; f < shape.faces.length; f++) {
    const face = shape.faces[f] as Shape['faces'][number];
    const surface = shape.surfaces[face.surface] as Surface;
    if (surface.kind === 'plane') continue;
    if (surface.kind !== 'cylinder' || face.loops.length !== 1) return null;
    const loop = shape.loops[face.loops[0] as number];
    if (loop === undefined || loop.coedges.length !== 4) return null;
    const ends: { face: number; loop: number; curve: Circle }[] = [];
    for (const ci of loop.coedges) {
      const edge = shape.coedges[ci]?.edge ?? -1;
      const e = shape.edges[edge];
      const curve = e === undefined || e.curve < 0 ? undefined : shape.curves[e.curve];
      if (curve?.kind === 'line') continue;
      const hole = holeByEdge.get(edge);
      if (hole === undefined) return null;
      ends.push(hole);
    }
    if (ends.length !== 2) return null;
    const [a, b] = ends as [(typeof ends)[number], (typeof ends)[number]];
    const axis = surface.frame.z;
    for (const end of ends) {
      const plane = shape.surfaces[shape.faces[end.face]?.surface ?? -1];
      if (plane?.kind !== 'plane' || Math.abs(Math.abs(dot3(plane.frame.z, axis)) - 1) > 1e-9)
        return null;
    }
    const mid = scale3(add3(a.curve.frame.o, b.curve.frame.o), 0.5);
    const lateral = laterals.length;
    laterals.push({
      face: f,
      probe: add3(mid, scale3(surface.frame.x, surface.radius)),
      axis,
      centre: a.curve.frame.o,
      radius: surface.radius,
      loops: [a.loop, b.loop],
    });
    for (const end of ends) {
      holes.push({
        face: end.face,
        loop: end.loop,
        centre: end.curve.frame.o,
        radius: end.curve.radius,
        lateral,
      });
    }
  }
  // A circle inner loop that no cylinder face shares is not a through hole this path understands.
  if (holes.length !== holeByEdge.size) return null;
  return {
    laterals,
    holes,
    lateralFaces: new Set(laterals.map((l) => l.face)),
    holeLoops: new Set(holes.map((h) => h.loop)),
  };
}

function segmentDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const px = ax + dx * t;
  const py = ay + dy * t;
  return Math.sqrt(px * px + py * py);
}

/** True when the origin lies within or on the closed 2D ring (non-zero winding). */
function windsAroundOrigin(ring: readonly (readonly [number, number])[]): boolean {
  let winding = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i] as readonly [number, number];
    const [bx, by] = ring[(i + 1) % ring.length] as readonly [number, number];
    const turn = ax * by - ay * bx;
    if (ay <= 0) {
      if (by > 0 && turn > 0) winding += 1;
    } else if (by <= 0 && turn < 0) winding -= 1;
  }
  return winding !== 0;
}

/**
 * Bounded-chord test: every face polygon of the other solid, projected along the hole axis, stays more
 * than the radius plus `tol` away from the axis and does not cover it. Then no section chord of the
 * other solid touches either circle of the hole and no other face crosses its cylinder, so the hole lies
 * wholly inside or wholly outside the other solid. Conservative: the hole's height range is ignored.
 */
export function clearOfFaces(
  lateral: CarriedLateral,
  polygons: readonly (readonly P3[])[],
  tol: number,
): boolean {
  const z = lateral.axis;
  const helper: P3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = cross3(z, helper);
  const xn = Math.sqrt(dot3(x, x));
  const u: P3 = [x[0] / xn, x[1] / xn, x[2] / xn];
  const v = cross3(z, u);
  for (const polygon of polygons) {
    const ring = polygon.map((p) => {
      const w = sub3(p, lateral.centre);
      return [dot3(w, u), dot3(w, v)] as const;
    });
    if (windsAroundOrigin(ring)) return false;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i] as readonly [number, number];
      const [bx, by] = ring[(i + 1) % ring.length] as readonly [number, number];
      if (!(segmentDistance(ax, ay, bx, by) > lateral.radius + tol)) return false;
    }
  }
  return true;
}

/**
 * Where a circle hole of a planar face lies against one merged result region of that face: `inside`
 * when its centre is inside the region and the whole circle clears every region edge, `outside` when
 * the centre is outside and the circle clears every edge, `touching` otherwise (the caller refuses).
 */
export function holdsCircle(
  rings: readonly (readonly P3[])[],
  hole: CircleHole,
  normal: P3,
  tol: number,
): 'inside' | 'outside' | 'touching' {
  const helper: P3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = cross3(normal, helper);
  const xn = Math.sqrt(dot3(x, x));
  const u: P3 = [x[0] / xn, x[1] / xn, x[2] / xn];
  const v = cross3(normal, u);
  let inside = false;
  for (let k = 0; k < rings.length; k++) {
    const ring = (rings[k] as readonly P3[]).map((p) => {
      const w = sub3(p, hole.centre);
      return [dot3(w, u), dot3(w, v)] as const;
    });
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i] as readonly [number, number];
      const [bx, by] = ring[(i + 1) % ring.length] as readonly [number, number];
      if (!(segmentDistance(ax, ay, bx, by) > hole.radius + tol)) return 'touching';
    }
    const winds = windsAroundOrigin(ring);
    if (k === 0) inside = winds;
    else if (winds) inside = false;
  }
  return inside ? 'inside' : 'outside';
}
