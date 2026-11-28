import type { P2, P3 } from '../vec';

/**
 * The extra equation that makes a corrector step square: `none` takes the minimum-norm Newton step
 * (seeding), `plane` keeps the point on the plane through `anchor` normal to `t` (marching), `param`
 * pins one state coordinate (a kink crossing).
 */
export type Constraint =
  | { readonly kind: 'none' }
  | { readonly kind: 'plane'; readonly anchor: P3; readonly t: P3 }
  | { readonly kind: 'param'; readonly index: number; readonly value: number };

/** First-order description of the intersection curve at one state. */
export interface Local {
  readonly p: P3;
  /** Unit tangent `n1 x n2 / |n1 x n2|`. */
  readonly t: P3;
  /** Sine of the angle between the two unit normals. */
  readonly sin: number;
  /** State change per unit arc length along `t`. */
  readonly dxds: readonly number[];
}

/** A state coordinate whose value `value` is a crease (C0 knot line) of a NURBS face. */
export interface Kink {
  readonly index: number;
  readonly value: number;
}

/**
 * One intersection problem in a state space: (u, v) of a NURBS face against an analytic implicit,
 * or (u1, v1, u2, v2) of two NURBS faces. The marcher, seeding bookkeeping and fitter only see this.
 */
export interface Problem {
  readonly dim: number;
  /** Distance of a corrected state from both surfaces. */
  readonly ptTol: number;
  /** Period of each state coordinate (0: none); states are kept unwrapped. */
  readonly period: readonly number[];
  readonly kinks: readonly Kink[];
  /** Natural periods of (u, v) on face A and face B, to unwrap `uv` along a branch. */
  readonly uvPeriod: readonly [readonly [number, number], readonly [number, number]];
  point(x: readonly number[]): P3;
  /** Undefined where a parametrization or the implicit gradient degenerates. */
  local(x: readonly number[]): Local | undefined;
  correct(x: readonly number[], c: Constraint): number[] | undefined;
  inside(x: readonly number[]): boolean;
  /** A state coordinate outside its NURBS parameter box and the bound it crossed, to pin an exit exactly. */
  exitPin(x: readonly number[]): Kink | undefined;
  uv(x: readonly number[]): readonly [P2, P2];
  imageA(uv: P2): P3;
  imageB(uv: P2): P3;
}
