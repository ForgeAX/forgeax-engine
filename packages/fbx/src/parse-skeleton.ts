// parse-skeleton.ts — M5 t48: TS bridge for skeleton POD data.
//
// Consumes the C++ JSON POD skeleton section emitted by t45 binding.cc
// (WriteSkeletonData), produces SkeletonPod (types SSOT per requirements AC-05).
//
// Input schema (from JSON.parse of binding output):
//   skeletons?: [{
//     jointCount: number,
//     inverseBindMatrices: number[],  // jointCount * 16 packed doubles
//     jointPaths: string[],
//   }]
//
// Output: SkeletonPod { jointCount, inverseBindMatrices: Float32Array, jointPaths }

import { parseConservativeAnimatedBounds, type SkeletonPod } from '@forgeax/engine-types';

export interface FbxRawSkeleton {
  readonly jointCount: number;
  readonly inverseBindMatrices: number[];
  readonly jointPaths: string[];
  /** Producer-authored conservative animated local bounds, when present. */
  readonly bounds?: number[];
}

export interface FbxRawSkeletonDoc {
  readonly skeletons?: readonly FbxRawSkeleton[];
}

/**
 * Parse the first skeleton from a C++ JSON POD document.
 * Returns an empty skeleton when the document has no skeleton data.
 */
export function parseSkeleton(doc: FbxRawSkeletonDoc): SkeletonPod {
  const skeletons = doc.skeletons;
  if (!skeletons || skeletons.length === 0) {
    return { jointCount: 0, inverseBindMatrices: new Float32Array(0), jointPaths: [] };
  }

  const skel = skeletons[0];
  if (!skel) {
    return { jointCount: 0, inverseBindMatrices: new Float32Array(0), jointPaths: [] };
  }
  const bounds = parseConservativeAnimatedBounds(skel.bounds);
  return {
    jointCount: skel.jointCount,
    inverseBindMatrices: new Float32Array(skel.inverseBindMatrices),
    jointPaths: [...skel.jointPaths],
    ...(bounds === undefined ? {} : { bounds }),
  };
}
