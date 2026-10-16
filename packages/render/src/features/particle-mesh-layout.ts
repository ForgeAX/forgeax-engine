import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';

// Mesh attributes keep geometry's canonical packing. Only locations change:
// the particle instance occupies 4..9 and custom material inputs occupy 10..13.
export const PARTICLE_MESH_DEFAULTS = {
  position: [0, 0, 0],
  normal: [0, 0, 1],
  uv: [0, 0],
  tangent: [1, 0, 0, 1],
  uv1: [0, 0],
  color: [1, 1, 1, 1],
} as const;
export const PARTICLE_MESH_GEOMETRY = deriveVertexLayoutProjection(
  Object.fromEntries(Object.keys(PARTICLE_MESH_DEFAULTS).map((key) => [key, new Float32Array()])),
);

export const PARTICLE_MESH_VERTEX_BUFFER = {
  arrayStride: PARTICLE_MESH_GEOMETRY.arrayStride,
  stepMode: 'vertex' as const,
  attributes: PARTICLE_MESH_GEOMETRY.attributes.map(({ key, shaderLocation, offset, format }) => ({
    shaderLocation: key === 'color' ? 14 : key === 'uv1' ? 15 : shaderLocation,
    offset,
    format,
  })),
};
