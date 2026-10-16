import type { MaterialPod, MeshPod, ScenePod, SkeletonPod, SkinPod } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { toAssetPack } from '../to-asset-pack.js';

const guid = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

function mesh(sourceIndex: number, materialIndex: number): MeshPod {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    sourceIndex,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        topology: 'triangle-list',
        materialIndex,
      },
    ],
  };
}

const material = (name: string): MaterialPod => ({
  name,
  baseColorFactor: [1, 1, 1, 1],
  metallicFactor: 0,
  roughnessFactor: 0.5,
});

const scene: ScenePod = {
  rootEntityIndex: 0,
  entities: [
    {
      name: 'SkinnedMesh',
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      meshIndex: 0,
      children: [1],
    },
    {
      name: 'RigidMesh',
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      meshIndex: 1,
      children: [],
    },
  ],
};

const skeleton: SkeletonPod = {
  jointCount: 1,
  inverseBindMatrices: new Float32Array(16),
  jointPaths: ['SkinnedMesh'],
};

const skin: SkinPod = {
  skeletonGuid: guid(5),
  jointPaths: ['SkinnedMesh'],
  vertexCount: 3,
  influences: Array.from({ length: 3 }, () => ({
    jointIndices: new Uint16Array([0, 0, 0, 0]),
    jointWeights: new Float32Array([1, 0, 0, 0]),
  })),
};

describe('FBX material deformation ownership', () => {
  it('marks only material slots used by the skinned mesh as pbr-skin', () => {
    const assets = toAssetPack({
      meshes: [mesh(0, 0), mesh(1, 1)],
      scene,
      materials: [material('Skin'), material('Rigid')],
      textures: [],
      skeleton,
      skin,
      animationClips: [],
      subAssets: [
        { guid: guid(1), kind: 'mesh', sourceIndex: 0 },
        { guid: guid(2), kind: 'mesh', sourceIndex: 1 },
        { guid: guid(3), kind: 'material', sourceIndex: 0 },
        { guid: guid(4), kind: 'material', sourceIndex: 1 },
        { guid: guid(5), kind: 'skeleton', sourceIndex: 0 },
        { guid: guid(6), kind: 'skin', sourceIndex: 0 },
        { guid: guid(7), kind: 'scene', sourceIndex: 0 },
      ],
    });

    const materials = assets
      .filter((asset) => asset.kind === 'material')
      .map((asset) => asset.payload as { passes: readonly { program: { module: string } }[] });
    expect(materials.map((asset) => asset.passes[0]?.program.module)).toEqual([
      'forgeax::pbr-skin',
      'forgeax::default-standard-pbr',
    ]);
  });
});
