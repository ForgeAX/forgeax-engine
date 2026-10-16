import { defineComponent } from '@forgeax/engine-ecs';

/** Optional height-aware aerial fog, independent from environment source. */
export const Fog = defineComponent('Fog', {
  color: { type: 'array<f32, 3>', default: new Float32Array([0.5, 0.5, 0.5]) },
  density: { type: 'f32', default: 0.01 },
  heightFalloff: { type: 'f32', default: 0 },
  maxOpacity: { type: 'f32', default: 1 },
});
