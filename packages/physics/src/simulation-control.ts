import { defineResource, type World } from '@forgeax/engine-ecs';
import { PhysicsError } from './errors.js';

/** Application-owned automatic-step policy. No resource means normal simulation. */
export interface PhysicsSimulationControl {
  paused: boolean;
}
export const PhysicsSimulationControl = defineResource<PhysicsSimulationControl>(
  'PhysicsSimulationControl',
);

/** Backend scheduling condition; sync, writeback and entity retirement remain active. */
export function physicsSimulationRunning(world: World): boolean {
  if (!world.hasResource(PhysicsSimulationControl)) return true;
  const control = world.getResource<PhysicsSimulationControl>(PhysicsSimulationControl);
  if (typeof control?.paused !== 'boolean')
    throw new PhysicsError({
      code: 'invalid-body-config',
      expected: 'PhysicsSimulationControl.paused is a boolean',
      hint: 'provide a valid application-owned physics simulation policy',
      detail: {
        code: 'invalid-body-config',
        field: 'PhysicsSimulationControl.paused',
        value: control?.paused,
      },
    });
  return !control.paused;
}
