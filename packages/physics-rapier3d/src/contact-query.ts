import {
  ManagedPhysicsError,
  type PhysicsContactManifold,
  type PhysicsVector,
} from '@forgeax/engine-physics';
import type { Collider, RigidBody, World } from '../pkg/rapier.mjs';

const limit = 4096;

/** Query the native contact graph in place; no contact or load registry is retained. */
export function queryContactManifolds(
  world: World,
  body: RigidBody,
  owner: (
    collider: Collider,
  ) => { readonly entity: number; readonly shape?: string; readonly body: RigidBody } | undefined,
  filterMask?: number,
): PhysicsContactManifold[] {
  const result: PhysicsContactManifold[] = [];
  let visited = 0;
  const bounded = (count = 1) => {
    visited += count;
    if (!Number.isSafeInteger(count) || count < 0 || visited > limit)
      throw new ManagedPhysicsError('managed-physics-unavailable', {
        reason:
          'current contact query exceeds 4096 native collider, pair, manifold or point visits',
      });
  };
  const vector = (value: { x: number; y: number; z: number } | null): PhysicsVector => {
    if (!value || ![value.x, value.y, value.z].every(Number.isFinite))
      throw new ManagedPhysicsError('managed-physics-unavailable', {
        reason: 'current contact query requires finite native world-space points and normals',
      });
    return [value.x, value.y, value.z];
  };
  const colliderCount = body.numColliders();
  bounded(colliderCount);
  for (let index = 0; index < colliderCount; index += 1) {
    const collider = body.collider(index);
    if (!collider?.isEnabled() || collider.isSensor()) continue;
    const own = owner(collider);
    if (!own) continue;
    world.contactPairsWith(collider, (other) => {
      bounded();
      const otherOwner = owner(other);
      if (!other.isEnabled() || other.isSensor() || !otherOwner || otherOwner.entity === own.entity)
        return;
      if (filterMask !== undefined) {
        const groups = other.collisionGroups();
        if (((groups >>> 16) & filterMask) === 0 || ((filterMask >>> 16) & groups) === 0) return;
      }
      const otherBody = otherOwner.body;
      const awake =
        (body.isDynamic() && !body.isSleeping()) ||
        (otherBody.isDynamic() && !otherBody.isSleeping());
      world.narrowPhase.contactPair(
        collider.handle,
        other.handle,
        world.bodies,
        (manifold, flipped) => {
          bounded();
          const pointCount = manifold.numSolverContacts();
          bounded(pointCount);
          if (pointCount === 0) return;
          const normal = vector(manifold.normal());
          const points: PhysicsVector[] = [];
          for (let point = 0; point < pointCount; point += 1)
            points.push(vector(manifold.solverContactPoint(point)));
          let normalImpulse: number | null = null;
          if (awake) {
            normalImpulse = 0;
            for (let contact = 0; contact < pointCount; contact += 1) {
              const impulse = manifold.solverContactImpulse(contact);
              if (!Number.isFinite(impulse) || impulse < 0)
                throw new ManagedPhysicsError('managed-physics-unavailable', {
                  reason: 'current contact query requires finite nonnegative native impulses',
                });
              normalImpulse += impulse;
            }
            if (!Number.isFinite(normalImpulse))
              throw new ManagedPhysicsError('managed-physics-unavailable', {
                reason: 'current contact impulse sum exceeds finite numeric range',
              });
          }
          result.push({
            other: otherOwner.entity,
            ...(own.shape === undefined ? {} : { shape: own.shape }),
            ...(otherOwner.shape === undefined ? {} : { otherShape: otherOwner.shape }),
            normal: flipped ? [-normal[0], -normal[1], -normal[2]] : normal,
            points,
            normalImpulse,
          });
        },
        true,
      );
    });
  }
  return result;
}
