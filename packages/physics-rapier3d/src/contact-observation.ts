import { quat, vec3 } from '@forgeax/engine-math';
import type { PhysicsContactObservation, PhysicsVector } from '@forgeax/engine-physics';
import type { TempContactManifold, World } from '../pkg/rapier.mjs';
import type { Rapier3DModule } from './wasm-loader.js';

/** Detached representative contact data. A retired native handle may have no sample. */
export function readContactObservation(
  world: World,
  RAPIER: Rapier3DModule,
  observation: PhysicsContactObservation,
  handleA: number,
  handleB: number,
): PhysicsContactObservation {
  let point: PhysicsVector | undefined;
  let normal: PhysicsVector | undefined;
  let geometricPoint: PhysicsVector | undefined;
  let geometricNormal: PhysicsVector | undefined;
  try {
    const colliderA = world.getCollider(handleA);
    const colliderB = world.getCollider(handleB);
    if (colliderA?.handle === handleA && colliderB?.handle === handleB) {
      world.contactPair(colliderA, colliderB, (manifold: TempContactManifold, flipped: boolean) => {
        // A contact manifold can retain geometric points without solver
        // points. Composite local points are subshape-local, so only
        // transform points from the ordinary primitive collider surface.
        if (
          manifold.numSolverContacts() === 0 &&
          geometricPoint === undefined &&
          manifold.numContacts() > 0
        ) {
          const first = flipped ? colliderB : colliderA;
          const second = flipped ? colliderA : colliderB;
          const types = RAPIER.ShapeType;
          for (const [collider, local] of [
            [first, manifold.localContactPoint1(0)],
            [second, manifold.localContactPoint2(0)],
          ] as const) {
            if (
              local == null ||
              ![types.Ball, types.Cuboid, types.Capsule].includes(collider.shapeType())
            )
              continue;
            const rotation = collider.rotation();
            const rotated = quat.transformVec3(
              vec3.create(),
              [rotation.x, rotation.y, rotation.z, rotation.w],
              [local.x, local.y, local.z],
            );
            const position = collider.translation();
            geometricPoint = [
              (rotated[0] as number) + position.x,
              (rotated[1] as number) + position.y,
              (rotated[2] as number) + position.z,
            ];
            const n = manifold.normal();
            const direction = flipped ? -1 : 1;
            geometricNormal = [n.x * direction, n.y * direction, n.z * direction];
            break;
          }
        }
        if (manifold.numSolverContacts?.() > 0) {
          const contact = manifold.solverContactPoint(0);
          const n = manifold.normal();
          if (contact !== null && contact !== undefined) {
            point = [contact.x, contact.y, contact.z];
          }
          if (n !== null && n !== undefined) {
            const direction = flipped ? -1 : 1;
            normal = [n.x * direction, n.y * direction, n.z * direction];
          }
        }
      });
    }
  } catch {
    // Contact events remain useful without optional manifold sampling. The
    // public type makes point/normal optional rather than inventing values.
  }
  if (point === undefined && geometricPoint !== undefined) {
    point = geometricPoint;
    normal = geometricNormal;
  }
  return Object.freeze({
    ...observation,
    ...(point === undefined ? {} : { point: Object.freeze(point) }),
    ...(normal === undefined ? {} : { normal: Object.freeze(normal) }),
  });
}
