import type { MeshPod } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { parseAnimationClips } from '../parse-animation-clip.js';
import { type FbxRawMesh, parseMesh } from '../parse-mesh.js';
import { buildMeshAsset } from '../to-asset-pack.js';

type MorphRawMesh = FbxRawMesh & {
  readonly morphTargets?: readonly {
    readonly position?: number[];
    readonly normal?: number[];
    readonly tangent?: number[];
  }[];
  readonly morphWeights?: number[];
};

function rawMesh(overrides: Partial<MorphRawMesh> = {}): MorphRawMesh {
  return {
    vertices: [0, 0, 0, 1, 0, 0],
    indices: [0, 1],
    attributes: {},
    polygonCount: 1,
    sourceIndex: 0,
    materialIndex: -1,
    ...overrides,
  };
}

describe('FBX BlendShape morph projection', () => {
  it('keeps target-major deltas and authored weights through MeshAsset', () => {
    const pod = parseMesh(
      rawMesh({
        morphTargets: [{ position: [0, 0, 0, 0.25, 0, 0] }],
        morphWeights: [0.5],
      }),
      0,
    ) as MeshPod & {
      readonly morphTargets?: readonly { readonly position?: Float32Array }[];
      readonly morphWeights?: Float32Array;
    };
    const asset = buildMeshAsset(pod, 'fbx-morph-guid');
    const mesh = asset.payload as {
      morphTargets?: readonly { readonly position?: Float32Array }[];
      morphWeights?: Float32Array;
    };
    expect(mesh.morphTargets?.[0]?.position?.[3]).toBeCloseTo(0.25);
    expect(Array.from(mesh.morphWeights ?? [])).toEqual([0.5]);
  });

  it('fails before asset promotion when a source exceeds the eight-target limit', () => {
    expect(() =>
      parseMesh(
        rawMesh({
          morphTargets: Array.from({ length: 9 }, () => ({ position: [0, 0, 0, 0, 0, 0] })),
        }),
        0,
      ),
    ).toThrow('fbx-morph-invalid');
  });

  it('preserves per-element FBX morph weight channels during resampling', () => {
    const [clip] = parseAnimationClips({
      clips: [
        {
          duration: 1,
          channels: [
            {
              targetNode: 'Root',
              property: 'weights',
              weightCount: 4,
              keyTimes: [0, 1],
              keyValues: [0, 0, 0, 0, 1, 2, 3, 4],
            },
          ],
        },
      ],
    });
    expect(clip?.channels[0]?.property).toBe('weights');
    expect(Array.from(clip?.channels[0]?.sampler.output ?? [])).toEqual([0, 0, 0, 0, 1, 2, 3, 4]);
  });
});
