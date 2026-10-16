// parse-skeleton.test.ts -- M5 t52: skeleton parse-bridge unit test.
//
// R1 fixup: tests now import the real parseSkeleton from src/parse-skeleton.ts
// (instead of an inline stub), closing the AC-05 coverage gap.

import { describe, expect, it } from 'vitest';
import type { SkeletonPod } from '@forgeax/engine-types';
import { applyFbxImportSettingsBounds } from '../src/fbx-importer.js';
import { parseSkeleton } from '../src/parse-skeleton.js';
import type { FbxRawSkeletonDoc } from '../src/parse-skeleton.js';

const MOCK_SKELETON_RAW: FbxRawSkeletonDoc = {
  skeletons: [
    {
      jointCount: 3,
      inverseBindMatrices: [
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -5, 0, 1,
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -10, 0, 1,
      ],
      jointPaths: ['root', 'root/hip', 'root/hip/knee'],
    },
  ],
};

describe('parseSkeleton', () => {
  it('parses 3-joint skeleton from FbxRawSkeletonDoc', () => {
    const pod: SkeletonPod = parseSkeleton(MOCK_SKELETON_RAW);

    expect(pod.jointCount).toBe(3);
    expect(pod.inverseBindMatrices.length).toBe(3 * 16);
    expect(pod.jointPaths.length).toBe(3);

    // First IBM should be identity for root joint
    expect(pod.inverseBindMatrices[0]).toBe(1);
    expect(pod.inverseBindMatrices[5]).toBe(1);
    expect(pod.inverseBindMatrices[10]).toBe(1);
    expect(pod.inverseBindMatrices[15]).toBe(1);

    // Second IBM has translation Y=-5
    expect(pod.inverseBindMatrices[16 + 13]).toBe(-5);

    // Third IBM has translation Y=-10
    expect(pod.inverseBindMatrices[32 + 13]).toBe(-10);

    expect(pod.jointPaths[0]).toBe('root');
    expect(pod.jointPaths[1]).toBe('root/hip');
    expect(pod.jointPaths[2]).toBe('root/hip/knee');
  });

  it('returns empty skeleton for missing data', () => {
    const pod = parseSkeleton({});
    expect(pod.jointCount).toBe(0);
    expect(pod.inverseBindMatrices.length).toBe(0);
    expect(pod.jointPaths.length).toBe(0);
  });

  it('returns empty skeleton for empty skeletons array', () => {
    const pod = parseSkeleton({ skeletons: [] });
    expect(pod.jointCount).toBe(0);
    expect(pod.inverseBindMatrices.length).toBe(0);
  });

  it('keeps finite producer-authored animated bounds from raw FBX data', () => {
    const pod = parseSkeleton({
      skeletons: [
        {
          jointCount: 1,
          inverseBindMatrices: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          jointPaths: ['root'],
          bounds: [-2, -3, -4, 2, 3, 4],
        },
      ],
    });
    expect(pod.bounds).toEqual(new Float32Array([-2, -3, -4, 2, 3, 4]));
  });

  it('accepts the explicit importSettings producer row without a bind-pose fallback', () => {
    const pod = parseSkeleton({
      skeletons: [
        {
          jointCount: 1,
          inverseBindMatrices: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          jointPaths: ['root'],
        },
      ],
    });
    const withBounds = applyFbxImportSettingsBounds(pod, {
      conservativeAnimatedBounds: [[-5, -6, -7, 5, 6, 7]],
    });
    expect(withBounds.bounds).toEqual(new Float32Array([-5, -6, -7, 5, 6, 7]));
    expect(applyFbxImportSettingsBounds(pod, {}).bounds).toBeUndefined();
  });
});
