// parse-mesh.test.ts -- M3 t32: mesh parse-bridge unit test.
//
// R1 fixup: tests now import the real parseMesh from src/parse-mesh.ts
// (instead of an inline stub), closing the AC-01 coverage gap.

import { describe, expect, it } from 'vitest';

import type { MeshPod } from '@forgeax/engine-types';
import { parseMesh } from '../src/parse-mesh.js';
import type { FbxRawMesh } from '../src/parse-mesh.js';

/** Mock bridge input: a single FbxRawMesh + sourceIndex=0. */
const MOCK_CUBE_RAW: FbxRawMesh = {
  name: 'Cube',
  vertices: [
    -5, -5, 0, 5, -5, 0, -5, 5, 0, 5, 5, 0,
    -5, -5, 10, 5, -5, 10, -5, 5, 10, 5, 5, 10,
  ],
  indices: [
    0, 2, 3, 3, 1, 0, 4, 5, 7, 7, 6, 4,
    0, 1, 5, 5, 4, 0, 1, 3, 7, 7, 5, 1,
    3, 2, 6, 6, 7, 3, 2, 0, 4, 4, 6, 2,
  ],
  attributes: {
    NORMAL: [
      -0.57735, -0.57735, -0.57735, 0.57735, -0.57735, -0.57735,
      -0.57735, 0.57735, -0.57735, 0.57735, 0.57735, -0.57735,
      -0.57735, -0.57735, 0.57735, 0.57735, -0.57735, 0.57735,
      -0.57735, 0.57735, 0.57735, 0.57735, 0.57735, 0.57735,
    ],
    TEXCOORD_0: [
      0, 0, 1, 0, 0, 1, 1, 1,
      0, 0, 1, 0, 0, 1, 1, 1,
    ],
  },
  polygonCount: 12,
  sourceIndex: 0,
  materialIndex: -1,
};

describe('parseMesh mock path', () => {
  it('parses mock cube FbxRawMesh to MeshPod', () => {
    const pod: MeshPod = parseMesh(MOCK_CUBE_RAW, 0);

    // MeshSubmeshPod shape
    expect(pod.submeshes.length).toBe(1);
    const sm = pod.submeshes[0]!;
    expect(sm.topology).toBe('triangle-list');
    expect(sm.indexOffset).toBe(0);
    expect(sm.indexCount).toBe(36);

    // vertices
    expect(pod.vertices.length).toBe(24); // 8 verts * 3 floats
    expect(pod.vertices[0]).toBe(-5);
    expect(pod.vertices[1]).toBe(-5);
    expect(pod.vertices[2]).toBe(0);

    // indices
    expect(pod.indices).toBeDefined();
    const idx = pod.indices as Uint16Array;
    expect(idx.length).toBe(36);

    // attributes
    expect(pod.attributes.NORMAL).toBeDefined();
    const normal = pod.attributes.NORMAL!;
    expect(normal.length).toBe(24); // 8 verts * 3 floats

    expect(pod.attributes.TEXCOORD_0).toBeDefined();
    const uv = pod.attributes.TEXCOORD_0!;
    expect(uv.length).toBe(16); // 8 verts * 2 floats

    // sourceIndex
    expect(pod.sourceIndex).toBe(0);
  });

  it('handles missing indices (non-indexed mesh)', () => {
    const raw: FbxRawMesh = {
      name: 'Triangle',
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      attributes: {},
      polygonCount: 1,
      sourceIndex: 0,
      materialIndex: 0,
    };
    const pod = parseMesh(raw, 0);
    expect(pod.indices).toBeUndefined();
    expect(pod.vertices.length).toBe(9);
    expect(pod.submeshes[0]!.indexCount).toBe(0);
  });

  it('handles negative materialIndex as null', () => {
    const pod = parseMesh(MOCK_CUBE_RAW, 0);
    expect(pod.submeshes[0]!.materialIndex).toBeNull();
  });
});