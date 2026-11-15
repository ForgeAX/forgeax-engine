import { defineSystemSet } from '@forgeax/engine-ecs';

export const WaterSceneReconcile = defineSystemSet({ name: 'waterSceneReconcile' });
export const WaterBuoyancy = defineSystemSet({ name: 'waterBuoyancy' });
export const WaterBuoyancyCompletion = defineSystemSet({ name: 'waterBuoyancyCompletion' });
export const WaterContactProbes = defineSystemSet({ name: 'waterContactProbes' });

export const WaterSceneCollisionReconcile = defineSystemSet({
  name: 'waterSceneCollisionReconcile',
});
