import { defineComponent } from '@forgeax/engine-ecs';

/** Two float vectors read by custom direct mesh shaders through meshes[0]. */
export const MeshDrawParameters = defineComponent('MeshDrawParameters', {
  x: 'f32',
  y: 'f32',
  z: 'f32',
  w: 'f32',
  extraX: 'f32',
  extraY: 'f32',
  extraZ: 'f32',
  extraW: 'f32',
});

export const MESH_DRAW_PARAMETER_FLOATS = 8;
