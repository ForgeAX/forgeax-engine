import type { WorldTraversal } from './world-traversal';

/** Binding-free launch policy shared by ordinary and prepared World queries.
 * Keeping one producer prevents a policy repair from bypassing sealed rays.
 * The current bias formulas remain unchanged here; this extraction alone does
 * not establish self-intersection or nearby-blocker correctness. */
export function worldSurfaceOriginWgsl(traversal: WorldTraversal): string {
  switch (traversal) {
    case 'global-sdf':
      return `
fn worldSurfaceOrigin(position: vec3f, normal: vec3f, fieldBias: f32) -> vec3f {
 // Positive coarse interpolation does not certify an exact receiver start.
 // Retain software field clearance instead of borrowing a hardware precision
 // offset that can skip unresolved near-surface geometry.
 return position + normal * fieldBias;
}
`;
    case 'ray-query':
      return `
// Match ray-raster-source/ray-path-tracer exact receiver precision. A field
// voxel clearance can skip a nearby triangle and change the first surface.
fn worldSurfaceOrigin(position: vec3f, normal: vec3f, fieldBias: f32) -> vec3f {
 let bias = max(1e-4, max(max(abs(position.x), abs(position.y)), abs(position.z)) * 1e-5);
 return position + normal * bias;
}
`;
  }
}
