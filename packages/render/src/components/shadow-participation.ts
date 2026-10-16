import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Per-entity shadow participation for one MeshRenderer, independent of its
 * materials. Absence means the entity both casts and receives. `cast: false`
 * removes it from every directional, spot and point shadow map while it stays
 * visible; `receive: false` skips directional, contact, capsule, spot and
 * point shadow sampling on its own surface while it keeps casting. Changes are
 * ordinary ECS writes and apply on the next extracted frame.
 */
export const ShadowParticipation = defineComponent('ShadowParticipation', {
  cast: { type: 'bool', default: true },
  receive: { type: 'bool', default: true },
});
