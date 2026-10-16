import { defineComponent } from '@forgeax/engine-ecs';

/** Per-entity morph weights; length is validated against the mesh target count. */
export const MorphWeights = defineComponent('MorphWeights', {
  weights: { type: 'array<f32>' },
});
