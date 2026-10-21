import type { World } from '@forgeax/engine-ecs';
import type { PairIsolationInput } from '@forgeax/engine-physics';

/**
 * Per-entity physics record — tracks the Rapier body handle for
 * each ECS entity.
 */
export interface PhysicsEntityRecord {
  bodyHandle: number;
  lockRotation: boolean;
  readonly worldIdentity: World | undefined;
  /** Authored additional mass used to restore automatic derived policy. */
  additionalMass: number;
  /** Additional mass currently applied to Rapier's automatic mass policy. */
  automaticAdditionalMass: number;
  /** Base collider density before an explicit derived mass override. */
  authoredDensity: number | undefined;
}

export interface IsolatedPair {
  readonly input: PairIsolationInput;
  readonly generation: number;
  readonly bodyA: PhysicsEntityRecord;
  readonly bodyB: PhysicsEntityRecord;
  readonly leases: Set<object>;
}

export interface Rapier3DKinematicControllerState {
  readonly entity: number;
  readonly offset: number;
}

export interface Rapier3DCollisionEvent {
  readonly type: 'started' | 'stopped';
  readonly entityA: number;
  readonly entityB: number;
  readonly fixedStep?: number;
  readonly shapeA?: string;
  readonly shapeB?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
export type RapierWorld = any;
// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
export type RapierEventQueue = any;
// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
export type RapierRigidBody = any;

export function isolationKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
