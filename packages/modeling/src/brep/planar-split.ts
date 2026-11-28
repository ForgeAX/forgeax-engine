import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { brepFail } from './types';
import { cross3, dist3, dot3, len3, type P2, type P3, sub3 } from './vec';

/**
 * E1d slice A: split a planar polygon along a straight section between two of its boundary points.
 *
 * The polygon is its outer loop in order (counter-clockwise seen from the face normal). A chord
 * between vertex `i` and vertex `j` (non-adjacent) divides it into two simple polygons: the loop
 * from `i` to `j`, then back along the chord, and the loop from `j` to `i`, then back along the
 * chord. Both sub-loops share the chord, traversed in opposite directions, so each shared edge is
 * used once by each face. Nothing here touches booleanSolids; the caller decides where to cut.
 */
export interface PlanarSplit {
  /** Sub-polygon on the `i -> j` side: the boundary from i to j, then the chord back to i. */
  readonly first: readonly P3[];
  /** Sub-polygon on the `j -> i` side: the boundary from j to i, then the chord back to j. */
  readonly second: readonly P3[];
}

/** Signed area of the polygon in its own plane (positive when counter-clockwise about `normal`). */
function signedArea(poly: readonly P3[], origin: P3, normal: P3): number {
  let s = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = sub3(poly[k] as P3, origin);
    const q = sub3(poly[(k + 1) % poly.length] as P3, origin);
    s += dot3(normal, cross3(p, q));
  }
  return s / 2;
}

/** 2D point-in-polygon by ray parity, in the plane spanned by `u` and `v` through `origin`. */
function insideProjected(poly: readonly P2[], p: P2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as P2;
    const b = poly[j] as P2;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Split `poly` along the chord `i -> j`. Returns the two sub-polygons, or a structured failure when
 * the chord is not a valid section: indices out of range, adjacent or equal vertices, the chord
 * leaving the polygon, or a degenerate (zero-area) side. A failure is never a partial split.
 */
export function splitPlanarPolygon(
  poly: readonly P3[],
  i: number,
  j: number,
  tol: number,
): Result<PlanarSplit, ModelingError> {
  const n = poly.length;
  if (n < 3) return brepFail('brep-bad-argument', 'a polygon with at least three vertices', {});
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= n || j >= n)
    return brepFail('brep-bad-argument', 'chord vertices inside the polygon', { i, j, n });
  if (i === j) return brepFail('brep-bad-argument', 'a chord between two distinct vertices', {});
  if ((i + 1) % n === j || (j + 1) % n === i)
    return brepFail('brep-bad-argument', 'a chord joining non-adjacent vertices', { i, j });

  const pi = poly[i] as P3;
  const pj = poly[j] as P3;
  if (dist3(pi, pj) <= tol)
    return brepFail('brep-bad-argument', 'chord endpoints further apart than tol', { i, j });

  // A right-handed plane frame from the polygon's own normal, so the 2D test matches 3D.
  // Newell's normal: the plane of the whole loop, stable even when the first corner is collinear.
  const origin = poly[0] as P3;
  let normal: P3 = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const p = sub3(poly[k] as P3, origin);
    const q = sub3(poly[(k + 1) % n] as P3, origin);
    const c = cross3(p, q);
    normal = [normal[0] + c[0], normal[1] + c[1], normal[2] + c[2]];
  }
  const nl = len3(normal);
  if (!(nl > 0)) return brepFail('brep-bad-argument', 'a non-degenerate polygon', {});
  const nn: P3 = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
  const ax = sub3(poly[1] as P3, origin);
  const axl = len3(ax);
  const ex: P3 = [ax[0] / axl, ax[1] / axl, ax[2] / axl];
  const ey = cross3(nn, ex);
  const to2 = (p: P3): P2 => {
    const d = sub3(p, origin);
    return [dot3(d, ex), dot3(d, ey)];
  };
  const flat = poly.map(to2);

  // The chord's midpoint must lie strictly inside the polygon, or the chord leaves the face.
  const mid = to2([(pi[0] + pj[0]) / 2, (pi[1] + pj[1]) / 2, (pi[2] + pj[2]) / 2]);
  if (!insideProjected(flat, mid))
    return brepFail('brep-ssi-unsupported', 'a chord that leaves the polygon', { i, j });

  const first: P3[] = [];
  for (let k = i; ; k = (k + 1) % n) {
    first.push(poly[k] as P3);
    if (k === j) break;
  }
  const second: P3[] = [];
  for (let k = j; ; k = (k + 1) % n) {
    second.push(poly[k] as P3);
    if (k === i) break;
  }
  const a1 = signedArea(first, origin, nn);
  const a2 = signedArea(second, origin, nn);
  if (!(Math.abs(a1) > tol * tol) || !(Math.abs(a2) > tol * tol))
    return brepFail('brep-bad-argument', 'a chord that leaves two non-degenerate sides', {});
  return ok({ first, second });
}
