// Glyph mesh payload construction is shared by initial bake and dirty layout.
// Real CPU attributes describe the uploaded glyph quads; an explicit conservative
// AABB covers their rotations independently of exact-triangle picking.

import type { World } from '@forgeax/engine-ecs';
import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
  PROCEDURAL_FLOATS_PER_VERTEX,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { ok, type Result } from '@forgeax/engine-rhi';
import type { AssetError, Handle, MeshAsset } from '@forgeax/engine-types';

import type { GlyphLayoutResult } from './glyph-layout';

/** Result of baking a glyph layout into a registered mesh. */
export interface GlyphMeshBakeResult {
  /** The registered unmanaged mesh handle (feed to `MeshFilter.assetHandle`). */
  readonly handle: Handle<'MeshAsset', 'shared'>;
  /**
   * Conservative bounding-sphere cube AABB in local space: 6 floats
   * [-R,-R,-R, R,R,R] centered at the anchor (plan-strategy D-5). Empty
   * layout -> all-zero box.
   */
  readonly aabb: Float32Array;
}

/** Build the MeshAsset POD (12-float stride) from a glyph layout. */
export function buildGlyphMeshAsset(layout: GlyphLayoutResult): MeshAsset {
  const { vertices, indices, radius } = layout;
  const attributes = unpackInterleavedVertexAttributes(
    vertices,
    deriveVertexLayoutProjection(DEFAULT_VERTEX_ATTRIBUTE_MAP),
  );
  if (attributes === undefined)
    throw new RangeError('glyph layout requires complete canonical vertices');
  return {
    kind: 'mesh',
    vertices,
    indices,
    attributes,
    aabb: conservativeCubeAabb(radius),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: vertices.length / PROCEDURAL_FLOATS_PER_VERTEX,
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

/**
 * Bake a glyph layout into a registered mesh + conservative cube AABB.
 *
 * @param assets The AssetRegistry that owns the mesh handle lifecycle.
 * @param layout The pure layout output from `layoutGlyphText` (w15).
 * @returns `Result.ok({ handle, aabb })` or `Result.err(AssetError)` when
 *   `register` fail-fasts (e.g. stride mismatch -- should never happen for a
 *   layout produced by w15, but the gate is honored, not bypassed).
 */
export function bakeGlyphMesh(
  world: World,
  layout: GlyphLayoutResult,
): Result<GlyphMeshBakeResult, AssetError> {
  const meshAsset = buildGlyphMeshAsset(layout);
  const aabb = meshAsset.aabb as Float32Array;
  const handle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', meshAsset);
  return ok({ handle, aabb });
}
