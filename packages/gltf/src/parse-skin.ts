// parse-skin.ts - glTF skin parser (feat-20260523-skin-skeleton-animation M0).
//
// Implements parseSkin(): parses glTF `skins[]` array into GltfSkeletonRecord[]
// with IBM (inverse bind matrices) and jointPaths (Name-component path from
// scene root). Used by parseGltfWithBin to populate GltfDoc.
//
// Decision anchors:
//   - plan-strategy D-1 (3-asset separation: IBM / skin binding / animation clip)
//   - plan-strategy D-2 (skin index dedupe via reimport reuse managed by toAssetPack)
//   - requirements AC-03 (skin index dedupe), AC-05 (jointPaths + Name missing fail-fast)
//   - requirements AC-10 (IR extension)
//   - charter P3 (fail-fast on invalid data)

import { parseConservativeAnimatedBounds, type ShadowCapsuleSet } from '@forgeax/engine-types';
import {
  type AccessorJson,
  type BufferViewJson,
  decodeF32Accessor,
} from './accessor/decode-accessor.js';
import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';
import { buildNodeParentMap, resolveNamedNodePath } from './node-path.js';

/** Maximum joints per skin (glTF spec practical limit). */
const MAX_JOINTS = 256;

/**
 * Skeleton intermediate representation produced by parseSkin.
 *
 * Each entry corresponds to one glTF skin[] index. `jointPaths` is a
 * parallel array to the skeleton's joints; each path is the sequence of
 * Name-component values from the scene root to the joint node.
 */
export interface GltfSkeletonRecord {
  /** Number of joints in this skeleton (= IBM length / 16). */
  readonly jointCount: number;
  /** Inverse bind matrices, Float32Array of length jointCount * 16. */
  readonly inverseBindMatrices: Float32Array;
  /** Per-joint Name path from scene root (parallel to joints array). */
  readonly jointPaths: readonly string[];
  /** Producer-authored conservative animated local bounds when supplied. */
  readonly bounds?: Float32Array;
  /** Bind-space shadow capsules fitted from the skinned primitives. */
  readonly shadowCapsules?: ShadowCapsuleSet;
}

interface SkinJson {
  readonly name?: string;
  readonly joints: readonly number[];
  readonly inverseBindMatrices?: number;
  /** glTF source metadata authored by the ForgeaX asset producer. */
  readonly extras?: {
    readonly forgeax?: {
      readonly conservativeAnimatedBounds?: unknown;
    };
  };
}

interface NodeJson {
  readonly name?: string;
  readonly mesh?: number;
  readonly children?: readonly number[];
  readonly skin?: number;
}

const SKIN_ACCESSOR_TYPES = ['MAT4'] as const;

/** Build a column-major mat4 identity Float32Array (16 floats). */
function identityMat4(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/**
 * Build the jointPath for a single joint: find the Name-component path from
 * the root of the scene graph to the joint node.
 *
 * Uses recursive BFS-like upward traversal: for each joint node index,
 * find the node's name and verify it's reachable from root.
 * Returns the sequence of names from root to joint.
 *
 * On first miss (node has no name), emits 'gltf-skin-joint-name-missing'.
 */
function resolveJointPath(
  nodeIndex: number,
  nodes: readonly NodeJson[],
  parentOf: ReadonlyMap<number, number>,
  skinIndex: number,
  jointPathIndex: number,
): Result<readonly string[], GltfError> {
  const path = resolveNamedNodePath(nodes, parentOf, nodeIndex);
  if (!path.ok) {
    return err(
      gltfErr('gltf-skin-joint-name-missing', {
        reason: path.reason,
        skinIndex,
        jointPathIndex,
        nodeIndex: path.nodeIndex,
      }),
    );
  }
  return ok(path.value);
}

/**
 * Parse glTF skins[] array into GltfSkeletonRecord[].
 *
 * For each skin:
 * 1. Decode IBM accessor (or fill identity if absent)
 * 2. Resolve jointPaths from scene node hierarchy
 * 3. Fail-fast on joint count > MAX_JOINTS or missing joint names
 */
export function parseSkin(
  skinsJson: readonly SkinJson[] | undefined,
  nodesJson: readonly NodeJson[],
  accessors: readonly AccessorJson[],
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<readonly GltfSkeletonRecord[], GltfError> {
  if (skinsJson === undefined || skinsJson.length === 0) {
    return ok([]);
  }

  const records: GltfSkeletonRecord[] = [];
  const parentOf = buildNodeParentMap(nodesJson);

  for (let skinIdx = 0; skinIdx < skinsJson.length; skinIdx++) {
    const skin = skinsJson[skinIdx];
    if (skin === undefined) continue;

    const joints = skin.joints;
    if (joints.length > MAX_JOINTS) {
      return err(
        gltfErr('gltf-skin-joint-count-exceeded', {
          skinIndex: skinIdx,
          jointCount: joints.length,
          maxJoints: MAX_JOINTS,
        }),
      );
    }

    // Decode IBM, or fill identity matrix.
    let ibm: Float32Array;
    if (skin.inverseBindMatrices !== undefined) {
      const ibmAccIdx = skin.inverseBindMatrices;
      const ibmAcc = accessors[ibmAccIdx];
      if (ibmAcc === undefined) {
        return err(
          gltfErr('gltf-buffer-out-of-bounds', {
            accessor: ibmAccIdx,
            byteOffset: 0,
            byteLength: 0,
            bufferIndex: 0,
          }),
        );
      }
      const ibmResult = decodeF32Accessor(
        ibmAccIdx,
        ibmAcc,
        SKIN_ACCESSOR_TYPES,
        bufferViews,
        buffers,
      );
      if (!ibmResult.ok) return err(ibmResult.error);
      ibm = ibmResult.value;
    } else {
      // Fill identity: each joint gets a 4x4 identity.
      ibm = new Float32Array(joints.length * 16);
      for (let j = 0; j < joints.length; j++) {
        ibm.set(identityMat4(), j * 16);
      }
    }

    // Resolve jointPaths.
    const jointPaths: string[] = [];
    for (let j = 0; j < joints.length; j++) {
      const jointNodeIndex = joints[j];
      if (jointNodeIndex === undefined) continue;
      const pathResult = resolveJointPath(jointNodeIndex, nodesJson, parentOf, skinIdx, j);
      if (!pathResult.ok) return err(pathResult.error);
      jointPaths.push(pathResult.value.join('/'));
    }

    const bounds = parseConservativeAnimatedBounds(
      skin.extras?.forgeax?.conservativeAnimatedBounds,
    );
    records.push({
      jointCount: joints.length,
      inverseBindMatrices: ibm,
      jointPaths,
      ...(bounds === undefined ? {} : { bounds }),
    });
  }

  return ok(records);
}

/** Re-export MAX_JOINTS for use by downstream modules. */
export { MAX_JOINTS };
