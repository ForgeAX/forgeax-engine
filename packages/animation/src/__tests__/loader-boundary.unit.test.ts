import { animationGraphLoader } from '@forgeax/engine-assets-runtime';
import { expect, it } from 'vitest';
import { serializeAnimationGraph } from '../graph/serialize-animation-graph';

it('keeps graph payload decoding in assets-runtime', () => {
  expect(animationGraphLoader.kind).toBe('animation-graph');
});

it('serializes a durable clip GUID without a World handle or resolver cast', () => {
  const guid = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
  const graph = {
    kind: 'animation-graph',
    nodes: [{ type: 'clip', clip: guid, weight: 1 }],
    root: 0,
  } as never;

  const result = serializeAnimationGraph(graph, (clip) => clip);

  expect(result).toEqual({
    payload: {
      nodes: [{ type: 'clip', clip: 0, weight: 1 }],
      root: 0,
    },
    refs: [guid],
  });
  expect(JSON.stringify(result?.payload)).not.toContain('shared');
});

it('rejects a missing durable clip GUID instead of inventing a handle', () => {
  const graph = {
    kind: 'animation-graph',
    nodes: [{ type: 'clip', clip: '', weight: 1 }],
    root: 0,
  } as never;

  expect(serializeAnimationGraph(graph, (clip) => clip || undefined)).toBeUndefined();
});

it('rejects the removed numeric clip-handle durable shape', () => {
  const graph = {
    kind: 'animation-graph',
    nodes: [{ type: 'clip', clip: 7, weight: 1 }],
    root: 0,
  } as never;

  expect(
    serializeAnimationGraph(graph, (clip) => (typeof clip === 'string' ? clip : undefined)),
  ).toBeUndefined();
});
