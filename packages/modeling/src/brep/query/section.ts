import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../../arrays';
import type { ModelingError } from '../../errors';
import { surfacePoint } from '../surfaces';
import { brepError, type Shape, type Surface } from '../types';
import { len3, type P3, scale3 } from '../vec';
import { contourFace, type FaceCurve } from './contour';
import { type JoinedCurve, stitch } from './stitch';
import { trimIndexOf } from './trim-index';

export interface Plane {
  readonly origin: P3;
  readonly normal: P3;
}

export interface SectionOptions {
  /** Grid cells per side of each face's parameter box (default 64). */
  readonly resolution?: number;
  /** Largest vertex distance from the plane accepted for a coplanar face (default `shape.tol`). */
  readonly flatTol?: number;
}

export interface PlaneSection {
  readonly plane: Plane;
  /** The cut, with face curves joined across shared edges. */
  readonly curves: readonly JoinedCurve[];
  /** Faces that lie in the plane; they are reported, not turned into curves. */
  readonly coplanarFaces: readonly number[];
  /** Largest distance of a curve vertex from the plane (the vertices are bisected onto it). */
  readonly residual: number;
  /** Largest distance from the plane of a chord midpoint: sag of the polylines between vertices. */
  readonly chordResidual: number;
}

export function unitPlane(plane: Plane): Result<Plane, ModelingError> {
  const n = len3(plane.normal);
  if (!(n > 1e-12) || !plane.origin.every(Number.isFinite) || !plane.normal.every(Number.isFinite))
    return err(
      brepError('brep-bad-argument', 'a plane with a finite origin and a non-zero normal', {
        reason: 'section-plane',
      }),
    );
  return ok({ origin: plane.origin, normal: scale3(plane.normal, 1 / n) });
}

/** Traces the intersection of the plane with every face of the shape as polylines on the real surface. */
export function sectionByPlane(
  shape: Shape,
  plane: Plane,
  options: SectionOptions = {},
): Result<PlaneSection, ModelingError> {
  const pl = unitPlane(plane);
  if (!pl.ok) return pl;
  const res = options.resolution ?? 64;
  if (!Number.isInteger(res) || res < 2 || res > 1024)
    return err(
      brepError('brep-bad-argument', 'an integer resolution in [2, 1024]', {
        reason: 'section-resolution',
      }),
    );
  const flatTol = options.flatTol ?? shape.tol;
  const { origin, normal } = pl.value;
  const curves: FaceCurve[] = [];
  const coplanar: number[] = [];
  let residual = 0;
  let chordResidual = 0;
  for (let f = 0; f < shape.faces.length; f++) {
    const surface = shape.surfaces[(shape.faces[f] as Shape['faces'][number]).surface] as Surface;
    const trim = trimIndexOf(shape, f);
    if (!trim.ok) return trim;
    const height = (u: number, v: number): number => {
      const p = surfacePoint(surface, u, v);
      return (
        (p[0] - origin[0]) * normal[0] +
        (p[1] - origin[1]) * normal[1] +
        (p[2] - origin[2]) * normal[2]
      );
    };
    const c = contourFace(f, surface, trim.value, height, res, flatTol);
    if (c.flat) {
      coplanar.push(f);
      continue;
    }
    pushAll(curves, c.curves);
    residual = Math.max(residual, c.residual);
    chordResidual = Math.max(chordResidual, c.chordResidual);
  }
  return ok({
    plane: pl.value,
    curves: stitch(curves, Math.max(shape.tol, 1e-6 * extentOf(shape))),
    coplanarFaces: coplanar,
    residual,
    chordResidual,
  });
}

function extentOf(shape: Shape): number {
  let m = 0;
  for (const v of shape.vertices)
    m = Math.max(m, Math.abs(v.p[0]), Math.abs(v.p[1]), Math.abs(v.p[2]));
  return Math.max(m, 1e-300);
}
