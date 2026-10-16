// parse-skin.ts — M5 t49: TS bridge for skin POD data.
//
// Consumes the C++ JSON POD skin section emitted by t45 binding.cc
// (WriteSkinData), produces SkinPod (types SSOT per requirements AC-06).
//
// Input schema (from JSON.parse of binding output):
//   skins?: [{
//     meshSourceIndex: number,
//     jointPaths: string[],
//     vertexCount: number,
//     influences: [{ jointIndices: number[], jointWeights: number[] }],
//   }]
//
// Output: SkinPod { skeletonGuid, jointPaths, vertexCount, influences }

import type { SkinPod, SkinVertexInfluencePod } from '@forgeax/engine-types';

export interface FbxRawSkinInfluence {
  readonly jointIndices: number[];
  readonly jointWeights: number[];
}

export interface FbxRawSkin {
  readonly meshSourceIndex: number;
  readonly jointPaths: string[];
  readonly vertexCount: number;
  readonly influences: readonly FbxRawSkinInfluence[];
}

export interface FbxRawSkinDoc {
  readonly skins?: readonly FbxRawSkin[];
}

function bridgeSkeletonGuid(_jointPaths: readonly string[]): string {
  // Deterministic GUID from joint paths. Real GUID assignment happens
  // at import-runner time; this is a placeholder bridge identifier.
  return 'fbx-skeleton-000000000000';
}

function toInfluence(raw: FbxRawSkinInfluence): SkinVertexInfluencePod {
  // Pad to exactly 4 entries
  const ji = new Uint16Array(4);
  const jw = new Float32Array(4);
  for (let i = 0; i < 4; i++) {
    ji[i] = raw.jointIndices[i] ?? 0;
    jw[i] = raw.jointWeights[i] ?? 0;
  }
  return { jointIndices: ji, jointWeights: jw };
}

/**
 * Parse the first skin from a C++ JSON POD document.
 * Returns an empty skin when the document has no skin data.
 */
export function parseSkin(doc: FbxRawSkinDoc): SkinPod {
  const skins = doc.skins;
  if (!skins || skins.length === 0) {
    return { skeletonGuid: '', jointPaths: [], vertexCount: 0, influences: [] };
  }

  const skin = skins[0];
  if (!skin) {
    return { skeletonGuid: '', jointPaths: [], vertexCount: 0, influences: [] };
  }
  return {
    skeletonGuid: bridgeSkeletonGuid(skin.jointPaths),
    jointPaths: [...skin.jointPaths],
    vertexCount: skin.vertexCount,
    influences: skin.influences.map(toInfluence),
  };
}
