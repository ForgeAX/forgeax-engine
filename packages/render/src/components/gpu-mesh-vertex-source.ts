import { defineComponent } from '@forgeax/engine-ecs';

/** Replace the mesh's canonical vertex stream with a named RenderFeature
 * storage/vertex buffer. Indices, material slots and layout remain MeshAsset
 * owned. Missing/currently unprepared output is unavailable, never CPU fallback. */
export const GpuMeshVertexSource = defineComponent('GpuMeshVertexSource', {
  feature: { type: 'string' },
  resource: { type: 'string' },
});
