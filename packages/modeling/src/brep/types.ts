import { err, type Result } from '@forgeax/engine-types';
import { type ModelingError, type ModelingErrorCode, modelingError } from '../errors';
import type { NurbsCurve, NurbsSurface } from '../nurbs';
import type { P2, P3 } from './vec';

/** Right-handed orthonormal frame, `y = z x x`; stored so no consumer recomputes it. */
export interface Frame {
  readonly o: P3;
  readonly x: P3;
  readonly y: P3;
  readonly z: P3;
}

/**
 * Analytic surfaces. `u`/`v` meaning is fixed per kind and the outward normal is `dp/du x dp/dv`:
 * plane `p = o + u x + v y`; cylinder `o + r(cos u x + sin u y) + v z`; sphere
 * `o + r(cos v (cos u x + sin u y) + sin v z)`, `v` in [-pi/2, pi/2]; cone
 * `o + (r + v sin a)(cos u x + sin u y) + v cos a z`; torus `o + (R + r cos v)(cos u x + sin u y) + r sin v z`.
 */
export type Surface =
  | { readonly kind: 'plane'; readonly frame: Frame }
  | { readonly kind: 'cylinder'; readonly frame: Frame; readonly radius: number }
  | { readonly kind: 'sphere'; readonly frame: Frame; readonly radius: number }
  | {
      readonly kind: 'cone';
      readonly frame: Frame;
      /** Radius at `v = 0`. */
      readonly radius: number;
      readonly halfAngle: number;
    }
  | {
      readonly kind: 'torus';
      readonly frame: Frame;
      readonly major: number;
      readonly minor: number;
    }
  | {
      /** A rational B-spline surface; it has no frame and is evaluated by `src/nurbs.ts`. */
      readonly kind: 'nurbs';
      readonly surface: NurbsSurface;
    };

export type SurfaceKind = Surface['kind'];

/** 3D curves: `line` `o + t d` (|d| = 1), `circle` `o + r(cos t x + sin t y)`, `ellipse` `o + a cos t x + b sin t y`. */
export type Curve =
  | { readonly kind: 'line'; readonly o: P3; readonly d: P3 }
  | { readonly kind: 'circle'; readonly frame: Frame; readonly radius: number }
  | { readonly kind: 'ellipse'; readonly frame: Frame; readonly a: number; readonly b: number }
  | { readonly kind: 'nurbs'; readonly curve: NurbsCurve };

/**
 * A curve in the (u, v) of one face, parameterized by the parameter of the EDGE it trims
 * (so `surface(pcurve(t)) = curve(t)`): `line` is `o + t d`, `circle` is
 * `c + r (cos(dir t + phase), sin(dir t + phase))`.
 */
export type PCurve =
  | { readonly kind: 'line'; readonly o: P2; readonly d: P2 }
  | {
      readonly kind: 'circle';
      readonly c: P2;
      readonly r: number;
      readonly phase: number;
      readonly dir: 1 | -1;
    }
  | {
      /** A 2D NURBS trim in (u, v): control points are `[u, v, 0]`; the z component is unused. */
      readonly kind: 'nurbs';
      readonly curve: NurbsCurve;
    };

export interface Vertex {
  readonly p: P3;
  readonly tol: number;
}

/** `curve = -1` is a degenerate edge (a pole or apex): `v0 = v1` and exactly one coedge uses it. */
export interface Edge {
  readonly curve: number;
  readonly t0: number;
  readonly t1: number;
  readonly v0: number;
  readonly v1: number;
  readonly tol: number;
}

/** One use of an edge by a face; `reversed` traverses the edge from `t1` to `t0`. */
export interface Coedge {
  readonly edge: number;
  readonly reversed: boolean;
  readonly pcurve: PCurve;
}

/** Coedges head to tail in (u, v); outer loops run counter-clockwise, holes clockwise. */
export interface Loop {
  readonly coedges: readonly number[];
  readonly outer: boolean;
}

/** `reversed` flips the outward normal relative to `dp/du x dp/dv`; loops keep their (u, v) orientation. */
export interface Face {
  readonly surface: number;
  readonly loops: readonly number[];
  readonly reversed: boolean;
  readonly label: string;
  readonly role: string;
}

export interface Shell {
  readonly faces: readonly number[];
}

/** Frozen, hashable, JSON-serializable exact shape: plain data addressed by integer indices. */
export interface Shape {
  readonly tol: number;
  readonly maxTol: number;
  readonly vertices: readonly Vertex[];
  readonly curves: readonly Curve[];
  readonly surfaces: readonly Surface[];
  readonly edges: readonly Edge[];
  readonly coedges: readonly Coedge[];
  readonly loops: readonly Loop[];
  readonly faces: readonly Face[];
  readonly shells: readonly Shell[];
}

/** Largest Shape a session keeps (chosen, not measured; revisit with B-E0f evidence). */
export const BREP_LIMITS = { faces: 4096, edges: 4096 } as const;

/** The closed list of reasons an exact-stage operation reports; carried in `ModelingError.detail.brep`. */
export type BrepDetailCode =
  | 'brep-bad-argument'
  | 'brep-pcurve-unsupported'
  | 'brep-tol-exceeded'
  | 'brep-index-range'
  | 'brep-loop-open'
  | 'brep-edge-use'
  | 'brep-pcurve-mismatch'
  | 'brep-vertex-mismatch'
  | 'brep-orientation'
  | 'brep-face-unsupported'
  | 'brep-quad-unsupported-source'
  | 'brep-seam-mismatch'
  | 'brep-self-intersection'
  | 'brep-ssi-tangent'
  | 'brep-ssi-coincident'
  | 'brep-ssi-unsupported';

const OUTER: Readonly<Record<BrepDetailCode, ModelingErrorCode>> = {
  'brep-bad-argument': 'model-invalid-argument',
  'brep-pcurve-unsupported': 'model-partial',
  'brep-tol-exceeded': 'model-partial',
  'brep-index-range': 'model-precondition',
  'brep-loop-open': 'model-precondition',
  'brep-edge-use': 'model-precondition',
  'brep-pcurve-mismatch': 'model-precondition',
  'brep-vertex-mismatch': 'model-precondition',
  'brep-orientation': 'model-precondition',
  'brep-face-unsupported': 'model-partial',
  'brep-quad-unsupported-source': 'model-partial',
  'brep-seam-mismatch': 'model-internal',
  'brep-self-intersection': 'model-precondition',
  'brep-ssi-tangent': 'model-partial',
  'brep-ssi-coincident': 'model-partial',
  'brep-ssi-unsupported': 'model-partial',
};

/** The next step for each B-rep reason; it replaces the generic outer-code hint in `brepError`. */
export const BREP_HINTS: Readonly<Record<BrepDetailCode, string>> = {
  'brep-bad-argument':
    'pass the argument in the form named by expected; check detail.brep for the call',
  'brep-pcurve-unsupported':
    'the edge has no closed-form pcurve here (oblique section or NURBS curve); use a plane, cylinder or sphere section, or tessellate instead',
  'brep-tol-exceeded':
    'the computed curve deviates from the surfaces by more than tol; raise tol only if the deviation is acceptable, or simplify the geometry',
  'brep-index-range':
    'an id points outside the shape; take ids from the shape being edited, not a stale copy',
  'brep-loop-open':
    'the loop does not close; add the missing edge or check that edges chain head to tail',
  'brep-edge-use':
    'an edge is used by the wrong number of faces; a closed shell needs each edge in exactly two coedges',
  'brep-pcurve-mismatch':
    'an edge pcurve does not match its 3D curve; rebuild the edge from its curve and the faces',
  'brep-vertex-mismatch':
    'an edge end does not sit on its vertex; move the vertex onto the curve end or rebuild the edge',
  'brep-orientation':
    'coedge orientations disagree across an edge; flip the offending face loop so neighbours oppose',
  'brep-face-unsupported':
    'this face is outside the supported family (a triangulable planar face, a trim loop closed in (u, v), or a line, circle or ellipse edge); convert it or use the mesh path',
  'brep-quad-unsupported-source':
    'quadrangulate accepts analytic and boolean sources only; cut, trim and merge results are not wired into the quad path yet, so quadrangulate their analytic or boolean inputs instead',
  'brep-seam-mismatch':
    'a seam edge is inconsistent with its periodic surface; this is a kernel defect, report detail.brep and the shape',
  'brep-self-intersection':
    'the shell crosses itself; separate or trim the overlapping faces before the operation',
  'brep-ssi-tangent':
    'the two surfaces touch along a contact point; offset one surface or move the operands so they cross transversally',
  'brep-ssi-coincident':
    'two faces lie on the same surface; offset one face or remove the duplicate before the boolean',
  'brep-ssi-unsupported':
    'this surface pair has no closed-form section in the kernel; use a plane, sphere, cylinder, cone or torus pair, or mesh the operands',
};

export function brepError(
  brep: BrepDetailCode,
  expected: string,
  ids?: Readonly<Record<string, unknown>>,
): ModelingError {
  return modelingError(OUTER[brep], expected, { brep, ...ids }, BREP_HINTS[brep]);
}

export function brepFail<T = never>(
  brep: BrepDetailCode,
  expected: string,
  ids?: Readonly<Record<string, unknown>>,
): Result<T, ModelingError> {
  return err(brepError(brep, expected, ids));
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
