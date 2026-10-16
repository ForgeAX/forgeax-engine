import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Opt a skinned MeshRenderer into capsule directional shadows. Presence swaps
 * the entity out of every directional cascade and shades its shadow from the
 * skeleton's `shadowCapsules` in the deferred lighting pass; spot and point
 * shadows keep rasterizing the mesh. When the entity cannot be admitted, the
 * mesh keeps casting normally and `renderer.inspect().capsuleShadow` reports why.
 */
export const CapsuleShadow = defineComponent('CapsuleShadow', {});
