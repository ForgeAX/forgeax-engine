import type { PhysicsVector } from './derived-physics.js';

/** One native solver manifold, including a merged compound contact cluster. */
export interface PhysicsContactManifold {
  readonly other: number;
  readonly shape?: string;
  readonly otherShape?: string;
  /** World-space normal from the queried entity toward `other`. */
  readonly normal: PhysicsVector;
  /** All world-space solver points belonging to this manifold. */
  readonly points: readonly PhysicsVector[];
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
