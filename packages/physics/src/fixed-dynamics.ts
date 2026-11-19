import type { PhysicsQuaternion, PhysicsVector } from './derived-physics.js';

export type PhysicsFixedErrorCode =
  | 'fixed-body-missing'
  | 'fixed-input-invalid'
  | 'fixed-generation-stale'
  | 'fixed-step-stale'
  | 'fixed-operation-unavailable'
  | 'fixed-backend-failed';

export class PhysicsFixedError extends Error {
  override readonly name = 'PhysicsFixedError';
  readonly expected = 'a live synchronized body, exact generation and current fixed-step fence';
  readonly hint = 'refresh the committed dynamics and retry before the named simulation step';
  constructor(
    readonly code: PhysicsFixedErrorCode,
    readonly detail: Readonly<{
      entity: number;
      reason: string;
      expected?: number;
      actual?: number;
      recovery?: 'rebuild-required' | 'await-native-sync';
    }>,
  ) {
    super(`[${code}] ${detail.reason}`);
  }
}

/** Ordinary accepted dynamics, independent of derived-geometry ownership. SI units. */
export interface PhysicsBodyDynamics {
  readonly entity: number;
  readonly generation: number;
  readonly completedStep: number;
  readonly nextFixedStep: number;
  readonly massKg: number;
  readonly positionM: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
  readonly centerOfMassM: PhysicsVector;
  readonly localCenterOfMassM: PhysicsVector;
  readonly linearVelocityMps: PhysicsVector;
  readonly angularVelocityRadps: PhysicsVector;
  readonly principalInertiaKgM2: PhysicsVector;
  readonly principalInertiaLocalRotation: PhysicsQuaternion;
}

export type PhysicsColliderPrimitive =
  | Readonly<{ kind: 'sphere'; radiusM: number }>
  | Readonly<{ kind: 'capsule'; radiusM: number; halfHeightM: number }>
  | Readonly<{ kind: 'box'; halfExtentsM: PhysicsVector; representation: 'native' | 'bounds' }>;

/** Read-only native body selection fenced to the captured accepted body and step. */
export interface PhysicsBodyObbQuery {
  readonly entity: number;
  readonly generation: number;
  readonly completedStep: number;
  readonly positionM: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
  /** Nonnegative full side lengths; the native owner converts to half extents once. */
  readonly fullExtentsM: PhysicsVector;
  /** Component-local fallback, used only when the raw accepted aggregate is empty. */
  readonly emptyAggregateLocalBounds?: Readonly<{
    centerM: PhysicsVector;
    halfExtentsM: PhysicsVector;
  }>;
}

/** Accepted native geometry and motion, detached from ECS edits and backend handles. */
export interface PhysicsColliderPrimitives {
  readonly entity: number;
  readonly generation: number;
  readonly completedStep: number;
  /** Changes for teleport/setBodyMotion; native integration and kinematic motion preserve it. */
  readonly motionDiscontinuity: number;
  readonly positionM: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
  readonly scale: PhysicsVector;
  readonly centerOfMassM: PhysicsVector;
  readonly linearVelocityMps: PhysicsVector;
  readonly angularVelocityRadps: PhysicsVector;
  /** Accepted simple geometry before enabled/group filtering; excludes staged geometry. */
  readonly rawAggregateCount: number;
  readonly elements: readonly Readonly<{
    colliderId: string;
    generation: number;
    /** Native compound child index, or zero for a single primitive. */
    elementIndex: number;
    collisionGroups: number;
    positionM: PhysicsVector;
    rotation: PhysicsQuaternion;
    shape: PhysicsColliderPrimitive;
  }>[];
}

/** Opaque collider identity; generation changes even when its body survives. */
export interface PhysicsSensorOverlap {
  readonly colliderId: string;
  readonly entity: number;
  readonly generation: number;
  readonly bodyGeneration: number;
  readonly collisionGroups: number;
}

export interface PhysicsSensorOverlaps {
  readonly rootEntity: number;
  readonly rootGeneration: number;
  readonly completedStep: number;
  readonly current: readonly PhysicsSensorOverlap[];
  readonly entered: readonly PhysicsSensorOverlap[];
  readonly exited: readonly PhysicsSensorOverlap[];
  /** Historical members retired since completion; never presented as current candidates. */
  readonly stale: readonly PhysicsSensorOverlap[];
}

export interface PhysicsBodyForceInput {
  readonly entity: number;
  readonly generation: number;
  readonly fixedStep: number;
  readonly forceN: PhysicsVector;
  readonly pointM: PhysicsVector;
}

export interface PhysicsBodyTorqueInput {
  readonly entity: number;
  readonly generation: number;
  readonly fixedStep: number;
  readonly torqueNm: PhysicsVector;
}
