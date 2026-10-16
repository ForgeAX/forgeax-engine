// parse-scene.test.ts -- M3 t33: scene hierarchy parse-bridge unit test.
//
// R1 fixup: tests now import the real parseScene from src/parse-scene.ts
// (instead of an inline stub), closing the AC-03 coverage gap.

import { describe, expect, it } from 'vitest';
import type { ScenePod } from '@forgeax/engine-types';
import { parseScene } from '../src/parse-scene.js';
import type { FbxRawNode, FbxRawNodes } from '../src/parse-scene.js';

const MOCK_SCENE_RAW: FbxRawNodes = {
  nodes: [
    {
      name: 'Parent',
      transform: {
        translation: [0, 1, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      meshIndex: -1,
      children: [1],
    },
    {
      name: 'Child',
      transform: {
        translation: [2, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      meshIndex: 0,
      children: [],
    },
  ],
};

describe('parseScene', () => {
  it('parses parent-child hierarchy from FbxRawNodes', () => {
    const pod: ScenePod = parseScene(MOCK_SCENE_RAW);
    expect(pod.entities.length).toBe(2);
    expect(pod.rootEntityIndex).toBe(0);

    const parent = pod.entities[0]!;
    expect(parent.name).toBe('Parent');
    expect(parent.transform.translation[0]).toBe(0);
    expect(parent.transform.translation[1]).toBe(1);
    expect(parent.transform.translation[2]).toBe(0);
    expect(parent.transform.rotation).toEqual([0, 0, 0, 1]);
    expect(parent.transform.scale).toEqual([1, 1, 1]);
    expect(parent.meshIndex).toBeNull();
    expect(parent.children).toEqual([1]);

    const child = pod.entities[1]!;
    expect(child.name).toBe('Child');
    expect(child.transform.translation[0]).toBe(2);
    expect(child.meshIndex).toBe(0);
    expect(child.children).toEqual([]);
  });

  it('returns empty entities for empty nodes', () => {
    const pod = parseScene({ nodes: [] });
    expect(pod.entities.length).toBe(0);
  });

  it('returns empty entities for missing nodes', () => {
    const pod = parseScene({});
    expect(pod.entities.length).toBe(0);
  });

  it('handles root entity with multiple children', () => {
    const raw: FbxRawNodes = {
      nodes: [
        {
          name: 'Root',
          transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          meshIndex: -1,
          children: [1, 2],
        },
        {
          name: 'Left',
          transform: { translation: [-1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          meshIndex: -1,
          children: [],
        },
        {
          name: 'Right',
          transform: { translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          meshIndex: -1,
          children: [],
        },
      ],
    };
    const pod = parseScene(raw);
    expect(pod.entities.length).toBe(3);
    const root = pod.entities[0]!;
    expect(root.children).toEqual([1, 2]);
  });
});