// derive-render-data-skin.unit.test.ts -- geometry-owned projection contract.
// The render projection must preserve every authored attribute in canonical
// order, including skin streams, without a parallel stride discriminator.

import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { deriveRenderDataMesh } from '../../../render/src/render-data';

function canonicalAttributes(vertexCount: number): MeshAsset['attributes'] {
  return {
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
    tangent: new Float32Array(vertexCount * 4),
  };
}

function meshWithoutSkin(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(4 * 12),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    attributes: canonicalAttributes(4),
    aabb: new Float32Array(6),
    submeshes: [
      { indexOffset: 0, indexCount: 6, vertexCount: 4, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
}

function meshWithSkin(): MeshAsset {
  const attributes = canonicalAttributes(4);
  attributes.skinIndex = new Uint16Array(4 * 4);
  attributes.skinWeight = new Float32Array(4 * 4);
  return {
    kind: 'mesh',
    vertices: new Float32Array(4 * 18),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    attributes,
    aabb: new Float32Array(6),
    submeshes: [
      { indexOffset: 0, indexCount: 6, vertexCount: 4, topology: 'triangle-list', materialSlot: 0 },
    ],

    materialSlots: [{ slotName: 'Default' }],
  };
}

describe('deriveRenderDataMesh geometry-owned projection', () => {
  it('preserves the canonical projection for a mesh with skin streams', () => {
    const mesh = meshWithSkin();
    const res = deriveRenderDataMesh(mesh);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.layoutProjection).toEqual(deriveVertexLayoutProjection(mesh.attributes));
    expect(res.value.layoutProjection.arrayStride).toBe(72);
  });

  it('preserves the canonical projection for a mesh without skin streams', () => {
    const mesh = meshWithoutSkin();
    const res = deriveRenderDataMesh(mesh);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.layoutProjection).toEqual(deriveVertexLayoutProjection(mesh.attributes));
    expect(res.value.layoutProjection.arrayStride).toBe(48);
  });

  it('keeps a skinWeight-only authored map visible in the projection', () => {
    const mesh: MeshAsset = {
      ...meshWithoutSkin(),
      attributes: {
        ...canonicalAttributes(4),
        skinWeight: new Float32Array(16),
      },
    };
    const res = deriveRenderDataMesh(mesh);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.layoutProjection.attributes.map((attribute) => attribute.key)).toEqual([
      'position',
      'normal',
      'uv',
      'tangent',
      'skinWeight',
    ]);
  });
});
