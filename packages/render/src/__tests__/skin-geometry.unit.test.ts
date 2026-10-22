import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { skinGeometryEnvelopes } from '../scene/skin-geometry';

function mesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(0),
    submeshes: [],
    materialSlots: [],
    attributes: {
      position: new Float32Array([-2, 1, 0, 3, -1, 2]),
      skinIndex: new Uint16Array([7, 9, 65535, 0, 7, 9, 0, 0]),
      skinWeight: new Float32Array([0.25, 0.75, 0, 0, 0.5, 1.5, 0, 0]),
    },
  };
}

it('derives one sparse Mesh envelope without retaining vertices or allocating absent joints', () => {
  const source = mesh();
  const packed = skinGeometryEnvelopes(source);
  expect(packed).toEqual(
    new Float32Array([1, 2, 65536, 2, -2, -1, 0, 7, 3, 1, 2, 0, -2, -1, 0, 9, 3, 1, 2, 0]),
  );
  (source.attributes.position as Float32Array).fill(99);
  (source.attributes.skinWeight as Float32Array).fill(0);
  expect(packed?.[4]).toBe(-2);
  expect(packed?.[8]).toBe(3);
  expect(skinGeometryEnvelopes(source)).toBeUndefined();
});

it('encloses exact positive weight sums with outward float32 rounding', () => {
  const source = mesh();
  const weights = source.attributes.skinWeight as Float32Array;
  weights.set([1, 2 ** -24, 0, 0, 1, 2 ** -25, 0, 0]);
  const packed = skinGeometryEnvelopes(source);
  expect(packed).toBeDefined();
  expect(packed?.[0]).toBeLessThanOrEqual(1 + 2 ** -25);
  expect(packed?.[1]).toBeGreaterThanOrEqual(1 + 2 ** -24);
  weights.fill(0);
  weights[0] = 2 ** -149;
  weights[4] = 2 ** -149;
  expect(skinGeometryEnvelopes(source)).toBeUndefined();
  weights[0] = 2 ** -126;
  weights[4] = 2 ** -126;
  expect(skinGeometryEnvelopes(source)?.[0]).toBe(2 ** -126);
  expect(skinGeometryEnvelopes(source)?.[1]).toBe(2 ** -126);
});

it.each([
  NaN,
  Infinity,
  -1,
])('leaves unsupported weight %s uncullable instead of shrinking its bounds', (value) => {
  const source = mesh();
  (source.attributes.skinWeight as Float32Array)[0] = value;
  expect(skinGeometryEnvelopes(source)).toBeUndefined();
});

it('rejects malformed, zero-sum, nonfinite and unrepresentable envelopes', () => {
  const source = mesh();
  (source.attributes.position as Float32Array)[0] = Infinity;
  expect(skinGeometryEnvelopes(source)).toBeUndefined();
  (source.attributes.position as Float32Array)[0] = -2;
  (source.attributes.skinWeight as Float32Array).fill(0);
  expect(skinGeometryEnvelopes(source)).toBeUndefined();
  (source.attributes.skinWeight as Float32Array).fill(3e38);
  expect(skinGeometryEnvelopes(source)).toBeUndefined();
  source.attributes.skinWeight = new Float32Array(1);
  expect(skinGeometryEnvelopes(source)).toBeUndefined();
});

it('does not grant base-position culling to a Mesh with morph targets', () => {
  const source = mesh();
  expect(
    skinGeometryEnvelopes({
      ...source,
      morphTargets: [{ position: new Float32Array([100, 0, 0, 100, 0, 0]) }],
    }),
  ).toBeUndefined();
});

it('keeps joint-sized envelopes for large skinned Meshes without a vertex-sized budget', () => {
  const vertices = 60_000;
  const position = new Float32Array(vertices * 3);
  const skinIndex = new Uint16Array(vertices * 4);
  const skinWeight = new Float32Array(vertices * 4);
  for (let vertex = 0; vertex < vertices; vertex++) {
    position.set([Math.sin(vertex), Math.cos(vertex * 0.7), (vertex % 97) * 0.01], vertex * 3);
    skinIndex.set([0, 1, 0, 0], vertex * 4);
    skinWeight.set([0.5, 0.5, 0, 0], vertex * 4);
  }
  const meshes = Array.from({ length: 4 }, () => ({
    ...mesh(),
    attributes: { position, skinIndex, skinWeight },
  }));
  for (const source of meshes) {
    const packed = skinGeometryEnvelopes(source);
    expect(packed?.length).toBe(4 + 2 * 8);
    expect(packed?.[3]).toBe(2);
  }
});
