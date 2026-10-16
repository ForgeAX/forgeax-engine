import type { AssetDecoderInput, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { meshAssetDecoder } from '../assets/mesh-decoder.js';
import { createMeshBuilder } from '../mesh-builder.js';

function decode(mesh: MeshAsset) {
  const context = {
    envelope: { guid: 'mesh-builder', kind: 'mesh', payload: mesh, refs: [], artifacts: {} },
    artifacts: { read: async () => ({ ok: false as const, error: new Error('not used') }) },
  } as unknown as AssetDecoderInput<MeshAsset>;
  return meshAssetDecoder.decode(context);
}

describe('MeshBuilder -> MeshAsset decoder', () => {
  it('feeds a position-only builder output through the existing decoder', async () => {
    const built = createMeshBuilder({
      attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    }).build();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const decoded = await decode(built.value);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.aabb).toEqual(built.value.aabb);
  });

  it('preserves multiple submesh topology and material slots at the consumer boundary', async () => {
    const built = createMeshBuilder({
      attributes: {
        position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]),
      },
      indices: [0, 1, 2, 3, 4, 5],
      materialSlots: [{ slotName: 'base' }, { slotName: 'accent' }],
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
        {
          indexOffset: 3,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 1,
        },
      ],
    }).build();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const decoded = await decode(built.value);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.submeshes).toEqual(built.value.submeshes);
    expect(decoded.value.materialSlots).toEqual(built.value.materialSlots);
  });
});
