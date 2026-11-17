import {
  type BodyMassProperties,
  finitePhysicsVector,
  ManagedPhysicsError,
  type ManagedPhysicsFailure,
  type PhysicsVector,
} from '@forgeax/engine-physics';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RapierRigidBody } from './physics-entity-records.js';

export function getBodyMassProperties(
  body: RapierRigidBody,
): Result<BodyMassProperties, ManagedPhysicsFailure> {
  try {
    const center = body.worldCom(),
      inverseMass = body.effectiveInvMass();
    const inertia = body.effectiveWorldInvInertia();
    return ok({
      mass: body.mass(),
      inverseMass: body.invMass(),
      centerOfMass: [center.x, center.y, center.z],
      effectiveInverseMass: [inverseMass.x, inverseMass.y, inverseMass.z],
      inverseInertia: [
        inertia.m11,
        inertia.m12,
        inertia.m13,
        inertia.m21,
        inertia.m22,
        inertia.m23,
        inertia.m31,
        inertia.m32,
        inertia.m33,
      ],
    });
  } catch (cause) {
    return err(
      new ManagedPhysicsError('managed-physics-failed', {
        reason: String(cause),
        recovery: 'old-state-retained',
      }),
    );
  }
}
export function getBodyPointVelocity(
  body: RapierRigidBody,
  point: PhysicsVector,
): Result<PhysicsVector, ManagedPhysicsFailure> {
  if (!finitePhysicsVector(point, 3))
    return err(
      new ManagedPhysicsError('managed-joint-invalid', {
        index: -1,
        reason: 'finite world-space point required',
      }),
    );
  try {
    const velocity = body.velocityAtPoint({ x: point[0], y: point[1], z: point[2] });
    return ok([velocity.x, velocity.y, velocity.z]);
  } catch (cause) {
    return err(
      new ManagedPhysicsError('managed-physics-failed', {
        reason: String(cause),
        recovery: 'old-state-retained',
      }),
    );
  }
}
