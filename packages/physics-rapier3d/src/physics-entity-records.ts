import type { World } from '@forgeax/engine-ecs';
import type { PairIsolationInput } from '@forgeax/engine-physics';

/**
 * Per-entity physics record — tracks the Rapier body handle for
 * each ECS entity.
 */
export interface PhysicsEntityRecord {
  bodyHandle: number;
  readonly worldIdentity: World | undefined;
  /** Policy changes must dirty native contact caches, even for sleeping bodies. */
  pairPolicyDirty: boolean;
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
