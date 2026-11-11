import type { BodyMotion } from '@forgeax/engine-physics';
import type { RapierRigidBody } from './physics-entity-records.js';

/** Write a validated pose and velocities while preserving authored rotation locking. */
export function writeNativeBodyMotion(
  body: RapierRigidBody,
  motion: Omit<BodyMotion, 'sleeping'>,
  lockRotation: boolean | undefined,
): void {
  const vector = (value: readonly number[]) => ({ x: value[0], y: value[1], z: value[2] });
  body.setTranslation(vector(motion.position), true);
  body.setRotation({ ...vector(motion.rotation), w: motion.rotation[3] }, true);
  body.setLinvel(vector(motion.linearVelocity), true);
  body.setAngvel(lockRotation ? { x: 0, y: 0, z: 0 } : vector(motion.angularVelocity), true);
}
