import { ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import type { Tuple3 } from '../geom';
import type { NurbsCurve, NurbsSurface } from '../nurbs';
import type { Curve, Frame, Shape, Surface, Vertex } from './types';
import { brepFail } from './types';
import type { P3 } from './vec';

/**
 * A rigid placement: a proper rotation (rows of `rot` are its axes) followed by a translation.
 * Only rigid motions are accepted, so distances, angles and every pcurve in face (u, v) are preserved.
 */
export interface Placement {
  readonly rot: readonly [P3, P3, P3];
  readonly t: P3;
}

const EPS = 1e-9;

const row = (r: Placement['rot'], i: 0 | 1 | 2): P3 => (i === 0 ? r[0] : i === 1 ? r[1] : r[2]);
const at = (v: P3, k: 0 | 1 | 2): number => (k === 0 ? v[0] : k === 1 ? v[1] : v[2]);

function det3(r: Placement['rot']): number {
  const [a, b, c] = [row(r, 0), row(r, 1), row(r, 2)];
  return (
    at(a, 0) * (at(b, 1) * at(c, 2) - at(b, 2) * at(c, 1)) -
    at(a, 1) * (at(b, 0) * at(c, 2) - at(b, 2) * at(c, 0)) +
    at(a, 2) * (at(b, 0) * at(c, 1) - at(b, 1) * at(c, 0))
  );
}

function isRigid(rot: Placement['rot']): boolean {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const ri = row(rot, i as 0 | 1 | 2);
      const rj = row(rot, j as 0 | 1 | 2);
      const d = at(ri, 0) * at(rj, 0) + at(ri, 1) * at(rj, 1) + at(ri, 2) * at(rj, 2);
      if (Math.abs(d - (i === j ? 1 : 0)) > EPS) return false;
    }
  }
  return Math.abs(det3(rot) - 1) <= EPS;
}

/** The identity placement. */
export const IDENTITY_PLACEMENT: Placement = {
  rot: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  t: [0, 0, 0],
};

/** Rotation about a coordinate axis by `angle` radians (right-handed). */
export function axisRotation(axis: 0 | 1 | 2, angle: number): Placement['rot'] {
  const c = cos(angle);
  const s = sin(angle);
  if (axis === 0) {
    return [
      [1, 0, 0],
      [0, c, -s],
      [0, s, c],
    ];
  }
  if (axis === 1) {
    return [
      [c, 0, s],
      [0, 1, 0],
      [-s, 0, c],
    ];
  }
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}

function apply(p: Placement, v: P3): Tuple3 {
  const r = p.rot;
  return [
    r[0][0] * v[0] + r[0][1] * v[1] + r[0][2] * v[2] + p.t[0],
    r[1][0] * v[0] + r[1][1] * v[1] + r[1][2] * v[2] + p.t[1],
    r[2][0] * v[0] + r[2][1] * v[1] + r[2][2] * v[2] + p.t[2],
  ];
}

/** Rotates a direction only; the translation does not move directions. */
function applyDir(p: Placement, v: P3): P3 {
  const r = p.rot;
  return [
    r[0][0] * v[0] + r[0][1] * v[1] + r[0][2] * v[2],
    r[1][0] * v[0] + r[1][1] * v[1] + r[1][2] * v[2],
    r[2][0] * v[0] + r[2][1] * v[1] + r[2][2] * v[2],
  ];
}

function frameOf(p: Placement, f: Frame): Frame {
  return { o: apply(p, f.o), x: applyDir(p, f.x), y: applyDir(p, f.y), z: applyDir(p, f.z) };
}

/**
 * A rational B-spline keeps its weights, knots and degrees: rigid motion is affine, so applying it
 * to each Euclidean control point with its weight unchanged moves the homogeneous net exactly.
 */
function placedNurbsCurve(p: Placement, c: NurbsCurve): NurbsCurve {
  return { ...c, points: c.points.map((q) => apply(p, q)) };
}

function placedNurbsSurface(p: Placement, s: NurbsSurface): NurbsSurface {
  return { ...s, points: s.points.map((row) => row.map((q) => apply(p, q))) };
}

function surfaceOf(p: Placement, s: Surface): Surface {
  if (s.kind === 'nurbs') return { kind: 'nurbs', surface: placedNurbsSurface(p, s.surface) };
  return { ...s, frame: frameOf(p, s.frame) } as Surface;
}

function curveOf(p: Placement, c: Curve): Curve {
  switch (c.kind) {
    case 'line':
      return { kind: 'line', o: apply(p, c.o), d: applyDir(p, c.d) };
    case 'circle':
    case 'ellipse':
      return { ...c, frame: frameOf(p, c.frame) } as Curve;
    case 'nurbs':
      return { kind: 'nurbs', curve: placedNurbsCurve(p, c.curve) };
  }
}

function vertexOf(p: Placement, v: Vertex): Vertex {
  return { ...v, p: apply(p, v.p) };
}

/**
 * Moves a shape rigidly. Topology, pcurves and tolerances are unchanged; every 3D point, frame, NURBS
 * control point and line direction is carried by the placement. The move is exact for every surface
 * and curve kind; cached evaluator state is keyed by object identity, so the moved data starts fresh.
 */
export function transformShape(shape: Shape, placement: Placement): Result<Shape, ModelingError> {
  if (!isRigid(placement.rot)) {
    return brepFail('brep-bad-argument', 'a proper rotation (orthonormal, det +1)', {});
  }
  return ok({
    ...shape,
    vertices: shape.vertices.map((v) => vertexOf(placement, v)),
    surfaces: shape.surfaces.map((s) => surfaceOf(placement, s)),
    curves: shape.curves.map((c) => curveOf(placement, c)),
  });
}
