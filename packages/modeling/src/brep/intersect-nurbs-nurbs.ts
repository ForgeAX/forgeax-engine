import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import type { SurfaceIntersection } from './intersect';
import { sectionFromSsi } from './intersect-nurbs-analytic';
import { intersectFaces } from './ssi/intersect-faces';
import type { Surface } from './types';
import { deepFreeze } from './types';

type NurbsFace = Extract<Surface, { kind: 'nurbs' }>;

/**
 * NURBS x NURBS through the marched SSI route over both parameter boxes. Unlike the analytic
 * pairing there is no covering window: both faces are bounded by their own knot domains.
 */
export function nurbsNurbsSection(
  a: NurbsFace,
  b: NurbsFace,
  o: { readonly tol: number; readonly ids: readonly [number, number] },
): Result<SurfaceIntersection, ModelingError> {
  const r = intersectFaces({ surface: a }, { surface: b }, { tol: o.tol });
  if (!r.ok) return r;
  return ok(deepFreeze(sectionFromSsi(r.value, o.ids, true)));
}
