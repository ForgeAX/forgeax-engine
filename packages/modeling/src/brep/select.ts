import { ok, type Result } from '@forgeax/engine-types';
import { cos } from '../dmath';
import type { ModelingError } from '../errors';
import { pcurvePoint } from './curves';
import { coedgeEnds, gridOf } from './faces';
import { surfaceNormal, surfacePoint } from './surfaces';
import { brepFail, type Face, type Shape, type SurfaceKind } from './types';
import { dist3, dot3, neg3, type P3, unit3 } from './vec';

/** Every given key must match; an absent key matches all faces. */
export interface FaceQuery {
  /** Exact face label, for example `plate.top`. */
  readonly label?: string;
  /** Face labels starting with this prefix, for example `plate.`. */
  readonly labelPrefix?: string;
  readonly role?: string;
  readonly surface?: SurfaceKind;
  /** The outward normal at the face's representative point lies within `angle` radians (default 1e-3) of `dir`. */
  readonly normal?: { readonly dir: P3; readonly angle?: number };
  /** The face's representative point lies within `radius` of `point`. */
  readonly near?: { readonly point: P3; readonly radius: number };
}

const DEFAULT_ANGLE = 1e-3;

const CIRCLE_SAMPLES = 64;
const SCAN_FRACTIONS = [0.5, 0.25, 0.75, 0.375, 0.625] as const;

type Ring = readonly (readonly [number, number])[];

/** Closed (u, v) polygons of a planar face's loops: lines by their end points, circles by uniform samples. */
function planarRings(shape: Shape, face: Face): { outer: Ring[]; all: Ring[] } {
  const outer: Ring[] = [];
  const all: Ring[] = [];
  for (const l of face.loops) {
    const loop = shape.loops[l] as Shape['loops'][number];
    const ring: [number, number][] = [];
    for (const c of loop.coedges) {
      const co = shape.coedges[c] as Shape['coedges'][number];
      const edge = shape.edges[co.edge] as Shape['edges'][number];
      if (co.pcurve.kind === 'line') {
        const start = coedgeEnds(edge, co).start;
        ring.push([start[0], start[1]]);
        continue;
      }
      for (let k = 0; k < CIRCLE_SAMPLES; k++) {
        const p = pcurvePoint(co.pcurve, edge.t0 + ((edge.t1 - edge.t0) * k) / CIRCLE_SAMPLES);
        ring.push([p[0], p[1]]);
      }
    }
    all.push(ring);
    if (loop.outer) outer.push(ring);
  }
  return { outer, all };
}

/**
 * A point inside a planar face: the midpoint of the widest even-odd scan interval across the face's loops on
 * a few horizontal lines of the outline's extent (the middle line first). Holes and notches are never
 * crossed; the point can only leave the face if the widest interval is thinner than the circle sampling error.
 */
function planarInterior(shape: Shape, face: Face): readonly [number, number] | undefined {
  const { outer, all } = planarRings(shape, face);
  let lo = Infinity;
  let hi = -Infinity;
  for (const ring of outer) {
    for (const p of ring) {
      lo = Math.min(lo, p[1]);
      hi = Math.max(hi, p[1]);
    }
  }
  const eps = (hi - lo) * 1e-9;
  const ys: number[] = [];
  for (const ring of all) for (const p of ring) ys.push(p[1]);
  ys.sort((p, q) => p - q);
  const slabs: number[] = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    if ((ys[i + 1] as number) - (ys[i] as number) > eps) {
      slabs.push(((ys[i] as number) + (ys[i + 1] as number)) / 2);
    }
  }
  let best: readonly [number, number] | undefined;
  let bestWidth = 0;
  if (slabs.length === 0) return best;
  for (const fraction of SCAN_FRACTIONS) {
    const target = lo + (hi - lo) * fraction;
    let k = 0;
    while (k + 1 < slabs.length && (slabs[k + 1] as number) <= target) k++;
    if (
      k + 1 < slabs.length &&
      Math.abs((slabs[k + 1] as number) - target) < Math.abs((slabs[k] as number) - target)
    ) {
      k++;
    }
    const y = slabs[k] as number;
    const xs: number[] = [];
    for (const ring of all) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i] as readonly [number, number];
        const b = ring[j] as readonly [number, number];
        if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = (xs[i + 1] as number) - (xs[i] as number);
      if (width > bestWidth) {
        bestWidth = width;
        best = [((xs[i] as number) + (xs[i + 1] as number)) / 2, y];
      }
    }
  }
  return best;
}

/**
 * (u, v) of a face's reference: the grid centre; else, on a plane, a point inside the face region (holes and
 * notches excluded); else the start of the first outer coedge, which lies on the face.
 */
function referenceUv(shape: Shape, f: number): readonly [number, number] {
  const grid = gridOf(shape, f);
  if (grid.ok) return [(grid.value.u0 + grid.value.u1) / 2, (grid.value.v0 + grid.value.v1) / 2];
  const face = shape.faces[f] as Face;
  if ((shape.surfaces[face.surface] as Shape['surfaces'][number]).kind === 'plane') {
    return planarInterior(shape, face) ?? [0, 0];
  }
  for (const l of face.loops) {
    const loop = shape.loops[l] as Shape['loops'][number];
    if (!loop.outer) continue;
    const co = shape.coedges[loop.coedges[0] as number] as Shape['coedges'][number];
    return coedgeEnds(shape.edges[co.edge] as Shape['edges'][number], co).start;
  }
  return [0, 0];
}

/** A face's reference point and outward normal; selectors and tests use the same evaluation. */
export function faceReference(shape: Shape, f: number): { point: P3; normal: P3 } {
  const face = shape.faces[f] as Face;
  const surface = shape.surfaces[face.surface] as Shape['surfaces'][number];
  const [u, v] = referenceUv(shape, f);
  const n = unit3(surfaceNormal(surface, u, v));
  return { point: surfacePoint(surface, u, v), normal: face.reversed ? neg3(n) : n };
}

/** Face indices, ascending, whose label, role, surface kind, normal and position all match `query`. */
export function selectFaces(
  shape: Shape,
  query: FaceQuery,
): Result<readonly number[], ModelingError> {
  const normal = query.normal;
  if (normal !== undefined) {
    if (typeof normal !== 'object' || normal === null) {
      return brepFail('brep-bad-argument', 'a normal query object', { key: 'normal' });
    }
    const d = normal.dir;
    const length2 =
      Array.isArray(d) && d.length === 3 && d.every((x) => typeof x === 'number')
        ? d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
        : NaN;
    if (!(Number.isFinite(length2) && length2 > 0)) {
      return brepFail('brep-bad-argument', 'a finite nonzero normal direction', { key: 'normal' });
    }
    if (
      normal.angle !== undefined &&
      !(typeof normal.angle === 'number' && normal.angle >= 0 && normal.angle <= Math.PI)
    ) {
      return brepFail('brep-bad-argument', 'a normal angle in [0, pi]', { key: 'normal.angle' });
    }
  }
  const near = query.near;
  if (near !== undefined) {
    if (typeof near !== 'object' || near === null) {
      return brepFail('brep-bad-argument', 'a near query object', { key: 'near' });
    }
    const p = near.point;
    if (
      !(
        Array.isArray(p) &&
        p.length === 3 &&
        p.every((x) => typeof x === 'number' && Number.isFinite(x))
      )
    ) {
      return brepFail('brep-bad-argument', 'a finite near point', { key: 'near.point' });
    }
    if (!(typeof near.radius === 'number' && near.radius >= 0 && Number.isFinite(near.radius))) {
      return brepFail('brep-bad-argument', 'a finite non-negative radius', { key: 'near.radius' });
    }
  }
  const minDot = normal === undefined ? 0 : cos(normal.angle ?? DEFAULT_ANGLE);
  const dir = normal === undefined ? undefined : unit3(normal.dir);
  const out: number[] = [];
  for (let f = 0; f < shape.faces.length; f++) {
    const face = shape.faces[f] as Face;
    if (query.label !== undefined && face.label !== query.label) continue;
    if (query.labelPrefix !== undefined && !face.label.startsWith(query.labelPrefix)) continue;
    if (query.role !== undefined && face.role !== query.role) continue;
    if (
      query.surface !== undefined &&
      (shape.surfaces[face.surface] as Shape['surfaces'][number]).kind !== query.surface
    ) {
      continue;
    }
    if (dir !== undefined || near !== undefined) {
      const ref = faceReference(shape, f);
      if (dir !== undefined && dot3(ref.normal, dir) < minDot) continue;
      if (near !== undefined && dist3(ref.point, near.point) > near.radius) continue;
    }
    out.push(f);
  }
  return ok(Object.freeze(out));
}

/** Exactly one matching face; zero or several matches is `brep-bad-argument` with the match count. */
export function selectFace(shape: Shape, query: FaceQuery): Result<number, ModelingError> {
  const all = selectFaces(shape, query);
  if (!all.ok) return all;
  if (all.value.length !== 1) {
    return brepFail('brep-bad-argument', 'a query matching exactly one face', {
      matches: all.value.length,
    });
  }
  return ok(all.value[0] as number);
}
