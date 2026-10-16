import { assert, expect, it } from 'vitest';
import { meshIrToMeshAsset } from '../bridge';
import type { GltfMeshIr } from '../parse-gltf';

it('repairs parallel source tangents through the mesh producer while preserving valid frames and input', () => {
  const mesh: GltfMeshIr = {
    positions: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1]),
    normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
    tangents: new Float32Array([1, 0, 0, 1, 0, 1, 0, -1, 0, 0, 1, 1]),
    texcoord0: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint16Array([0, 1, 2]),
    meshIndex: 0,
    materialIndex: 0,
  };
  assert(mesh.tangents);
  const cooked = meshIrToMeshAsset([mesh]).unwrap();
  const tangent = cooked.attributes?.tangent;
  assert(tangent instanceof Float32Array);
  expect(tangent?.[0]).toBe(0);
  expect(Math.hypot(tangent?.[1] ?? 0, tangent?.[2] ?? 0)).toBeCloseTo(1);
  expect(Array.from(tangent?.slice(4) ?? [])).toEqual(Array.from(mesh.tangents.slice(4)));
  expect(mesh.tangents[0]).toBe(1);
});

it('uses a finite normal-plane basis for an undefined source frame with collapsed UVs', () => {
  const mesh: GltfMeshIr = {
    positions: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1]),
    normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
    tangents: new Float32Array([1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1]),
    texcoord0: new Float32Array(6),
    indices: new Uint16Array([0, 1, 2]),
    meshIndex: 0,
    materialIndex: 0,
  };
  const t = meshIrToMeshAsset([mesh]).unwrap().attributes?.tangent;
  assert(t instanceof Float32Array);
  for (let i = 0; i < 3; i++) {
    expect(t[i * 4]).toBeCloseTo(0);
    expect(Math.hypot(t[i * 4 + 1] ?? 0, t[i * 4 + 2] ?? 0)).toBeCloseTo(1);
    expect(t[i * 4 + 3]).toBe(-1);
  }
  expect(meshIrToMeshAsset([{ ...mesh, normals: new Float32Array(9) }]).ok).toBe(false);
});

it('retains the deterministic plane direction and source handedness for a non-axis normal', () => {
  const normal = [2, -3, 4];
  const mesh: GltfMeshIr = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([...normal, ...normal, ...normal]),
    tangents: new Float32Array([...normal, -1, ...normal, -1, ...normal, -1]),
    texcoord0: new Float32Array(6),
    indices: new Uint16Array([0, 1, 2]),
    meshIndex: 0,
    materialIndex: 0,
  };
  const tangent = meshIrToMeshAsset([mesh]).unwrap().attributes.tangent;
  assert(tangent instanceof Float32Array);
  for (let i = 0; i < 3; i++) {
    expect(Array.from(tangent.subarray(i * 4, i * 4 + 4))).toEqual(
      Array.from(new Float32Array([0, -0.8, -0.6, -1])),
    );
  }
});
