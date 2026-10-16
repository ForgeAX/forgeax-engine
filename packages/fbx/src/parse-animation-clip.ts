// Native ufbx baking owns source evaluation; this bridge retains its timeline and normalizes quaternion POD values.
import { deriveAnimationTargetId } from '@forgeax/engine-animation/target-id';
import type { AnimationChannelPod, AnimationClipPod } from '@forgeax/engine-types';
import { err, type FbxError, fbxErr, ok, type Result } from './errors.js';
import { buildFbxNodePaths } from './parse-scene.js';

export interface FbxRawAnimChannel {
  readonly targetNode: string;
  readonly property: 'translation' | 'rotation' | 'scale' | 'weights';
  /** Ascending key timestamps in seconds. */
  readonly keyTimes?: number[];
  /** Interleaved key values, stride 3/4 or weightCount for morph weights. */
  readonly keyValues?: number[];
  /** Number of morph weight elements in each sampled key. */
  readonly weightCount?: number;
}

export interface FbxRawClip {
  readonly name?: string;
  readonly duration: number;
  readonly channels: readonly FbxRawAnimChannel[];
}

export interface FbxRawAnimDoc {
  readonly clips?: readonly FbxRawClip[];
}

/** Retain the native baked timeline; a second fixed-rate resample loses short actions and clip tails. */
function buildChannel(ch: FbxRawAnimChannel): AnimationChannelPod {
  const stride =
    ch.property === 'rotation' ? 4 : ch.property === 'weights' ? (ch.weightCount ?? 0) : 3;
  const input = Float32Array.from(ch.keyTimes ?? []),
    output = Float32Array.from(ch.keyValues ?? []);
  if (
    !Number.isInteger(stride) ||
    stride < 1 ||
    stride > 8 ||
    output.length !== input.length * stride ||
    input.some((t, i) => !Number.isFinite(t) || t < 0 || (i > 0 && t <= (input[i - 1] ?? NaN))) ||
    output.some((value) => !Number.isFinite(value))
  )
    throw new Error(
      'fbx-animation-invalid: expected finite, strictly increasing times and matching values',
    );
  if (ch.property === 'rotation') {
    for (let key = 0; key < input.length; key++) {
      const base = key * 4,
        length = Math.hypot(...output.subarray(base, base + 4));
      if (!(length > 0)) throw new Error('fbx-animation-invalid: zero quaternion');
      for (let c = 0; c < 4; c++) output[base + c] = (output[base + c] ?? NaN) / length;
    }
  }
  return {
    targetId: deriveAnimationTargetId(ch.targetNode.split('/')),
    property: ch.property,
    sampler: { input, output, interpolation: 'LINEAR' },
  };
}

interface FbxAnimationNode {
  readonly name: string;
  readonly children: readonly number[];
}

export function resolveAnimationTargetIds(
  nodes: readonly FbxAnimationNode[],
  clips: readonly FbxRawClip[],
): Result<void, FbxError> {
  const nodesByPath = new Map<string, number[]>();
  const nodePaths = buildFbxNodePaths(nodes);
  const cycle = nodePaths.find((path) => !path.ok && path.reason === 'hierarchy-cycle');
  if (cycle && !cycle.ok) {
    return err(
      fbxErr('fbx-animation-target-invalid', {
        reason: 'hierarchy-cycle',
        nodeIndex: cycle.nodeIndex,
      }),
    );
  }
  const hasAmbiguousName = nodePaths.some((path) => !path.ok);
  for (let index = 0; index < nodePaths.length; index++) {
    const result = nodePaths[index];
    if (result === undefined || !result.ok) continue;
    const path = result.value.join('/');
    const matches = nodesByPath.get(path) ?? [];
    matches.push(index);
    nodesByPath.set(path, matches);
  }

  const pathById = new Map<string, string>();
  for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
    const clip = clips[clipIndex];
    if (clip === undefined) continue;
    for (let channelIndex = 0; channelIndex < clip.channels.length; channelIndex++) {
      const channel = clip.channels[channelIndex];
      if (channel === undefined) continue;
      const segments = channel.targetNode.split('/');
      if (segments.some((segment) => segment.length === 0)) {
        return err(
          fbxErr('fbx-animation-target-invalid', {
            reason: 'path-invalid',
            clipIndex,
            channelIndex,
            targetNode: channel.targetNode,
          }),
        );
      }
      const matches = nodesByPath.get(channel.targetNode);
      if (matches === undefined) {
        return err(
          fbxErr('fbx-animation-target-invalid', {
            reason: hasAmbiguousName ? 'name-missing' : 'path-not-found',
            clipIndex,
            channelIndex,
            targetNode: channel.targetNode,
          }),
        );
      }
      if (matches.length !== 1) {
        return err(
          fbxErr('fbx-animation-target-invalid', {
            reason: 'path-duplicate',
            clipIndex,
            channelIndex,
            targetNode: channel.targetNode,
          }),
        );
      }
      const id = deriveAnimationTargetId(segments);
      const previous = pathById.get(id);
      if (previous !== undefined && previous !== channel.targetNode) {
        return err(
          fbxErr('fbx-animation-target-invalid', {
            reason: 'id-collision',
            clipIndex,
            channelIndex,
            targetNode: channel.targetNode,
          }),
        );
      }
      pathById.set(id, channel.targetNode);
    }
  }
  return ok(undefined);
}

/**
 * Parse animation clips from a C++ JSON POD document.
 * Retains the bounded native source-evaluated timeline as Float32 LINEAR POD.
 *
 * Returns an empty array when the document has no clip data.
 */
export function parseAnimationClips(doc: FbxRawAnimDoc): AnimationClipPod[] {
  const clips = doc.clips;
  if (!clips || clips.length === 0) return [];

  return clips.map((clip): AnimationClipPod => {
    return {
      ...(clip.name !== undefined && { name: clip.name }),
      duration: clip.duration,
      channels: clip.channels.map((ch) => buildChannel(ch)),
    };
  });
}
