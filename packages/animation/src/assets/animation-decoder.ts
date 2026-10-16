import {
  type AnimationClip,
  type AnimationGraph,
  type AnimationGraphNode,
  type AssetDecoderContribution,
  type AssetKind,
  err,
  ok,
} from '@forgeax/engine-types';
import { AnimationPlaybackError } from '../playback-errors';
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

export const animationClipContribution: AssetDecoderContribution<AnimationClip, 'animation-clip'> =
  {
    kind: { kind: 'animation-clip' } as AssetKind<AnimationClip, 'animation-clip'>,
    consumer: 'AnimationPlayer',
    decoder: {
      async decode({ envelope }) {
        try {
          validateAnimationTimeline(envelope.payload);
        } catch (failure) {
          if (failure instanceof AnimationPlaybackError)
            return invalid(envelope.guid, failure.expected);
          throw failure;
        }
        return envelope.payload.kind === 'animation-clip' &&
          Array.isArray(envelope.payload.channels) &&
          Number.isFinite(envelope.payload.duration) &&
          envelope.payload.duration >= 0
          ? ok(envelope.payload)
          : invalid(envelope.guid, 'an animation clip with channels and non-negative duration');
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
      return ok({ kind: 'animation-graph', nodes, root: source.root as number });
    },
  },
};
