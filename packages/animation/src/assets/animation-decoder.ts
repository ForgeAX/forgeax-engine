import {
  ANIMATION_CLIP_SAMPLES_ARTIFACT,
  decodeAnimationClipSamples,
} from '@forgeax/engine-pack/runtime';
import {
  type AnimationChannel,
  type AnimationClip,
  type AnimationGraph,
  type AnimationGraphNode,
  type AssetDecoderContribution,
  type AssetKind,
  err,
  ok,
} from '@forgeax/engine-types';
import { AnimationPlaybackError } from '../playback-errors';
import { isAnimationTargetId } from '../target-id';
import { validateAnimationTimeline } from '../timeline';

const invalid = (guid: string, expected: string) =>
  err({
    code: 'asset-package-invalid' as const,
    expected,
    hint: 'recook the animation asset and publish its complete payload',
    detail: { guid, reason: 'animation owner validation failed' },
  });

function refGuid(value: unknown, refs: readonly string[]): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return refs[value];
  }
  return undefined;
}

function graphNode(value: unknown, refs: readonly string[]): AnimationGraphNode | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.weight !== 'number' || !Number.isFinite(source.weight)) return undefined;
  if (source.type === 'clip') {
    const clip = refGuid(source.clip, refs);
    return clip === undefined ? undefined : { type: 'clip', clip, weight: source.weight };
  }
  if (source.type === 'blend') {
    return Array.isArray(source.children) &&
      source.children.every((child) => Number.isSafeInteger(child) && (child as number) >= 0)
      ? { type: 'blend', children: source.children as number[], weight: source.weight }
      : undefined;
  }
  if (source.type === 'add') {
    return typeof source.base === 'number' &&
      Number.isSafeInteger(source.base) &&
      source.base >= 0 &&
      Array.isArray(source.additive) &&
      source.additive.every((child) => Number.isSafeInteger(child) && (child as number) >= 0)
      ? {
          type: 'add',
          base: source.base,
          additive: source.additive as number[],
          weight: source.weight,
        }
      : undefined;
  }
  return undefined;
}

function clipPayload(payload: Record<string, unknown>): AnimationClip | undefined {
  const duration = typeof payload.duration === 'number' ? payload.duration : 0;
  if (!Number.isFinite(duration) || duration < 0) return undefined;
  const channelsRaw = payload.channels;
  if (!Array.isArray(channelsRaw)) return undefined;
  const channels: AnimationChannel[] = [];
  for (const ch of channelsRaw) {
    if (typeof ch !== 'object' || ch === null) return undefined;
    const chObj = ch as Record<string, unknown>;
    const targetId = chObj.targetId;
    const property = chObj.property;
    const samplerObj = chObj.sampler as Record<string, unknown> | undefined;
    if (
      !isAnimationTargetId(targetId) ||
      Object.keys(chObj).some(
        (key) =>
          key !== 'targetId' &&
          key !== 'property' &&
          key !== 'sampler' &&
          !(chObj.property === 'property' && key === 'binding'),
      )
    ) {
      return undefined;
    }
    if (
      property !== 'translation' &&
      property !== 'rotation' &&
      property !== 'scale' &&
      property !== 'weights' &&
      property !== 'property'
    )
      return undefined;
    if (samplerObj === null || typeof samplerObj !== 'object' || Array.isArray(samplerObj))
      return undefined;
    const inputRaw = samplerObj.input;
    const outputRaw = samplerObj.output;
    const interpolation = samplerObj.interpolation;
    let input: Float32Array;
    if (inputRaw instanceof Float32Array) {
      input = inputRaw;
    } else if (Array.isArray(inputRaw) && inputRaw.every((value) => typeof value === 'number')) {
      input = new Float32Array(inputRaw as number[]);
    } else {
      return undefined;
    }
    if (
      input.length === 0 ||
      input.some(
        (time, index) =>
          !Number.isFinite(time) || time < 0 || (index > 0 && time <= (input[index - 1] ?? NaN)),
      )
    )
      return undefined;
    if (
      property === 'property' &&
      Array.isArray(outputRaw) &&
      (outputRaw.every((value) => typeof value === 'string') ||
        outputRaw.every((value) => typeof value === 'boolean'))
    ) {
      if (
        interpolation !== 'STEP' ||
        outputRaw.length !== input.length ||
        typeof chObj.binding !== 'string' ||
        chObj.binding.length === 0
      )
        return undefined;
      channels.push({
        targetId: targetId as AnimationChannel['targetId'],
        property,
        binding: chObj.binding,
        sampler: { input, output: outputRaw as string[] | boolean[], interpolation },
      });
      continue;
    }
    let output: Float32Array;
    if (outputRaw instanceof Float32Array) {
      output = outputRaw;
    } else if (Array.isArray(outputRaw) && outputRaw.every((value) => typeof value === 'number')) {
      output = new Float32Array(outputRaw as number[]);
    } else {
      return undefined;
    }
    if (interpolation !== 'LINEAR' && interpolation !== 'STEP' && interpolation !== 'CUBICSPLINE')
      return undefined;
    const factor = interpolation === 'CUBICSPLINE' ? 3 : 1;
    const width = output.length / input.length / factor;
    if (
      input.length < (factor === 3 ? 2 : 1) ||
      !Number.isInteger(width) ||
      width < 1 ||
      output.some((value) => !Number.isFinite(value)) ||
      ((property === 'translation' || property === 'scale') && width !== 3) ||
      (property === 'rotation' && width !== 4) ||
      (property === 'weights' && width > 8)
    )
      return undefined;
    if (property === 'property') {
      if (typeof chObj.binding !== 'string' || chObj.binding.length === 0) return undefined;
      channels.push({
        targetId: targetId as AnimationChannel['targetId'],
        property,
        binding: chObj.binding,
        sampler: { input, output, interpolation },
      });
    } else
      channels.push({
        targetId: targetId as AnimationChannel['targetId'],
        property,
        sampler: { input, output, interpolation },
      });
  }
  if (payload.events !== undefined && !Array.isArray(payload.events)) return undefined;
  return {
    kind: 'animation-clip',
    duration,
    channels,
    ...(payload.events === undefined ? {} : { events: payload.events }),
  };
}

export const animationClipContribution: AssetDecoderContribution<AnimationClip, 'animation-clip'> =
  {
    kind: { kind: 'animation-clip' } as AssetKind<AnimationClip, 'animation-clip'>,
    consumer: 'AnimationPlayer',
    decoder: {
      async decode({ envelope, artifacts }) {
        let value: unknown = envelope.payload;
        const samples = envelope.artifacts[ANIMATION_CLIP_SAMPLES_ARTIFACT];
        if (samples !== undefined && value !== null && typeof value === 'object') {
          const bytes = await artifacts.read(samples);
          if (!bytes.ok) return bytes;
          const resolved = decodeAnimationClipSamples(
            value as Record<string, unknown>,
            bytes.value,
          );
          if (!resolved.ok) return invalid(envelope.guid, resolved.error);
          value = resolved.value;
        }
        const clip =
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          (value as { kind?: unknown }).kind === 'animation-clip'
            ? clipPayload(value as Record<string, unknown>)
            : undefined;
        if (clip === undefined)
          return invalid(
            envelope.guid,
            'an animation clip with valid channels, sampler arrays and non-negative duration',
          );
        try {
          validateAnimationTimeline(clip);
        } catch (failure) {
          if (failure instanceof AnimationPlaybackError)
            return invalid(envelope.guid, failure.expected);
          throw failure;
        }
        return ok(clip);
      },
    },
  };

export const animationGraphContribution: AssetDecoderContribution<
  AnimationGraph,
  'animation-graph'
> = {
  kind: { kind: 'animation-graph' } as AssetKind<AnimationGraph, 'animation-graph'>,
  consumer: 'evaluateAnimationGraph',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload as unknown;
      if (payload === null || typeof payload !== 'object') {
        return invalid(envelope.guid, 'an animation graph with at least one node');
      }
      const source = payload as Record<string, unknown>;
      if (
        source.kind !== 'animation-graph' ||
        !Array.isArray(source.nodes) ||
        source.nodes.length === 0 ||
        !Number.isSafeInteger(source.root) ||
        (source.root as number) < 0
      ) {
        return invalid(envelope.guid, 'an animation graph with at least one node');
      }
      const nodes: AnimationGraphNode[] = [];
      for (const value of source.nodes) {
        const node = graphNode(value, envelope.refs);
        if (node === undefined) {
          return invalid(envelope.guid, 'an animation graph with resolvable node references');
        }
        nodes.push(node);
      }
      const isIndex = (index: number) => index >= 0 && index < nodes.length;
      if (
        !isIndex(source.root as number) ||
        nodes.some((node) =>
          node.type === 'blend'
            ? node.children.some((index) => !isIndex(index))
            : node.type === 'add' &&
              (!isIndex(node.base) || node.additive.some((index) => !isIndex(index))),
        )
      )
        return invalid(envelope.guid, 'animation graph references within the node table');
      return ok({ kind: 'animation-graph', nodes, root: source.root as number });
    },
  },
};
