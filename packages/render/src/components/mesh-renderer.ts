import { defineComponent } from '@forgeax/engine-ecs';
import { LIGHTING_CHANNELS_DEFAULT } from './lighting-channels';

/** Material references indexed by Mesh material slots. Empty slots inherit Mesh defaults. */
export const MeshRenderer = defineComponent('MeshRenderer', {
  lightingChannels: { type: 'f64', default: LIGHTING_CHANNELS_DEFAULT },
  materials: { type: 'array<asset<material>>', default: [] },
  // An explicit request prepares this view's pipelines even while the mesh is hidden.
  preparePipelines: { type: 'bool', default: false },
});
