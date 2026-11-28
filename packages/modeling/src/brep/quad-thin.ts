import { maxOf, minOf } from '../arrays';
import { faceLoops } from './faces';
import type { Coedge, Curve, Face, Shape, Surface } from './types';
import { dot3, len3, type P3, scale3, sub3 } from './vec';

/**
 * Thin planar features. Two planar faces whose outward normals oppose, whose planes are closer than twice the element
 * size and whose outlines overlap enclose a wall (a rib, a web, a flange). The straight edges that join the two faces
 * across the wall carry its thickness; the caller floors them at two samples and keeps them even, so the wall never
 * meshes as one row of stretched elements. Only straight outlines are judged; a curved outline is left to the generic
 * route.
 */

/** Fewest rows across a thin wall. */
export const THIN_MIN_ROWS = 2;

interface PlaneFace {
  readonly face: number;
  readonly normal: P3;
  readonly origin: P3;
  readonly vertices: ReadonlySet<number>;
  readonly lo: P3;
  readonly hi: P3;
}

function planeFaces(shape: Shape): PlaneFace[] {
  const out: PlaneFace[] = [];
  shape.faces.forEach((face: Face, f) => {
    const surface = shape.surfaces[face.surface] as Surface;
    if (surface.kind !== 'plane') return;
    const { outer, holes } = faceLoops(shape, f);
    if (outer.length === 0 || holes.length > 0) return;
    const vertices = new Set<number>();
    for (const c of outer) {
      const e = shape.edges[(shape.coedges[c] as Coedge).edge];
      if (e === undefined || e.curve < 0 || (shape.curves[e.curve] as Curve).kind !== 'line')
        return;
      vertices.add(e.v0);
      vertices.add(e.v1);
    }
    const pts = [...vertices].map((v) => shape.vertices[v]?.p as P3);
    const lo = [0, 1, 2].map((i) => minOf(pts.map((p) => p[i] as number))) as unknown as P3;
    const hi = [0, 1, 2].map((i) => maxOf(pts.map((p) => p[i] as number))) as unknown as P3;
    const len = len3(surface.frame.z);
    const normal = scale3(surface.frame.z, (face.reversed ? -1 : 1) / len);
    out.push({ face: f, normal, origin: surface.frame.o, vertices, lo, hi });
  });
  return out;
}

/** Boxes overlap with positive extent along every axis that is not the wall's normal direction. */
function overlaps(a: PlaneFace, b: PlaneFace): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.normal[i] as number) > 0.5) continue;
    const gap =
      Math.min(a.hi[i] as number, b.hi[i] as number) -
      Math.max(a.lo[i] as number, b.lo[i] as number);
    if (gap <= 0) return false;
  }
  return true;
}

/** Edges that cross a thin wall (floored at THIN_MIN_ROWS, kept even), derived from the shape and the element size. */
export function thinWallEdges(shape: Shape, size: number): Set<number> {
  const planes = planeFaces(shape);
  const out = new Set<number>();
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      const a = planes[i] as PlaneFace;
      const b = planes[j] as PlaneFace;
      if (dot3(a.normal, b.normal) > -1 + 1e-9) continue;
      const gap = dot3(sub3(a.origin, b.origin), a.normal);
      if (!(gap > 0) || gap >= THIN_MIN_ROWS * size || !overlaps(a, b)) continue;
      shape.edges.forEach((e, ei) => {
        if (e.curve < 0 || (shape.curves[e.curve] as Curve).kind !== 'line') return;
        const across =
          (a.vertices.has(e.v0) && b.vertices.has(e.v1)) ||
          (a.vertices.has(e.v1) && b.vertices.has(e.v0));
        if (!across) return;
        const p0 = shape.vertices[e.v0]?.p as P3;
        const p1 = shape.vertices[e.v1]?.p as P3;
        if (Math.abs(dot3(sub3(p1, p0), a.normal)) > gap * (1 - 1e-6)) out.add(ei);
      });
    }
  }
  return out;
}
