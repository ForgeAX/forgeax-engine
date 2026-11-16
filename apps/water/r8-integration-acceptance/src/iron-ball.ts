import type { EntityHandle, World } from '@forgeax/engine/ecs';
import {
  Collider,
  ColliderShapeValue,
  type PhysicsBodyDynamics,
  type PhysicsSolverClock,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import { WaterContactProbeSet, WaterPontoonSet, WaterShallowCollider } from '@forgeax/engine/scene';
import { type Vec3, WaterQueryFlags, type WaterSystem } from '@forgeax/engine/water';

/** Native iron balls join water collision only until entry, without buoyancy or probe queries. */
export function ironBallPhysics(massKg: number, authoredRadiusM: number) {
  return [
    {
      component: RigidBody,
      data: { type: RigidBodyTypeValue.dynamic, mass: massKg, ccdEnabled: true },
    },
    {
      component: Collider,
      data: {
        shape: ColliderShapeValue.sphere,
        radius: authoredRadiusM,
        collisionGroups: 0x0001ffff,
      },
    },
    { component: WaterShallowCollider, data: { enabled: true } },
  ] as const;
}

/** Observe entry on the same completed native clock as the two scenes. */
export function sampleIronBallEntry(
  water: Pick<WaterSystem, 'queryBody'>,
  body: Readonly<{ guid: string; sceneGeneration: number }>,
  dynamics: PhysicsBodyDynamics,
  clock: PhysicsSolverClock,
  entryRecorded: boolean,
) {
  if (entryRecorded) return undefined;
  return water.queryBody(body.guid, {
    positionM: dynamics.positionM,
    timeSeconds: clock.simulationTimeSeconds,
    expectedBodyGeneration: body.sceneGeneration,
    nativePhysics: { completedStep: clock.completedStep, timeSeconds: clock.simulationTimeSeconds },
    flags:
      WaterQueryFlags.ComputeLocation |
      WaterQueryFlags.ComputeNormal |
      WaterQueryFlags.IncludeWaves,
  });
}

/** The entry scene depicts only the part above its captured water surface. */
export function ironBallSubmerged(positionM: Vec3, radiusM: number, surfaceYM: number): boolean {
  return positionM[1] + radiusM < surfaceYM;
}

/** Release scene-authored water displacement after the first native entry. */
export function releaseIronBallWaterCollider(world: World, entity: EntityHandle) {
  return world.removeComponent(entity, WaterShallowCollider);
}

/** Read existing components and the captured entry; this observation never samples water. */
export function readIronBallParticipation(
  world: Pick<World, 'hasComponent'>,
  entity: EntityHandle,
  entryRecorded: boolean,
) {
  return {
    buoyancyParticipant: world.hasComponent(entity, WaterPontoonSet),
    contactProbeParticipant: world.hasComponent(entity, WaterContactProbeSet),
    shallowColliderParticipant: world.hasComponent(entity, WaterShallowCollider),
    nativeEntryArmed:
      !entryRecorded &&
      world.hasComponent(entity, RigidBody) &&
      world.hasComponent(entity, Collider),
  };
}
