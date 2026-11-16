import { defineSystemSet } from '@forgeax/engine-ecs';

export const PhysicsSync = defineSystemSet({ name: 'physics-sync' });
export const PhysicsSimulation = defineSystemSet({ name: 'physics-simulation' });
export const PhysicsWriteback = defineSystemSet({ name: 'physics-writeback' });
