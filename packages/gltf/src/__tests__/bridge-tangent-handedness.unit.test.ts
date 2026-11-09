import { assert, expect, it } from 'vitest';
import { meshIrToMeshAsset } from '../bridge';
import type { GltfMeshIr } from '../parse-gltf';

// glTF 2.0 (Specification.adoc, "Meshes"): when TANGENT is absent and the material has
// a normal texture, tangents come from MikkTSpace; bitangent = cross(N, T.xyz) * T.w.
// glTF UVs have a top-left origin and glTF normal maps are green-up, so the bitangent
// must point toward the image top, i.e. toward decreasing glTF v.

/** Unit quad in the XY plane facing +Z; image top (v=0) is world +Y unless mirrored. */
function quad(uvs: number[]): GltfMeshIr {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    texcoord0: new Float32Array(uvs),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    meshIndex: 0,
    materialIndex: 0,
  };
}

function bitangents(mesh: GltfMeshIr): number[][] {
  const tangent = meshIrToMeshAsset([mesh]).unwrap().attributes?.tangent;
  assert(tangent instanceof Float32Array);
  return [0, 1, 2, 3].map((i) => {
    const [tx = 0, ty = 0, tz = 0, w = 0] = tangent.subarray(i * 4, i * 4 + 4);
    const [nx = 0, ny = 0, nz = 0] = mesh.normals?.subarray(i * 3, i * 3 + 3) ?? [];
    return [(ny * tz - nz * ty) * w, (nz * tx - nx * tz) * w, (nx * ty - ny * tx) * w];
  });
}

it('generated tangents give a green-up bitangent for glTF top-left UVs', () => {
  // v = 1 at world y = 0 (image bottom), v = 0 at world y = 1 (image top).
  const mesh = quad([0, 1, 1, 1, 1, 0, 0, 0]);
  for (const b of bitangents(mesh)) {
    expect(b[0]).toBeCloseTo(0);
    expect(b[1]).toBeCloseTo(1); // toward the image top, as an authored MikkTSpace TANGENT gives
    expect(b[2]).toBeCloseTo(0);
  }
});

it('generated tangents flip handedness with mirrored V (the file-authored sign convention)', () => {
  // Image top is world -Y: green-up now points to world -Y.
  const mesh = quad([0, 0, 1, 0, 1, 1, 0, 1]);
  for (const b of bitangents(mesh)) expect(b[1]).toBeCloseTo(-1);
});
