// apps/collectathon -- Guardian assembly: a kinematic KCC enemy that patrols,
// chases, and attacks (plan-strategy D-1 sensor + CollidingEntities, OOS-3 single
// enemy class, no nav-mesh / A* / combo).
//
// A Guardian is TWO entities, mirroring the player's body/sensor split:
//
//   body (KCC + visual):  RigidBody(kinematic) + Collider(capsule) +
//                         CharacterController + Transform + cylinder mesh (dark
//                         red standard PBR placeholder, OOS-3) + Guardian (the
//                         per-entity AI state) + GUARDIAN_BODY_GROUPS so the
//                         capsule slides on level geometry via moveAndSlide.
//     -> guardian-ai writes its Transform.local + Guardian.mode each frame.
//
//   attack sensor (child): RigidBody(kinematic) + Collider(sphere, isSensor) +
//                          Transform + GuardianAttack tag + ChildOf(body) +
//                          GUARDIAN_GROUPS (filters PLAYER only, R-D1: never a
//                          Core/Guardian cross-trigger). The sensor follows the
//                          body through ChildOf + propagateTransforms.
//     -> guardian-ai arms GuardianAttack.armed in attack mode; guardian-hit
//        reads the player's CollidingEntities for an armed sensor = a hit.
//
// main.ts spawns 1-3 Guardians at GUARDIAN_SPAWNS positions (clear of Cores and
// the Portal path) and marks both entities state-scoped (despawnOnExit Play).

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { createCylinderGeometry } from '@forgeax/engine-geometry';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

import { GUARDIAN_BODY_GROUPS, GUARDIAN_GROUPS } from '../collision-groups';
import { Guardian, GuardianAttack, GuardianModeValue } from '../components';

/** Guardian capsule radius (m) -- KCC body half-width. */
export const GUARDIAN_RADIUS = 0.4;
/** Guardian capsule half-height (m) -- the cylindrical mid-section. */
export const GUARDIAN_HALF_HEIGHT = 0.8;
/** Guardian capsule total half-extent (radius + halfHeight) -- spawn rest height. */
export const GUARDIAN_HALF_TOTAL = GUARDIAN_RADIUS + GUARDIAN_HALF_HEIGHT;
/** Visual cylinder height (m) -- spans the capsule body. */
const GUARDIAN_VISUAL_HEIGHT = GUARDIAN_HALF_TOTAL * 2;
/** Attack sensor radius (m) -- the reach within which an armed attack lands. */
export const GUARDIAN_ATTACK_RADIUS = 1.5;

/**
 * Guardian spawn positions in the level XZ plane (1-3 instances). Kept clear of
 * the Core cluster and off the straight player->Portal corridor so they patrol
 * without immediately wall-cornering or blocking the path (AC-15 / OOS-3).
 *
 * Pushed to the mid/outer field so NO Guardian PATROL RING reaches the player
 * spawn bubble. The player spawns at the origin and each Guardian walks a +/-3
 * waypoint square (PATROL_OFFSETS) around its spawn, so the distance that matters
 * is the CLOSEST patrol point to the origin, not the spawn point. With these
 * spawns the closest patrol approaches are 9.22 / 9.22 / 7.0 -- all above
 * CHASE_RADIUS=5, so an idle player at spawn is never aggroed. (The previous
 * spawns at distance ~7-8 had patrol points only 4.47 from the origin, so two
 * Guardians aggroed a stationary spawn within one waypoint cycle and drained all
 * 3 hearts in ~3s -- three distinct attackers each landing one un-invul'd first
 * hit.) Guardians still engage the instant the player roams within 5m to collect.
 */
export const GUARDIAN_SPAWNS: ReadonlyArray<{ readonly x: number; readonly z: number }> = [
  { x: -10, z: -6 },
  { x: 10, z: -6 },
  { x: 0, z: 10 },
];

export interface GuardianHandles {
  /** KCC body entity -- guardian-ai drives this Transform + Guardian.mode. */
  readonly body: EntityHandle;
  /** Attack-sensor child entity -- guardian-hit detects it in CollidingEntities. */
  readonly attackSensor: EntityHandle;
}

/** Dark-red standard-PBR placeholder material for the Guardian body (OOS-3). */
function guardianMaterial(): MaterialAsset {
  return Materials.standard({
    baseColor: [0.55, 0.08, 0.08, 1],
    emissive: [0.15, 0.0, 0.0],
    emissiveIntensity: 0.6,
    roughness: 0.5,
    metallic: 0.1,
  });
}

/**
 * Spawn one Guardian (body + attack sensor) at a planar position. Returns both
 * entities so main.ts marks them state-scoped (despawnOnExit Play).
 *
 * The body rests at GUARDIAN_HALF_TOTAL so the capsule sits cleanly on the
 * ground (y=0 top). The Guardian starts in patrol mode at waypoint 0.
 */
export function spawnGuardian(
  world: World,
  position: { readonly x: number; readonly z: number },
): GuardianHandles {
  const cylRes = createCylinderGeometry(
    GUARDIAN_RADIUS,
    GUARDIAN_RADIUS,
    GUARDIAN_VISUAL_HEIGHT,
    16,
    1,
  );
  if (!cylRes.ok) {
    throw new Error(`collectathon: createCylinderGeometry (guardian) failed: ${cylRes.error.code}`);
  }
  const bodyMesh = world.allocSharedRef('MeshAsset', cylRes.value);
  const bodyMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    guardianMaterial(),
  );

  const body = world
    .spawn(
      {
        component: Transform,
        data: { pos: [position.x, GUARDIAN_HALF_TOTAL, position.z] },
      },
      { component: MeshFilter, data: { assetHandle: bodyMesh } },
      { component: MeshRenderer, data: { materials: [bodyMat] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.capsule,
          radius: GUARDIAN_RADIUS,
          halfHeight: GUARDIAN_HALF_HEIGHT,
          collisionGroups: GUARDIAN_BODY_GROUPS,
        },
      },
      { component: CharacterController, data: {} },
      { component: Guardian, data: { mode: GuardianModeValue.patrol, waypoint: 0, timer: 0 } },
    )
    .unwrap();

  // Attack sensor: a child sphere sensor that follows the body (ChildOf +
  // propagateTransforms). Filters to PLAYER only (R-D1). Starts disarmed --
  // guardian-ai arms it in attack mode.
  const attackSensor = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
      {
        component: Collider,
        data: {
          shape: ColliderShapeValue.sphere,
          radius: GUARDIAN_ATTACK_RADIUS,
          isSensor: true,
          collisionGroups: GUARDIAN_GROUPS,
        },
      },
      { component: GuardianAttack, data: { armed: false } },
      { component: ChildOf, data: { parent: body } },
    )
    .unwrap();

  return { body, attackSensor };
}
