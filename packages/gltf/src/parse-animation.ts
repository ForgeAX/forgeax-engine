// parse-animation.ts - glTF animation parser (feat-20260523-skin-skeleton-animation M0).
//
// Implements parseAnimation(): parses glTF `animations[]` array into
// GltfAnimationClipRecord[] with duration, channels, and sampler data.
// Used by parseGltfWithBin to populate GltfDoc.
//
// Decision anchors:
//   - plan-strategy D-1 (AnimationClip independent asset)
//   - requirements AC-07 (AnimationClip shape), AC-09 (CUBICSPLINE/morph fail-fast)
//   - requirements AC-10 (IR extension)
//   - charter P3 (fail-fast on unsupported interpolation/morph targets)

import { deriveAnimationTargetId } from '@forgeax/engine-animation/target-id';
import type { AnimationTargetIdValue } from '@forgeax/engine-types';
import {
  type AccessorJson,
  type BufferViewJson,
  decodeF32Accessor,
} from './accessor/decode-accessor.js';
import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';
import { buildNodeParentMap, resolveNamedNodePath } from './node-path.js';

/** Supported interpolation modes (CUBICSPLINE is deferred to OOS-skin-cubicspline). */
type Interpolation = 'LINEAR' | 'STEP' | 'CUBICSPLINE';

interface ChannelJson {
  readonly sampler: number;
  readonly target: {
    readonly node?: number;
    readonly path: string;
  };
}

interface SamplerJson {
  readonly input: number;
  readonly output: number;
  readonly interpolation?: string;
}

interface AnimationJson {
  readonly name?: string;
  readonly channels: readonly ChannelJson[];
  readonly samplers: readonly SamplerJson[];
}

const ANIMATION_ACCESSOR_TYPES = ['SCALAR', 'VEC2', 'VEC3', 'VEC4'] as const;

export interface GltfAnimationChannelRecord {
  readonly targetId: AnimationTargetIdValue;
  readonly targetNodeIndex: number;
  /** 'translation' | 'rotation' | 'scale' | 'weights'. */
  readonly property: 'translation' | 'rotation' | 'scale' | 'weights';
  /** Sampler driving this channel. */
  readonly sampler: GltfAnimationSamplerRecord;
}

export interface GltfAnimationSamplerRecord {
  /** Keyframe timestamp array (ascending). */
  readonly input: Float32Array;
  /** Keyframe value array per element size. */
  readonly output: Float32Array;
  /** 'LINEAR' | 'STEP'. */
  readonly interpolation: Interpolation;
}

export interface GltfAnimationClipRecord {
  /** Producer-authored animation name, when the source provides one. */
  readonly name?: string;
  /** Clip duration = max(sampler.input[last]). */
  readonly duration: number;
  /** Per-joint-property channels. */
  readonly channels: readonly GltfAnimationChannelRecord[];
}

/**
 * Parse glTF animations[] array into GltfAnimationClipRecord[].
 *
 * Only LINEAR and STEP interpolation are supported. CUBICSPLINE triggers
 * fail-fast with 'gltf-animation-cubicspline-unsupported'. Channels targeting
 * morph weights preserve their element-major sampler output for playback.
 */
export function parseAnimation(
  animationsJson: readonly AnimationJson[] | undefined,
  nodesJson: readonly { readonly name?: string; readonly children?: readonly number[] }[],
  accessors: readonly AccessorJson[],
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<readonly GltfAnimationClipRecord[], GltfError> {
  if (animationsJson === undefined || animationsJson.length === 0) {
    return ok([]);
  }

  const clips: GltfAnimationClipRecord[] = [];
  const parentOf = buildNodeParentMap(nodesJson);
  const nodeByPath = new Map<string, number>();
  const pathById = new Map<AnimationTargetIdValue, string>();

  for (let animIdx = 0; animIdx < animationsJson.length; animIdx++) {
    const anim = animationsJson[animIdx];
    if (anim === undefined) continue;

    // Decode samplers first (shared across channels).
    const decodedSamplers: GltfAnimationSamplerRecord[] = [];
    for (let sampIdx = 0; sampIdx < anim.samplers.length; sampIdx++) {
      const sampler = anim.samplers[sampIdx];
      if (sampler === undefined) continue;

      const interpolation = (sampler.interpolation ?? 'LINEAR') as string;
      if (
        interpolation !== 'LINEAR' &&
        interpolation !== 'STEP' &&
        interpolation !== 'CUBICSPLINE'
      ) {
        return err(
          gltfErr('gltf-animation-sampler-invalid', {
            animationIndex: animIdx,
            samplerIndex: sampIdx,
            reason: 'interpolation',
          }),
        );
      }

      const inputAcc = accessors[sampler.input];
      if (inputAcc === undefined) {
        return err(
          gltfErr('gltf-buffer-out-of-bounds', {
            accessor: sampler.input,
            byteOffset: 0,
            byteLength: 0,
            bufferIndex: 0,
          }),
        );
      }
      const inputResult = decodeF32Accessor(
        sampler.input,
        inputAcc,
        ['SCALAR'],
        bufferViews,
        buffers,
      );
      if (!inputResult.ok) return err(inputResult.error);
      if (inputResult.value.length < (interpolation === 'CUBICSPLINE' ? 2 : 1))
        return err(
          gltfErr('gltf-animation-sampler-invalid', {
            animationIndex: animIdx,
            samplerIndex: sampIdx,
            reason: 'times',
          }),
        );

      const outputAcc = accessors[sampler.output];
      if (outputAcc === undefined) {
        return err(
          gltfErr('gltf-buffer-out-of-bounds', {
            accessor: sampler.output,
            byteOffset: 0,
            byteLength: 0,
            bufferIndex: 0,
          }),
        );
      }
      const outputResult = decodeF32Accessor(
        sampler.output,
        outputAcc,
        ANIMATION_ACCESSOR_TYPES,
        bufferViews,
        buffers,
      );
      if (!outputResult.ok) return err(outputResult.error);

      if (
        inputResult.value.length === 0 ||
        inputResult.value.some(
          (value, index) =>
            value < 0 || (index > 0 && value <= (inputResult.value[index - 1] ?? NaN)),
        )
      ) {
        return err(
          gltfErr('gltf-animation-sampler-invalid', {
            animationIndex: animIdx,
            samplerIndex: sampIdx,
            reason: 'times',
          }),
        );
      }
      decodedSamplers.push({
        input: inputResult.value,
        output: outputResult.value,
        interpolation: interpolation as Interpolation,
      });
    }

    // Decode channels.
    const channels: GltfAnimationChannelRecord[] = [];
    for (let chIdx = 0; chIdx < anim.channels.length; chIdx++) {
      const ch = anim.channels[chIdx];
      if (ch === undefined) continue;

      const samplerRecord = decodedSamplers[ch.sampler];
      if (samplerRecord === undefined) {
        return err(
          gltfErr('gltf-buffer-out-of-bounds', {
            accessor: ch.sampler,
            byteOffset: 0,
            byteLength: 0,
            bufferIndex: 0,
          }),
        );
      }

      const targetNodeIdx = ch.target.node;
      const path =
        targetNodeIdx === undefined
          ? { ok: false as const, reason: 'name-missing' as const, nodeIndex: -1 }
          : resolveNamedNodePath(nodesJson, parentOf, targetNodeIdx);
      if (!path.ok) {
        return err(
          gltfErr('gltf-animation-target-invalid', {
            reason: path.reason,
            animationIndex: animIdx,
            channelIndex: chIdx,
            nodeIndex: path.nodeIndex,
          }),
        );
      }
      if (
        ch.target.path !== 'weights' &&
        ch.target.path !== 'translation' &&
        ch.target.path !== 'rotation' &&
        ch.target.path !== 'scale'
      ) {
        return err(
          gltfErr('gltf-morph-unsupported', {
            animationIndex: animIdx,
            channelIndex: chIdx,
            nodeIndex: ch.target.node ?? -1,
          }),
        );
      }
      const stride =
        ch.target.path === 'rotation'
          ? 4
          : ch.target.path === 'weights'
            ? samplerRecord.output.length /
              samplerRecord.input.length /
              (samplerRecord.interpolation === 'CUBICSPLINE' ? 3 : 1)
            : 3;
      const expectedType =
        ch.target.path === 'weights' ? 'SCALAR' : ch.target.path === 'rotation' ? 'VEC4' : 'VEC3';
      const outputType = accessors[anim.samplers[ch.sampler]?.output ?? -1]?.type;
      if (
        outputType !== expectedType ||
        !Number.isInteger(stride) ||
        stride < 1 ||
        stride > 8 ||
        samplerRecord.output.length !==
          samplerRecord.input.length *
            stride *
            (samplerRecord.interpolation === 'CUBICSPLINE' ? 3 : 1)
      ) {
        return err(
          gltfErr('gltf-animation-sampler-invalid', {
            animationIndex: animIdx,
            samplerIndex: ch.sampler,
            reason: 'values',
          }),
        );
      }
      const pathKey = JSON.stringify(path.value);
      const previousNode = nodeByPath.get(pathKey);
      if (previousNode !== undefined && previousNode !== targetNodeIdx) {
        return err(
          gltfErr('gltf-animation-target-invalid', {
            reason: 'path-duplicate',
            animationIndex: animIdx,
            channelIndex: chIdx,
            nodeIndex: targetNodeIdx as number,
          }),
        );
      }
      nodeByPath.set(pathKey, targetNodeIdx as number);
      const targetId = deriveAnimationTargetId(path.value);
      const previousPath = pathById.get(targetId);
      if (previousPath !== undefined && previousPath !== pathKey) {
        return err(
          gltfErr('gltf-animation-target-invalid', {
            reason: 'id-collision',
            animationIndex: animIdx,
            channelIndex: chIdx,
            nodeIndex: targetNodeIdx as number,
          }),
        );
      }
      pathById.set(targetId, pathKey);

      channels.push({
        targetId,
        targetNodeIndex: targetNodeIdx as number,
        property: ch.target.path,
        sampler: samplerRecord,
      });
    }

    // Compute duration = max(sampler.input[last]) across all channels.
    let duration = 0;
    for (const ch of channels) {
      const input = ch.sampler.input;
      if (input.length > 0) {
        const last = input[input.length - 1];
        if (last !== undefined && last > duration) {
          duration = last;
        }
      }
    }

    const name = anim.name?.trim();
    clips.push({
      ...(name === undefined || name.length === 0 ? {} : { name }),
      duration,
      channels,
    });
  }

  return ok(clips);
}
