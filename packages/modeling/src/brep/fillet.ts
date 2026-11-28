import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { type BlendSide, edgeFaces, type Section, sectionOf, sideOf, sweptCurve } from './blend';
import { filletCorner, normalAt, partial } from './section';
import { brepFail, type Curve, type Edge, type Shape, type Surface } from './types';
import { madd3, type P2 } from './vec';

/**
 * Closed-form blend geometry of one edge: the blend surface with its orientation, the spine (the
 * ball-center path, or the corner for a chamfer) and the two contact curves, all parameterized by the
 * edge parameter. `section` keeps the 2D solution for topology rebuilds.
 */
export interface EdgeBlend {
  readonly family: Section['family'];
  readonly convex: boolean;
  readonly surface: Surface;
  /** The blend face's outward normal is the surface normal flipped. */
  readonly reversed: boolean;
  /** Fillet: ball-center curve, absent when it collapses onto the axis (a sphere cap). Chamfer: the original edge. */
  readonly spine?: Curve;
  readonly contactA: Curve;
  readonly contactB: Curve;
  readonly section: Section;
  /** Section coordinates of the spine (center) and the two contacts. */
  readonly center: P2;
  readonly a: P2;
  readonly b: P2;
}

/** Relative size below which a ball center counts as on the axis of revolution. */
const ON_AXIS = 1e-9;

/**
 * The constant-radius rolling-ball fillet of an edge between faces `a` and `b` (sides as seen at edge
 * parameter `t`). Extrusion pairs give a cylinder; revolution pairs give a torus (or a sphere when the
 * ball center lies on the axis). A spindle torus, a ball that cannot touch both faces, and every other
 * pair are `model-partial` with `detail.reason`.
 */
export function filletBetween(
  edge: Curve,
  t: number,
  a: BlendSide,
  b: BlendSide,
  radius: number,
  tol: number,
): Result<EdgeBlend, ModelingError> {
  if (!(Number.isFinite(radius) && radius > 2 * tol)) {
    return brepFail('brep-bad-argument', 'a fillet radius greater than twice the tolerance', {
      radius,
      tol,
    });
  }
  const s = sectionOf(edge, t, a, b);
  if (!s.ok) return s;
  const sec = s.value;
  const corner = filletCorner(sec.a, sec.ta, sec.b, sec.tb, sec.at, radius, tol);
  if (!corner.ok) return corner;
  const { center, convex } = corner.value;
  const pa = corner.value.a;
  const pb = corner.value.b;
  let surface: Surface;
  let spine: Curve | undefined;
  if (sec.family === 'extrusion') {
    const line = sweptCurve(sec, center) as Curve & { kind: 'line' };
    surface = {
      kind: 'cylinder',
      frame: { o: line.o, x: sec.x, y: sec.y, z: sec.axis },
      radius,
    };
    spine = line;
  } else {
    const f = (edge as Curve & { kind: 'circle' }).frame;
    const frame = { ...f, o: madd3(f.o, f.z, center[1]) };
    if (Math.abs(center[0]) <= ON_AXIS * Math.max(1, radius)) {
      surface = { kind: 'sphere', frame, radius };
    } else if (center[0] > radius) {
      surface = { kind: 'torus', frame, major: center[0], minor: radius };
      spine = sweptCurve(sec, center);
    } else {
      return partial('blend-spindle', 'a ball center farther from the axis than the radius', {
        center: center[0],
        radius,
      });
    }
  }
  // The blend surface's own normal points away from the ball center; the face must agree with face a.
  const out = normalAt(sec.a, pa);
  const reversed = (pa[0] - center[0]) * out[0] + (pa[1] - center[1]) * out[1] < 0;
  return ok({
    family: sec.family,
    convex,
    surface,
    reversed,
    ...(spine === undefined ? {} : { spine }),
    contactA: sweptCurve(sec, pa),
    contactB: sweptCurve(sec, pb),
    section: sec,
    center,
    a: pa,
    b: pb,
  });
}

/** The two sides of a manifold edge of a shape, at the edge's mid parameter. */
export function edgeSides(
  shape: Shape,
  e: number,
): Result<{ edge: Curve; t: number; a: BlendSide; b: BlendSide }, ModelingError> {
  const edge = shape.edges[e] as Edge | undefined;
  if (edge === undefined || edge.curve < 0) {
    return brepFail('brep-bad-argument', 'a regular edge index', { edge: e });
  }
  const uses = edgeFaces(shape, e);
  if (uses === undefined) {
    return brepFail('brep-edge-use', 'an edge shared by exactly two faces', { edge: e });
  }
  const t = (edge.t0 + edge.t1) / 2;
  return ok({
    edge: shape.curves[edge.curve] as Curve,
    t,
    a: sideOf(shape, uses.faces[0], uses.coedges[0], t),
    b: sideOf(shape, uses.faces[1], uses.coedges[1], t),
  });
}

/** `filletBetween` for edge `e` of a shape. */
export function filletEdgeGeometry(
  shape: Shape,
  e: number,
  radius: number,
): Result<EdgeBlend, ModelingError> {
  const sides = edgeSides(shape, e);
  if (!sides.ok) return sides;
  const { edge, t, a, b } = sides.value;
  return filletBetween(edge, t, a, b, radius, shape.tol);
}
