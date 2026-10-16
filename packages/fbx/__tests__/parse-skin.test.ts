// parse-skin.test.ts -- M5 t53: skin parse-bridge unit test.
//
// R1 fixup: tests now import the real parseSkin from src/parse-skin.ts
// (instead of an inline stub), closing the AC-06 coverage gap.

import { describe, expect, it } from 'vitest';
import type { SkinPod } from '@forgeax/engine-types';
import { parseSkin } from '../src/parse-skin.js';
import type { FbxRawSkinDoc } from '../src/parse-skin.js';

const MOCK_SKIN_RAW: FbxRawSkinDoc = {
  skins: [
    {
      meshSourceIndex: 0,
      jointPaths: ['root', 'root/hip', 'root/hip/knee'],
      vertexCount: 4,
      influences: [
        { jointIndices: [0, 0, 0, 0], jointWeights: [1.0, 0.0, 0.0, 0.0] },
        { jointIndices: [0, 1, 0, 0], jointWeights: [0.5, 0.5, 0.0, 0.0] },
        { jointIndices: [1, 2, 0, 0], jointWeights: [0.7, 0.3, 0.0, 0.0] },
        { jointIndices: [2, 0, 0, 0], jointWeights: [1.0, 0.0, 0.0, 0.0] },
      ],
    },
  ],
};

describe('parseSkin', () => {
  it('parses 4-vertex skin with 3-joint influences from FbxRawSkinDoc', () => {
    const pod: SkinPod = parseSkin(MOCK_SKIN_RAW);

    expect(pod.jointPaths.length).toBe(3);
    expect(pod.jointPaths[0]).toBe('root');
    expect(pod.jointPaths[1]).toBe('root/hip');
    expect(pod.jointPaths[2]).toBe('root/hip/knee');

    expect(pod.vertexCount).toBe(4);
    expect(pod.influences.length).toBe(4);

    // Each influence is padded to exactly 4 entries (Uint16Array + Float32Array)
    const inf0 = pod.influences[0]!;
    expect(inf0.jointIndices.length).toBe(4);
    expect(inf0.jointWeights.length).toBe(4);
    expect(inf0.jointIndices[0]).toBe(0);
    expect(inf0.jointWeights[0]).toBeCloseTo(1.0);
    // Padded entries should be 0
    expect(inf0.jointWeights[3]).toBeCloseTo(0.0);

    // Vertex 1: split 0.5/0.5 between joints 0 and 1
    const inf1 = pod.influences[1]!;
    expect(inf1.jointIndices[0]).toBe(0);
    expect(inf1.jointIndices[1]).toBe(1);
    expect(inf1.jointWeights[0]).toBeCloseTo(0.5);
    expect(inf1.jointWeights[1]).toBeCloseTo(0.5);

    // Vertex 2: 0.7/0.3 between joints 1 and 2
    const inf2 = pod.influences[2]!;
    expect(inf2.jointIndices[0]).toBe(1);
    expect(inf2.jointIndices[1]).toBe(2);
    expect(inf2.jointWeights[0]).toBeCloseTo(0.7);

    // Vertex 3: full weight on joint 2
    const inf3 = pod.influences[3]!;
    expect(inf3.jointIndices[0]).toBe(2);
    expect(inf3.jointWeights[0]).toBeCloseTo(1.0);
  });

  it('returns empty skin for missing data', () => {
    const pod = parseSkin({});
    expect(pod.vertexCount).toBe(0);
    expect(pod.influences.length).toBe(0);
    expect(pod.jointPaths.length).toBe(0);
  });

  it('returns empty skin for empty skins array', () => {
    const pod = parseSkin({ skins: [] });
    expect(pod.vertexCount).toBe(0);
    expect(pod.influences.length).toBe(0);
  });
});