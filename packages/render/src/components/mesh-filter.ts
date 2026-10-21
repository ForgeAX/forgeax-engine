import { defineComponent } from '@forgeax/engine-ecs';

/** Geometry reference created or loaded by the World asset owner. Zero is unbound. */
export const MeshFilter = defineComponent('MeshFilter', {
  assetHandle: { type: 'asset<mesh>' },
});
