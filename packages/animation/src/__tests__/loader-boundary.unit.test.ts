import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { animationGraphContribution } from '../assets/animation-decoder';
import { serializeAnimationGraph } from '../graph/serialize-animation-graph';

it('decodes published graph references through the Animation owner', async () => {
  const guid = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
  const result = await animationGraphContribution.decoder.decode({
    envelope: {
      guid: '019e2cc6-0c86-79da-aa76-b0984c86d45d',
      kind: 'animation-graph',
      payload: {
        kind: 'animation-graph',
        nodes: [{ type: 'clip', clip: 0, weight: 1 }],
        root: 0,
      } as never,
      refs: [guid],
      artifacts: {},
    },
    artifacts: { read: async () => ok(new Uint8Array()) },
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ ok: true, value: { nodes: [{ type: 'clip', clip: guid }] } });
});

it('serializes a durable clip GUID without a World handle or resolver cast', () => {
  const guid = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
  const graph = {
    kind: 'animation-graph',
    nodes: [{ type: 'clip', clip: guid, weight: 1 }],
    root: 0,
  } as never;

  const result = serializeAnimationGraph(graph, (clip) =>
    typeof clip === 'string' ? clip : undefined,
  );

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

  expect(
    serializeAnimationGraph(graph, (clip) =>
      typeof clip === 'string' && clip.length > 0 ? clip : undefined,
    ),
  ).toBeUndefined();
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
