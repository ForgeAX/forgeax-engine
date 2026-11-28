import type { NurbsCurve } from '../../nurbs';
import type { Surface } from '../types';
import type { P2, P3 } from '../vec';

/** `[[u0, u1], [v0, v1]]` in the parameters of one surface. */
export type ParamBox = readonly [readonly [number, number], readonly [number, number]];

/**
 * One untrimmed face of a surface-surface intersection: the surface and the (u, v) rectangle it
 * covers. A NURBS face defaults to its knot domain; an analytic face must bound every infinite
 * direction (plane u and v, cylinder and cone v); sphere and torus default to the whole surface.
 */
export interface SsiFace {
  readonly surface: Surface;
  readonly bounds?: ParamBox;
}

export interface SsiOptions {
  /**
   * Absolute distance bound: every marched point lies within `tol / 100` of both surfaces, and the
   * fitted curve and both pcurve images stay within `tol` of them (the receipt). Default 1e-7.
   */
  readonly tol?: number;
  /** Below this angle (radians) between the two normals a crossing is near-tangent: the march stops and reports it. Default 1e-3. */
  readonly minAngle?: number;
  /** Seeding leaf radius as a fraction of the pair diagonal; smaller finds smaller loops. Default 1/512. */
  readonly seedResolution?: number;
  /** Chord sag of the marched polyline as a fraction of the pair diagonal. Default 2e-6. */
  readonly sag?: number;
  /** Marching steps over all branches before the result is cut short. Default 200000. */
  readonly maxSteps?: number;
}

/** Why one end of a branch stopped. */
export type SsiEnd = 'closed' | 'boundary' | 'near-tangent' | 'singular' | 'step-limit';

export interface SsiBranch {
  readonly closed: boolean;
  /** Marched points (a closed branch does not repeat its first point). */
  readonly points: readonly P3[];
  /** (u, v) of each point on face A and face B; closed directions are unwrapped (continuous). */
  readonly uvA: readonly P2[];
  readonly uvB: readonly P2[];
  /** Cubic fit of the points over [0, 1]; a closed branch starts and ends at `points[0]`. */
  readonly curve: NurbsCurve;
  /** The (u, v) trims of the curve on each face, same parameter: control points `[u, v, 0]`, unwrapped. */
  readonly onA: NurbsCurve;
  readonly onB: NurbsCurve;
  /** Largest sampled distance of `curve` from either surface and of a pcurve image from `curve`, widened by 1.25. */
  readonly bound: number;
  readonly ends: readonly [SsiEnd, SsiEnd];
}

/**
 * Reasons a result is `partial`: never a silent drop.
 * `ssi-near-tangent`: a branch reached a point where the normals are within `minAngle`.
 * `ssi-tangent-contact`: a seed converged where the surfaces touch tangentially (no transversal branch).
 * `ssi-singular`: a degenerate parametrization (pole, apex, collapsed edge) on a branch.
 * `ssi-step-limit`: the step budget ran out.
 * `ssi-fit-tolerance`: a branch whose fitted curve could not be brought within `tol`.
 * `ssi-pair-unsupported`: a pair this route does not trace: two analytic faces (the closed-form
 *   `intersectSurfaces` route owns them) or two NURBS faces (not yet traced).
 * `ssi-seed-budget`: subdivision stopped at its node budget, so some regions were not examined.
 */
export type SsiReason =
  | 'ssi-near-tangent'
  | 'ssi-tangent-contact'
  | 'ssi-singular'
  | 'ssi-step-limit'
  | 'ssi-fit-tolerance'
  | 'ssi-pair-unsupported'
  | 'ssi-seed-budget';

export interface SsiIssue {
  readonly code: 'model-partial';
  readonly reason: SsiReason;
  readonly point?: P3;
  readonly branch?: number;
}

export interface SsiStats {
  /** Subdivision leaves that survived exclusion. */
  readonly leaves: number;
  /** Seeds that converged onto the intersection. */
  readonly seeds: number;
  readonly steps: number;
}

export interface SsiResult {
  readonly status: 'ok' | 'partial';
  readonly branches: readonly SsiBranch[];
  readonly issues: readonly SsiIssue[];
  readonly stats: SsiStats;
}
