// @forgeax/engine-assets-runtime -- withMeshAabb / computeAABB coverage
// (fix issue #709: assets-runtime src entered the coverage pool via the
// package's own tests importing `../` relative paths -> src; before this the
// module was only exercised through the compiled dist by runtime-project
// tests, which are excluded from the coverage denominator).

import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { withMeshAabb } from '../aabb';

const EMPTY_BOX = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

function meshWith(position: Float32Array | ArrayBuffer | undefined): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(0),
    attributes: position === undefined ? {} : { position },
    submeshes: [
      { indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'Default' }],
  } as MeshAsset;
}

describe('withMeshAabb', () => {
  it('computes [min, max] over every (x, y, z) triple of the position attribute', () => {
    const position = Float32Array.of(
      -1,
      -2,
      -3, //
      4,
      5,
      6, //
      0,
      0,
      0,
    );
    const out = withMeshAabb(meshWith(position));
    expect(Array.from(out.aabb as Float32Array)).toEqual([-1, -2, -3, 4, 5, 6]);
  });

  it('handles a single-vertex mesh (min === max === that vertex)', () => {
    const out = withMeshAabb(meshWith(Float32Array.of(7, 8, 9)));
    expect(Array.from(out.aabb as Float32Array)).toEqual([7, 8, 9, 7, 8, 9]);
  });

  it('re-wraps an ArrayBuffer position buffer as Float32Array', () => {
    const buf = Float32Array.of(1, 1, 1, 2, 3, 4).buffer;
    const out = withMeshAabb(meshWith(buf));
    expect(Array.from(out.aabb as Float32Array)).toEqual([1, 1, 1, 2, 3, 4]);
  });

  it('returns the inverted-infinity empty box when position is absent', () => {
    const out = withMeshAabb(meshWith(undefined));
    expect(Array.from(out.aabb as Float32Array)).toEqual(EMPTY_BOX);
  });

  it('returns the empty box when position has fewer than 3 floats', () => {
    const out = withMeshAabb(meshWith(Float32Array.of(1, 2)));
    expect(Array.from(out.aabb as Float32Array)).toEqual(EMPTY_BOX);
  });

  it('returns the empty box for a Uint16Array position (treated as absent)', () => {
    const mesh = {
      kind: 'mesh',
      vertices: new Float32Array(0),
      attributes: { position: Uint16Array.of(1, 2, 3) },
      submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list' }],
    } as unknown as MeshAsset;
    const out = withMeshAabb(mesh);
    expect(Array.from(out.aabb as Float32Array)).toEqual(EMPTY_BOX);
  });

  it('preserves a packed AABB when the binary path omits position attributes', () => {
    const mesh = {
      ...meshWith(undefined),
      aabb: Float32Array.of(-2, 0, -1, 3, 4, 5),
    };
    const out = withMeshAabb(mesh);
    expect(Array.from(out.aabb as Float32Array)).toEqual([-2, 0, -1, 3, 4, 5]);
  });

  it('mutates the mesh in place when it is extensible (returns same reference)', () => {
    const mesh = meshWith(Float32Array.of(0, 0, 0, 1, 1, 1));
    const out = withMeshAabb(mesh);
    expect(out).toBe(mesh);
    expect(mesh.aabb).toBeInstanceOf(Float32Array);
  });

  it('returns a shallow copy carrying the aabb when the mesh is frozen', () => {
    const mesh = Object.freeze(meshWith(Float32Array.of(0, 0, 0, 2, 2, 2)));
    const out = withMeshAabb(mesh);
    expect(out).not.toBe(mesh);
    expect(Array.from(out.aabb as Float32Array)).toEqual([0, 0, 0, 2, 2, 2]);
    expect(mesh.aabb).toBeUndefined();
  });
});

it.each([false, true])('preserves a finite deformation envelope (frozen=%s)', (frozen) => {
  const authored = Float32Array.of(-5, -5, -5, 5, 5, 5);
  const input = { ...meshWith(Float32Array.of(0, 0, 0, 1, 1, 1)), aabb: authored };
  const out = withMeshAabb(frozen ? Object.freeze(input) : input);
  expect([...(out.aabb ?? [])]).toEqual([...authored]);
  const narrow = withMeshAabb({ ...input, aabb: Float32Array.of(0, 0, 0, 0, 0, 0) });
  expect([...(narrow.aabb ?? [])]).toEqual([0, 0, 0, 1, 1, 1]);
  expect([...authored]).toEqual([-5, -5, -5, 5, 5, 5]);
});
