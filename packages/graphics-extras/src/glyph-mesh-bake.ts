// Glyph mesh payload construction is shared by initial bake and dirty layout.
// Real CPU attributes describe the uploaded glyph quads; an explicit conservative
// AABB covers their rotations independently of exact-triangle picking.

import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';

import type { GlyphLayoutResult } from './glyph-layout';

/** Build the MeshAsset POD (12-float stride) from a glyph layout. */
export function buildGlyphMeshAsset(layout: GlyphLayoutResult): MeshAsset {
  const { attributes, indices, radius } = layout;
  const vertexCount = attributes.position.length / 3;
  const packed = packInterleavedVertexAttributes(attributes, vertexCount).unwrap();
  return {
    kind: 'mesh',
    vertices: packed.vertices,
    indices,
    attributes,
    aabb: conservativeCubeAabb(radius),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
}

/** Conservative cube AABB centered at the anchor with half-side = layout radius. */
export function conservativeCubeAabb(radius: number): Float32Array {
  return Float32Array.of(-radius, -radius, -radius, radius, radius, radius);
}
