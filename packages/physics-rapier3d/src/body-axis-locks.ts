import { PhysicsError } from '@forgeax/engine-physics';

export function validateBodyAxes(value: number, field: 'translationAxes' | 'rotationAxes'): number {
  if (!Number.isInteger(value) || value < 0 || value > 7)
    throw new PhysicsError({
      code: 'invalid-body-config',
      expected: `${field} is an integer bitmask in [0,7] (x=1, y=2, z=4)`,
      hint: 'repair the authored RigidBody before synchronization',
      detail: { code: 'invalid-body-config', field, value },
    });
  return value;
}

export function allowedBodyVelocity(value: { x: number; y: number; z: number }, axes: number) {
  return { x: axes & 1 ? value.x : 0, y: axes & 2 ? value.y : 0, z: axes & 4 ? value.z : 0 };
}
