import type { NavigationMeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createNavigationMesh } from '../navmesh';

const asset: NavigationMeshAsset = {
  kind: 'navigation-mesh',
  version: 'recast-poly/1',
  sourceDigest: 'fixture',
  settings: {
    radius: 0.3,
    height: 1.8,
    maxSlopeDeg: 45,
    maxStep: 0.3,
    cellSize: 0.1,
    cellHeight: 0.05,
  },
  vertices: [0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4, 8, 0, 0, 8, 0, 4],
  polygons: [
    [0, 1, 2, 3],
    [1, 4, 5, 2],
  ],
};
describe('portable navigation mesh', () => {
  it('projects with a finite distance and routes through shared portals', () => {
    const mesh = createNavigationMesh(JSON.parse(JSON.stringify(asset))).unwrap();
    const route = mesh.findPath([1, 0, 1], [7, 0, 3], { maxProjection: 0.1 }).unwrap();
    expect(mesh.findPath([1, 0, 1], [7, 0, 3], { maxProjection: 0.1, maxVisited: 512 }).ok).toBe(
      true,
    );
    expect(
      mesh.findPath([1, 0, 1], [7, 0, 3], { maxProjection: 0.1, maxVisited: Infinity }).ok,
    ).toBe(false);
    expect(route.points.slice(0, 3)).toEqual(Float32Array.of(1, 0, 1));
    expect(route.points.slice(-3)).toEqual(Float32Array.of(7, 0, 3));
    expect(mesh.project([-1, 0, 1], 0.5).ok).toBe(false);
    expect(mesh.project([-1, 0, 1], 1).ok).toBe(true);
  });
  it('samples sloped ground vertically while preserving XZ and explicit work budgets', () => {
    const mesh = createNavigationMesh({
      ...asset,
      vertices: asset.vertices.map((v, i) =>
        i % 3 === 1 ? (asset.vertices[i - 1] as number) / 4 : v,
      ),
    }).unwrap();
    expect(mesh.ground([2, 0.4, 2], 0.2).unwrap().point).toEqual([2, 0.5, 2]);
    expect(mesh.project([2, 0.4, 2], 0.2).unwrap().point[0]).not.toBe(2);
    expect(mesh.ground([-1, 0, 2], 1).ok).toBe(false);
    const limited = mesh.project([4, 0, 2], 4, 1);
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.code).toBe('navigation-projection-limit');
    expect(createNavigationMesh({ ...asset, polygons: [null] as never }).ok).toBe(false);
  });
  it('retains projection results across later vertex, edge and ground queries', () => {
    const mesh = createNavigationMesh(asset).unwrap();
    const first = mesh.project([1, 2, 1], 3).unwrap().point;
    expect(first).toEqual([1, 0, 1]);
    expect(mesh.project([-1, 1, -1], 3).unwrap().point).toEqual([0, 0, 0]);
    expect(mesh.project([-1, 1, 2], 3).unwrap().point).toEqual([0, 0, 2]);
    expect(mesh.project([9, 1, 4.5], 3).unwrap().point).toEqual([8, 0, 4]);
    expect(mesh.ground([7, 0.2, 3], 0.5).unwrap().point).toEqual([7, 0, 3]);
    expect(first).toEqual([1, 0, 1]);
    const tilted = createNavigationMesh({
      ...asset,
      vertices: asset.vertices.map((v, i) =>
        i % 3 === 1 ? (asset.vertices[i - 1] as number) / 4 : v,
      ),
    })
      .unwrap()
      .project([2, 0.4, 2], 0.2)
      .unwrap().point;
    expect(tilted[0]).toBeCloseTo((16 * 2 + 4 * 0.4) / 17, 12);
    expect(tilted[1]).toBeCloseTo(tilted[0] / 4, 12);
    expect(tilted[2]).toBe(2);
  });
  it('keeps unreachable, resource limit and invalid data separate from success', () => {
    const mesh = createNavigationMesh(asset).unwrap();
    expect(mesh.findPath([1, 0, 1], [7, 0, 3], { maxProjection: 0.1, maxVisited: 1 }).ok).toBe(
      false,
    );
    expect(createNavigationMesh({ ...asset, polygons: [[0, 1, 999]] }).ok).toBe(false);
    expect(mesh.project([NaN, 0, 0], 1).ok).toBe(false);
    expect(mesh.project([0, 0, 0], Infinity).ok).toBe(false);
  });
});
