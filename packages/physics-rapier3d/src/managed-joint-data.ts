import type { ManagedJointInput } from '@forgeax/engine-physics';
import type { JointData } from '../pkg/rapier.mjs';
import type { Rapier3DModule } from './wasm-loader.js';

/** Project a validated managed joint description into Rapier's native descriptor. */
export function createManagedJointData(
  rapier: Rapier3DModule,
  input: ManagedJointInput,
): JointData {
  const vector = (value: readonly number[]) => ({ x: value[0], y: value[1], z: value[2] });
  const rotation = (value: readonly number[]) => ({ ...vector(value), w: value[3] });
  return input.kind === 'hinge'
    ? rapier.JointData.revoluteWithAxes(
        vector(input.anchorA),
        vector(input.anchorB),
        vector(input.axisA),
        vector(input.axisB),
      )
    : rapier.JointData.fixed(
        vector(input.anchorA),
        rotation(input.frameA),
        vector(input.anchorB),
        rotation(input.frameB),
      );
}
