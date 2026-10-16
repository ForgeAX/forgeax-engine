// to-asset-pack-name.test.ts -- AC-10: FBX multi-asset fixture name test.

import { describe, expect, it } from 'vitest';

import type {
  AnimationClipPod,
  AnimationTargetIdValue,
  MeshPod,
  ScenePod,
  SkeletonPod,
  SkinPod,
} from '@forgeax/engine-types';
import { toAssetPack } from '../src/to-asset-pack.js';

function emptySkeleton(): SkeletonPod {
  return { jointCount: 0, inverseBindMatrices: new Float32Array(0), jointPaths: [] };
}

function emptySkin(): SkinPod {
  return {
    skeletonGuid: '',
    jointPaths: [],
    vertexCount: 0,
    influences: [],
  };
}

// GUID import-stable iron law: every emitted asset must be declared in
// subAssets[]. These tests declare a mesh + scene pair (and the single-scene
// variant) so toAssetPack resolves the declared GUID per (kind, sourceIndex).
const MESH_SUB = { guid: 'guid-mesh-0', kind: 'mesh', sourceIndex: 0 };
const MATERIAL_SUB = { guid: 'guid-material-0', kind: 'material', sourceIndex: 0 };
const SCENE_SUB = { guid: 'guid-scene-0', kind: 'scene', sourceIndex: 0 };
const CLIP_SUB = { guid: 'guid-clip-0', kind: 'animation-clip', sourceIndex: 0 };
const STANDARD_ROOT_GUID = '019fb7ce-3200-7000-8000-00000000000e';

describe('toAssetPack name plumbing (AC-10)', () => {
  it('marks imported linear-space material factors explicitly', () => {
    const scene: ScenePod = {
      entities: [{ transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, meshIndex: null }],
    };
    const assets = toAssetPack({
      meshes: [],
      scene,
      materials: [{
        sourceIndex: 0,
        baseColorFactor: [0.5, 0.25, 0.75, 1],
        metallicFactor: 0,
        roughnessFactor: 0.5,
      }],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips: [],
      subAssets: [MATERIAL_SUB, SCENE_SUB],
    });

    const material = assets.find((asset) => asset.kind === 'material');
    expect(material?.payload).toMatchObject({
      kind: 'material',
      colorSpace: 'linear',
      values: { baseColor: [0.5, 0.25, 0.75, 1] },
    });
  });

  it('projects the Meta canonical Standard root into the imported material parent edge', () => {
    const scene: ScenePod = {
      entities: [
        {
          transform: {
            translation: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          meshIndex: null,
        },
      ],
    };
    const assets = toAssetPack({
      meshes: [],
      scene,
      materials: [
        {
          sourceIndex: 0,
          baseColorFactor: [0.5, 0.25, 0.75, 1],
          metallicFactor: 0,
          roughnessFactor: 0.5,
        },
      ],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips: [],
      subAssets: [MATERIAL_SUB, SCENE_SUB],
      standardMaterialGuid: STANDARD_ROOT_GUID,
    });

    const material = assets.find((asset) => asset.kind === 'material');
    expect(material?.payload).toMatchObject({
      kind: 'material',
      parent: STANDARD_ROOT_GUID,
    });
    expect(material?.payload).toEqual({
      kind: 'material',
      parent: STANDARD_ROOT_GUID,
      values: {
        baseColor: [0.5, 0.25, 0.75, 1],
        metallic: 0,
        roughness: 0.5,
      },
    });
    expect(material?.payload).not.toHaveProperty('passes');
    expect(material?.payload).not.toHaveProperty('parameters');
    expect(material?.payload).not.toHaveProperty('moduleSlots');
    expect(material?.refs).toEqual([
      { guid: STANDARD_ROOT_GUID, sourceField: { fieldName: 'parent' } },
    ]);
  });

  it('multi-asset FBX: mesh name from MeshPod.name', () => {
    const mesh: MeshPod = {
      name: 'MyMesh',
      sourceIndex: 0,
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      attributes: {},
      submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
    };
    const scene: ScenePod = {
      entities: [{ transform: { translation: [0, 1, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, meshIndex: null }],
    };
    const assets = toAssetPack({
      meshes: [mesh],
      scene,
      materials: [],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips: [],
      subAssets: [MESH_SUB, SCENE_SUB],
    });
    const meshAsset = assets.find((a) => a.kind === 'mesh');
    expect(meshAsset).toBeDefined();
    expect(meshAsset?.name).toBe('MyMesh');
  });

  it('multi-asset FBX: scene name from ScenePod.name', () => {
    // A genuinely multi-asset pack (mesh + scene) keeps per-entry stored names.
    const mesh: MeshPod = {
      name: 'MyMesh',
      sourceIndex: 0,
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      attributes: {},
      submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
    };
    const scene: ScenePod = {
      name: 'Main',
      entities: [{ transform: { translation: [0, 1, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, meshIndex: null }],
    };
    const assets = toAssetPack({
      meshes: [mesh],
      scene,
      materials: [],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips: [],
      subAssets: [MESH_SUB, SCENE_SUB],
    });
    const sceneAsset = assets.find((a) => a.kind === 'scene');
    expect(sceneAsset).toBeDefined();
    expect(sceneAsset?.name).toBe('Main');
  });

  it('single-asset FBX (scene only): name dropped per XOR rule (aligned with glTF)', () => {
    const scene: ScenePod = {
      name: 'Solo',
      entities: [{ transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, meshIndex: null }],
    };
    const assets = toAssetPack({
      meshes: [],
      scene,
      materials: [],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips: [],
      subAssets: [SCENE_SUB],
    });
    expect(assets).toHaveLength(1);
    expect(assets[0]?.name).toBeUndefined();
  });

  it('multi-asset FBX: mesh without name -> name is undefined', () => {
    const mesh: MeshPod = {
      sourceIndex: 0,
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      attributes: {},
      submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
    };
    const scene: ScenePod = {
      entities: [{ transform: { translation: [0, 1, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, meshIndex: null }],
    };
    const assets = toAssetPack({
      meshes: [mesh],
      scene,
      materials: [],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips: [],
      subAssets: [MESH_SUB, SCENE_SUB],
    });
    const meshAsset = assets.find((a) => a.kind === 'mesh');
    expect(meshAsset).toBeDefined();
    expect(meshAsset?.name).toBeUndefined();
  });
  it('writes the same targetId into Scene and animation clip payloads', () => {
    const targetId = 'ab65f0305fc1868ca96d3361a86bd9ba' as AnimationTargetIdValue;
    const scene: ScenePod = {
      entities: [
        {
          name: 'root',
          transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          meshIndex: null,
          children: [1],
        },
        {
          name: 'hip',
          transform: { translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          meshIndex: null,
          children: [],
        },
      ],
    };
    const animationClips: AnimationClipPod[] = [{
      duration: 1,
      channels: [{
        targetId,
        property: 'translation',
        sampler: {
          input: new Float32Array([0]),
          output: new Float32Array([0, 0, 0]),
          interpolation: 'LINEAR',
        },
      }],
    }];
    const assets = toAssetPack({
      meshes: [],
      scene,
      materials: [],
      textures: [],
      skeleton: emptySkeleton(),
      skin: emptySkin(),
      animationClips,
      subAssets: [SCENE_SUB, CLIP_SUB],
    });
    const scenePayload = assets.find((asset) => asset.kind === 'scene')?.payload as {
      entities: Record<string, { components: Record<string, { value?: string }> }>;
    };
    const clipPayload = assets.find((asset) => asset.kind === 'animation-clip')?.payload as {
      channels: readonly { targetId?: string; targetPath?: unknown }[];
    };
    expect(scenePayload.entities['node-1']?.components.AnimationTargetId?.value).toBe(targetId);
    expect(clipPayload.channels[0]?.targetId).toBe(targetId);
    expect(clipPayload.channels[0]?.targetPath).toBeUndefined();
  });
});
