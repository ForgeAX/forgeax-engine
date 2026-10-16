import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Materials } from '../../materials';
import { admitPointsLines } from '../admission';
import { PointsLinesExpansionCache } from '../expansion-cache';
import { createPointsLinesSnapshot } from '../snapshot';
import threeDistances from './three-line-distances.json';

function mesh(topology: 'line-list' | 'line-strip', indexed = false): MeshAsset {
  const vertices = new Float32Array([0, 0, 0, 3, 0, 0, 3, 4, 0]);
  return {
    kind: 'mesh',
    vertices,
    attributes: { position: vertices },
    ...(indexed ? { indices: new Uint16Array([2, 1, 0]) } : {}),
    submeshes: [
      { topology, indexOffset: 0, indexCount: indexed ? 3 : 0, vertexCount: 3, materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'default' }],
  };
}
function range(source: MeshAsset) {
  const submesh = source.submeshes[0];
  if (submesh === undefined) throw new Error('missing fixture submesh');
  return submesh;
}

function expand(source: MeshAsset) {
  return new PointsLinesExpansionCache().getOrCreate(
    createPointsLinesSnapshot({
      worldId: 1,
      entityKey: 1,
      component: 'Lines',
      meshHandle: 1,
      meshGeneration: 1,
      materialHandle: 1,
      materialGeneration: 1,
      style: { kind: 'lines', width: 8 },
      layer: 1,
      visible: true,
      sourceBounds: [],
      viewport: { width: 320, height: 180, dpr: 1 },
      projection: [],
    }),
    source,
  );
}

describe('continuous lines', () => {
  it.each([
    false,
    true,
  ])('admits adjacent segments and budgets the actual strip count (indexed=%s)', (indexed) => {
    const input = {
      entity: 1,
      lines: {},
      mesh: mesh('line-strip', indexed),
      material: Materials.unlit([1, 1, 1, 1]),
    };
    const result = admitPointsLines(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.segmentCount).toBe(2);
    expect(admitPointsLines({ ...input, limits: { maxSegments: 1 } }).ok).toBe(false);
  });
  it('matches the actual pipeline stride and preserves cumulative distance across corners', () => {
    const geometry = expand(mesh('line-strip'));
    expect(geometry.segmentCount).toBe(2);
    expect(geometry.expandedIndexCount).toBe(12);
    expect(geometry.vertices.byteLength).toBe(
      8 * deriveVertexLayoutProjection(DEFAULT_VERTEX_ATTRIBUTE_MAP).arrayStride,
    );
    expect([
      geometry.vertices[11],
      geometry.vertices[35],
      geometry.vertices[59],
      geometry.vertices[83],
    ]).toEqual([0, 3, 3, 7]);
    expect([...geometry.vertices.slice(8, 11)]).toEqual([0, 0, 0]);
    expect([...geometry.vertices.slice(32, 35)]).toEqual([3, 4, 0]);
  });
  it('uses the indexed order for path distance', () => {
    const geometry = expand(mesh('line-strip', true));
    expect([
      geometry.vertices[11],
      geometry.vertices[35],
      geometry.vertices[59],
      geometry.vertices[83],
    ]).toEqual([0, 4, 4, 7]);
  });
  it.each([
    { dashSize: 0 },
    { gapSize: -1 },
    { dashOffset: NaN },
  ])('refuses invalid dash style %s', (lines) => {
    const result = admitPointsLines({
      entity: 1,
      lines,
      mesh: mesh('line-strip'),
      material: Materials.unlit([1, 1, 1, 1]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('points-lines-invalid-style');
  });
  it('closes indexed boundaries with shared endpoint neighbors', () => {
    const source = {
      ...mesh('line-strip'),
      indices: new Uint16Array([0, 1, 2, 0]),
      submeshes: [{ ...range(mesh('line-strip')), indexCount: 4 }],
    };
    const geometry = expand(source);
    expect(geometry.segmentCount).toBe(3);
    expect([...geometry.vertices.slice(8, 11)]).toEqual([3, 4, 0]);
    expect([...geometry.vertices.slice(128, 131)]).toEqual([3, 0, 0]);
    expect(geometry.vertices[131]).toBe(12);
  });
  it('collapses stationary trajectory samples without breaking joins or phase', () => {
    const source = mesh('line-strip');
    const repeated = {
      ...source,
      indices: new Uint16Array([0, 0, 1, 1, 1, 2, 2]),
      submeshes: [{ ...range(source), indexCount: 7 }],
    };
    expect(expand(repeated).vertices).toEqual(expand(source).vertices);
  });
  it('starts separate strip submeshes at zero without a bridge segment', () => {
    const source = mesh('line-strip');
    const geometry = expand({
      ...source,
      indices: new Uint16Array([0, 1, 1, 2]),
      submeshes: [
        { ...range(source), indexOffset: 0, indexCount: 2 },
        { ...range(source), indexOffset: 2, indexCount: 2 },
      ],
    });
    expect(geometry.segmentCount).toBe(2);
    expect([
      geometry.vertices[11],
      geometry.vertices[35],
      geometry.vertices[59],
      geometry.vertices[83],
    ]).toEqual([0, 3, 0, 4]);
  });
  it.each(threeDistances.cases)('matches Three.js r184 computeLineDistances for $name', ({
    name,
    positions,
    distances,
  }) => {
    const vertices = new Float32Array(positions);
    const source: MeshAsset = {
      ...mesh('line-strip'),
      vertices,
      attributes: { position: vertices },
      submeshes: [
        {
          ...range(mesh('line-strip')),
          vertexCount: positions.length / 3,
          topology: name === 'pairs' ? 'line-list' : 'line-strip',
        },
      ],
    };
    const geometry = expand(source);
    for (let segment = 0; segment < geometry.segmentCount; segment++) {
      const start = segment * (name === 'pairs' ? 2 : 1);
      expect(geometry.vertices[segment * 48 + 11]).toBe(distances[start]);
      expect(geometry.vertices[segment * 48 + 35]).toBe(distances[start + 1]);
    }
  });
});
