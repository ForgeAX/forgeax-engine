import type { PhysicsVector } from './derived-physics.js';

/** Native surface-point velocities before the last CCD substep's constraint response. */
export interface PhysicsContactPointVelocities {
  /** World-space velocity of the queried body's own contact surface. */
  readonly body: PhysicsVector;
  /** World-space velocity of the other body's own contact surface. */
  readonly other: PhysicsVector;
}

/** One native solver manifold, including a merged compound contact cluster. */
export interface PhysicsContactManifold {
  readonly other: number;
  readonly shape?: string;
  readonly otherShape?: string;
  /** World-space normal from the queried entity toward `other`. */
  readonly normal: PhysicsVector;
  /** All world-space solver points belonging to this manifold. */
  readonly points: readonly PhysicsVector[];
  /** Same solver-contact order as points; null without active solver work.
   * These are native pre-solve observations, not current body velocity reads.
   * Each body is sampled on its own surface, including angular motion about its CoM.
   */
  readonly preSolveVelocities: readonly (PhysicsContactPointVelocities | null)[];
  /** Current-step native normal impulse per solver point, in the same order as points.
   * Null without an awake dynamic participant; excludes friction and warm-start seed.
   */
  readonly normalImpulses: readonly (number | null)[];
  /** Current-step normal impulse in N s; null when the pair has no awake dynamic body. */
  readonly normalImpulse: number | null;
}

/** Detached contact facts from one completed physics step, never collision-event history. */
export interface PhysicsContactSnapshot {
  readonly fixedStep: number;
  /** The completed native step duration, in seconds. */
  readonly deltaTime: number;
  readonly manifolds: readonly PhysicsContactManifold[];
}

/** Strict world-space dot-product predicate applied to the normal toward the other entity. */
export interface PhysicsContactNormalFilter {
  readonly direction: PhysicsVector;
  readonly minimumDot: number;
}

/** Unique entities with a nonempty solver contact in one completed step. */
export interface PhysicsContactNeighborsSnapshot {
  readonly fixedStep: number;
  readonly deltaTime: number;
  readonly entities: readonly number[];
}
