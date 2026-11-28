import { ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, hypot2, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { type BlendSide, sectionOf, sweptCurve } from './blend';
import type { EdgeBlend } from './fillet';
import { edgeSides } from './fillet';
import { chamferCorner, normalAt } from './section';
import { brepFail, type Curve, type Shape, type Surface } from './types';
import { cross3, madd3, type P2, scale3, unit3 } from './vec';

/**
 * The equal-distance chamfer of an edge between faces `a` and `b`: the ruled face through the two
 * setback curves at distance `d` from the edge (chord distance on a curved section). Extrusion pairs
 * give a plane; revolution pairs give a plane, cylinder or cone. `center` is the edge point and the
 * spine is the edge itself.
 */
export function chamferBetween(
  edge: Curve,
  t: number,
  a: BlendSide,
  b: BlendSide,
  d: number,
  tol: number,
): Result<EdgeBlend, ModelingError> {
  if (!(Number.isFinite(d) && d > 2 * tol)) {
    return brepFail('brep-bad-argument', 'a chamfer distance greater than twice the tolerance', {
      d,
      tol,
    });
  }
  const s = sectionOf(edge, t, a, b);
  if (!s.ok) return s;
  const sec = s.value;
  const corner = chamferCorner(sec.a, sec.ta, sec.b, sec.tb, sec.at, d);
  if (!corner.ok) return corner;
  const { a: pa, b: pb, convex } = corner.value;
  const na = normalAt(sec.a, pa);
  const nb = normalAt(sec.b, pb);
  // The chamfer is a compromise of the two face normals for a convex and a concave corner alike.
  const bis: P2 = [na[0] + nb[0], na[1] + nb[1]];
  let surface: Surface;
  let natural: P2;
  if (sec.family === 'extrusion') {
    const chord = unit3(madd3(scale3(sec.x, pb[0] - pa[0]), sec.y, pb[1] - pa[1]));
    const n = cross3(sec.axis, chord);
    const o = (sweptCurve(sec, pa) as Curve & { kind: 'line' }).o;
    surface = { kind: 'plane', frame: { o, x: chord, y: cross3(n, chord), z: n } };
    const l = hypot2(pb[0] - pa[0], pb[1] - pa[1]);
    natural = [-(pb[1] - pa[1]) / l, (pb[0] - pa[0]) / l];
  } else {
    const f = (edge as Curve & { kind: 'circle' }).frame;
    const lo = pa[1] <= pb[1] ? pa : pb;
    const hi = pa[1] <= pb[1] ? pb : pa;
    const dr = hi[0] - lo[0];
    const dz = hi[1] - lo[1];
    const frame = { ...f, o: madd3(f.o, f.z, lo[1]) };
    if (Math.abs(dz) <= tol) {
      surface = { kind: 'plane', frame };
      natural = [0, 1];
    } else if (Math.abs(dr) <= tol) {
      surface = { kind: 'cylinder', frame: { ...f }, radius: lo[0] };
      natural = [1, 0];
    } else {
      const halfAngle = atan2(dr, dz);
      surface = { kind: 'cone', frame, radius: lo[0], halfAngle };
      natural = [cos(halfAngle), -sin(halfAngle)];
    }
  }
  return ok({
    family: sec.family,
    convex,
    surface,
    reversed: natural[0] * bis[0] + natural[1] * bis[1] < 0,
    spine: edge,
    contactA: sweptCurve(sec, pa),
    contactB: sweptCurve(sec, pb),
    section: sec,
    center: sec.at,
    a: pa,
    b: pb,
  });
}

/** `chamferBetween` for edge `e` of a shape. */
export function chamferEdgeGeometry(
  shape: Shape,
  e: number,
  d: number,
): Result<EdgeBlend, ModelingError> {
  const sides = edgeSides(shape, e);
  if (!sides.ok) return sides;
  const { edge, t, a, b } = sides.value;
  return chamferBetween(edge, t, a, b, d, shape.tol);
}
