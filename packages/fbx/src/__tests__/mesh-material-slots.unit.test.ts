import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset, MeshPod } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { buildMeshAsset } from '../to-asset-pack';

describe('FBX mesh material slots', () => {
  it('projects repeated material indices through one stable slot table', () => {
    const pod: MeshPod = {
      name: 'MultiMaterial',
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {},
      sourceIndex: 0,
      submeshes: [0, 1, 0].map((materialIndex) => ({
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        topology: 'triangle-list' as const,
        materialIndex,
      })),
    };
    const asset = buildMeshAsset(pod, '019d0000-0000-7000-8000-000000000010', undefined, {
      guidByIndex: new Map([
        [0, '019d0000-0000-7000-8000-000000000011'],
        [1, '019d0000-0000-7000-8000-000000000012'],
      ]),
      nameByIndex: new Map([
        [0, 'Body'],
        [1, 'Trim'],
      ]),
    });
    if (asset.kind !== 'mesh') throw new Error('expected mesh');
    const mesh = asset.payload as MeshAsset;

    expect(mesh.submeshes.map((submesh) => submesh.materialSlot)).toEqual([0, 1, 0]);
    expect(mesh.materialSlots.map((slot) => slot.slotName)).toEqual(['Body', 'Trim']);
    expect(asset.refs.map((ref) => ref.guid)).toEqual([
      '019d0000-0000-7000-8000-000000000011',
      '019d0000-0000-7000-8000-000000000012',
    ]);
  });

  it('keeps old indices across source reorder and appends a newly discovered slot', () => {
    const pod: MeshPod = {
      name: 'Reimported',
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {},
      sourceIndex: 0,
      submeshes: [0, 1].map((materialIndex) => ({
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        topology: 'triangle-list' as const,
        materialIndex,
      })),
    };
    const asset = buildMeshAsset(pod, '019d0000-0000-7000-8000-000000000020', undefined, {
      guidByIndex: new Map([
        [0, '019d0000-0000-7000-8000-000000000021'],
        [1, '019d0000-0000-7000-8000-000000000022'],
      ]),
      nameByIndex: new Map([
        [0, 'Accent'],
        [1, 'Body'],
      ]),
      sourceKeyByIndex: new Map([
        [0, 'fbx:material:Accent'],
        [1, 'fbx:material:Body'],
      ]),
      previousMaterialSlots: [
        { slotName: 'Body', sourceKey: 'fbx:material:Body' },
        { slotName: 'Trim', sourceKey: 'fbx:material:Trim', defaultMaterialGuid: 'old-trim' },
      ],
      materialSlotDefaultOverrides: {
        'fbx:material:Trim': '019d0000-0000-7000-8000-000000000099',
      },
    });
    if (asset.kind !== 'mesh') throw new Error('expected mesh');
    const mesh = asset.payload as MeshAsset;

    expect(mesh.submeshes.map((submesh) => submesh.materialSlot)).toEqual([2, 0]);
    expect(mesh.materialSlots.map((slot) => slot.slotName)).toEqual(['Body', 'Trim', 'Accent']);
    expect(mesh.materialSlots[1]?.defaultMaterial).toBeUndefined();
    expect(asset.refs.map((ref) => ref.guid)).not.toContain('019d0000-0000-7000-8000-000000000099');
  });

  it('cooks the authored default while retaining stable producer topology', () => {
    const sourceGuid = '019d0000-0000-7000-8000-000000000031';
    const authoredGuid = '019d0000-0000-7000-8000-000000000032';
    const pod: MeshPod = {
      name: 'Editable',
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {},
      sourceIndex: 0,
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialIndex: 0,
        },
      ],
    };
    const asset = buildMeshAsset(pod, '019d0000-0000-7000-8000-000000000030', undefined, {
      guidByIndex: new Map([[0, sourceGuid]]),
      nameByIndex: new Map([[0, 'Body']]),
      sourceKeyByIndex: new Map([[0, 'fbx:material:Body']]),
      previousMaterialSlots: [
        {
          slotName: 'Body',
          sourceKey: 'fbx:material:Body',
          defaultMaterialGuid: sourceGuid,
        },
      ],
      materialSlotDefaultOverrides: { 'fbx:material:Body': authoredGuid },
    });
    if (asset.kind !== 'mesh') throw new Error('expected mesh');
    const mesh = asset.payload as MeshAsset;

    expect(AssetGuid.format(mesh.materialSlots[0]?.defaultMaterial as never)).toBe(authoredGuid);
  });
});
