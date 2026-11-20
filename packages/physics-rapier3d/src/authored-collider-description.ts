import {
  ColliderShapeValue,
  type ColliderSnapshot,
  colliderShapeFromF32,
} from '@forgeax/engine-physics';
import type { RigidBodyType } from '@forgeax/engine-types';
import type { ColliderDesc } from '../pkg/rapier.mjs';
import type { PhysicsTransform3D } from './physics-sync-descriptor.js';
import type { Rapier3DModule } from './wasm-loader.js';

/** Prepare shape data before changing an existing body. Native ownership stays with the caller. */
export function authoredColliderDescription(
  rapier: Rapier3DModule,
  transform: PhysicsTransform3D,
  collider: ColliderSnapshot,
  bodyType: RigidBodyType,
  meshGeometry: (collider: ColliderSnapshot) => number,
  failure: (reason: string) => never,
): ColliderDesc {
  const RAPIER = rapier;
  const x = Math.abs(transform.scale.x),
    y = Math.abs(transform.scale.y),
    z = Math.abs(transform.scale.z);
  if (!validAuthoredColliderDimensions(transform, collider))
    return failure('collider dimensions and world scale must be finite and positive');
  let desc: ColliderDesc;
  switch (colliderShapeFromF32(collider.shape)) {
    case 'cuboid':
      desc = RAPIER.ColliderDesc.cuboid(
        collider.halfExtents[0] * x,
        collider.halfExtents[1] * y,
        collider.halfExtents[2] * z,
      );
      break;
    case 'sphere':
      desc = RAPIER.ColliderDesc.ball(collider.radius * Math.max(x, y, z));
      break;
    case 'capsule':
      desc = RAPIER.ColliderDesc.capsule(collider.halfHeight * y, collider.radius * Math.max(x, z));
      break;
    case 'cylinder':
      desc = RAPIER.ColliderDesc.cylinder(
        collider.halfHeight * y,
        collider.radius * Math.max(x, z),
      );
      break;
    case 'cone':
      desc = RAPIER.ColliderDesc.cone(collider.halfHeight * y, collider.radius * Math.max(x, z));
      break;
    case 'convexHull':
    case 'trimesh': {
      if (collider.shape === ColliderShapeValue.trimesh && bodyType === 'dynamic')
        return failure(
          'concave trimesh is static/kinematic only; use convexHull for dynamic bodies',
        );
      desc = new RAPIER.ColliderDesc({
        type: 'shared',
        geometry: meshGeometry(collider),
        scale: { x, y, z },
      });
      break;
    }
  }
  return desc
    .setFriction(collider.friction)
    .setRestitution(collider.restitution)
    .setDensity(collider.density)
    .setCollisionGroups(collider.collisionGroups)
    .setSolverGroups(collider.solverGroups)
    .setSensor(Boolean(collider.isSensor))
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
    .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
}

/** Pure preflight shared by ordinary creation and static residency, before native allocation. */
export function validAuthoredColliderDimensions(
  transform: PhysicsTransform3D,
  collider: ColliderSnapshot,
): boolean {
  const dimensions =
    collider.shape === ColliderShapeValue.cuboid
      ? collider.halfExtents
      : collider.shape === ColliderShapeValue.sphere
        ? [collider.radius]
        : collider.shape <= ColliderShapeValue.cone
          ? [collider.radius, collider.halfHeight]
          : [];
  return [
    Math.abs(transform.scale.x),
    Math.abs(transform.scale.y),
    Math.abs(transform.scale.z),
    ...dimensions,
  ].every((value) => Number.isFinite(value) && value > 0);
}
