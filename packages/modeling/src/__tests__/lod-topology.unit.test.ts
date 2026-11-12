import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { lodTopologyReport } from '../lod-topology';
import { model } from '../model';
import { assertLodTopology } from './lod-topology';

function meshOf(positions: readonly number[], triangles: readonly number[]): MeshAsset {
  const position = new Float32Array(positions);
  const indices = new Uint32Array(triangles);
  return {
    kind: 'mesh',
    vertices: position,
    indices,
    attributes: { position },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: position.length / 3,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'default' }],
  } as unknown as MeshAsset;
}

/** A box whose render vertices are split per face: 24 vertices, bitwise-equal positions repeat. */
function splitBox(): MeshAsset {
  const m = model();
  m.box({ size: [1, 1, 1] });
  m.uv.project({ mode: 'planar', axis: 'y', scale: 1 });
  const out = m.toMesh({ normals: { mode: 'flat' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

function positionsOf(mesh: MeshAsset): Float32Array {
  return mesh.attributes.position as Float32Array;
}

function append(
  base: MeshAsset,
  positions: readonly number[],
  triangles: readonly number[],
): MeshAsset {
  const baseCount = positionsOf(base).length / 3;
  return meshOf(
    [...positionsOf(base), ...positions],
    [...(base.indices as Uint32Array), ...triangles.map((i) => i + baseCount)],
  );
}

// 3x3 grid on the xz plane, vertex (i, j) = j * 3 + i.
const GRID = Array.from({ length: 9 }, (_, v) => [v % 3, 0, Math.floor(v / 3)]).flat();
const GRID_TRIS = [0, 4, 1, 0, 3, 4, 1, 4, 2, 2, 4, 5, 3, 6, 4, 4, 6, 7, 4, 7, 8, 4, 8, 5];
// The same boundary ring with the interior vertex dropped: a fan from corner 0.
const RING_FAN = [0, 3, 6, 0, 6, 7, 0, 7, 8, 0, 8, 5, 0, 5, 2, 0, 2, 1];

describe('lodTopologyReport', () => {
  it('welds duplicated positions: a box with 24 render vertices is closed', () => {
    const box = splitBox();
    expect(positionsOf(box).length / 3).toBe(24);
    expect(lodTopologyReport([box])).toEqual([
      { lod: 0, freeChains: 0, nonManifoldEdges: 0, boundarySetEqualsLod0: true },
    ]);
  });

  it('counts one chain for an open grid and accepts a re-triangulated interior', () => {
    const lod0 = meshOf(GRID, GRID_TRIS);
    const lod1 = meshOf(GRID, RING_FAN);
    const report = lodTopologyReport([lod0, lod1]);
    expect(report.map((r) => r.freeChains)).toEqual([1, 1]);
    expect(report.map((r) => r.boundarySetEqualsLod0)).toEqual([true, true]);
    expect(() => assertLodTopology([lod0, lod1])).not.toThrow();
  });

  it('matches boundary edges through welding when a LOD splits its vertices', () => {
    const lod0 = meshOf(GRID, GRID_TRIS);
    const positions = RING_FAN.flatMap((v) => GRID.slice(v * 3, v * 3 + 3));
    const lod1 = meshOf(
      positions,
      RING_FAN.map((_, i) => i),
    );
    expect(lodTopologyReport([lod0, lod1])[1]).toEqual({
      lod: 1,
      freeChains: 1,
      nonManifoldEdges: 0,
      boundarySetEqualsLod0: true,
    });
  });

  it('reports a 4-face edge as non-manifold', () => {
    const lod0 = splitBox();
    const box = splitBox();
    const p = positionsOf(box);
    const idx = box.indices as Uint32Array;
    const edge = [idx[0] as number, idx[1] as number].flatMap((v) => [
      p[v * 3] as number,
      p[v * 3 + 1] as number,
      p[v * 3 + 2] as number,
    ]);
    const lod1 = append(box, [...edge, 5, 5, 5, 6, 6, 6], [0, 1, 2, 1, 0, 3]);
    expect(lodTopologyReport([lod0, lod1])[1]?.nonManifoldEdges).toBe(1);
    expect(() => assertLodTopology([lod0, lod1])).toThrow(/lod1: 1 non-manifold edges/);
  });

  it('reads positions from the interleaved vertex buffer when attributes are not Float32Array', () => {
    const box = splitBox();
    const opaque = Object.fromEntries(
      Object.keys(box.attributes).map((key) => [key, new ArrayBuffer(0)]),
    );
    const packed = { ...box, attributes: opaque } as unknown as MeshAsset;
    expect(lodTopologyReport([packed, box])).toEqual([
      { lod: 0, freeChains: 0, nonManifoldEdges: 0, boundarySetEqualsLod0: true },
      { lod: 1, freeChains: 0, nonManifoldEdges: 0, boundarySetEqualsLod0: true },
    ]);
  });

  it('counts an extra free chain and fails the boundary gate', () => {
    const lod0 = splitBox();
    const lod1 = append(splitBox(), [4, 4, 4, 5, 4, 4, 4, 5, 4], [0, 1, 2]);
    const report = lodTopologyReport([lod0, lod1]);
    expect(report[0]?.freeChains).toBe(0);
    expect(report[1]).toEqual({
      lod: 1,
      freeChains: 1,
      nonManifoldEdges: 0,
      boundarySetEqualsLod0: false,
    });
    expect(() => assertLodTopology([lod0, lod1])).toThrow(/lod1: boundary set differs/);
  });

  it('detects a moved boundary vertex', () => {
    const lod0 = meshOf(GRID, GRID_TRIS);
    const moved = GRID.slice();
    moved[3 * 8 + 1] = 0.25;
    const lod1 = meshOf(moved, GRID_TRIS);
    expect(lodTopologyReport([lod0, lod1])[1]).toEqual({
      lod: 1,
      freeChains: 1,
      nonManifoldEdges: 0,
      boundarySetEqualsLod0: false,
    });
    expect(() => assertLodTopology([lod0, lod1])).toThrow(/boundary set differs/);
  });

  it('gates LOD0 itself and ignores non triangle-list submeshes', () => {
    const fin = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1];
    const bad = meshOf(fin, [0, 1, 2, 1, 0, 3, 0, 1, 4]);
    expect(lodTopologyReport([bad])[0]?.nonManifoldEdges).toBe(1);
    expect(() => assertLodTopology([bad])).toThrow(/lod0: 1 non-manifold/);
    const lines = {
      ...meshOf(GRID, GRID_TRIS),
      submeshes: [
        { indexOffset: 0, indexCount: 6, vertexCount: 9, topology: 'line-list', materialSlot: 0 },
      ],
    } as unknown as MeshAsset;
    expect(lodTopologyReport([lines])[0]).toEqual({
      lod: 0,
      freeChains: 0,
      nonManifoldEdges: 0,
      boundarySetEqualsLod0: true,
    });
  });

  it('keeps disjoint boundary chains apart', () => {
    const two = meshOf([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0, 0, 6, 0, 0, 5, 1, 0], [0, 1, 2, 3, 4, 5]);
    expect(lodTopologyReport([two])[0]?.freeChains).toBe(2);
  });
});
