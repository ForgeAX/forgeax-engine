// @forgeax/engine-geometry unit tests.
//
// Extracted from the runtime integration mega-test (feat-20260704-runtime-tier1
// -decomposition, w6): the geometry-pure describe blocks (procedural factories,
// computeTangentVec4 helper, winding, UV orientation, VertexAttributeMap
// narrowing, deriveVertexBufferLayout) that depend only on ecs + types +
// @forgeax/engine-geometry itself. Assertion logic is copied verbatim (AC-09);
// only the import sources changed (leaf package must not import runtime -- D-2).

import {
  computeTangentVec4,
  createBoxGeometry,
  createCapsuleGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createSphereGeometry,
  createTorusGeometry,
  deriveVertexBufferLayout,
  meshFromInterleaved,
  PROCEDURAL_FLOATS_PER_VERTEX,
} from '@forgeax/engine-geometry';
import type { MeshAsset, Result, VertexAttributeMap } from '@forgeax/engine-types';
import { AssetError } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

{
  // --- from geometry-tangent.test.ts ---
  // Procedural geometry tangent emit tests (M4 / w19).
  //
  // Covers feat-20260518-pbr-direct-lighting-mvp AC-10:
  //   1. The `computeTangentVec4` helper (geometry/tangent.ts) implements the
  //      path A formula (UV-derivative + face-area-weighted average +
  //      Gram-Schmidt re-orthogonalisation + handedness sign) and outputs
  //      vec4 per vertex (.xyz tangent, .w in {+1, -1}).
  //   2. The 6 procedural geometry factories (box / cone / cylinder / plane
  //      / sphere / torus) emit `tangent` in their `attributes` map with
  //      `length === vertexCount * 4` and per-vertex assertions:
  //        (a) tangent attribute exists and is a Float32Array view of length
  //            vertexCount * 4
  //        (b) tangent.xyz numerical assertion at known-vertex positions
  //            (path A predicted value, eps <= 1e-4)
  //        (c) handedness .w in {+1, -1} (path A sign(det(deltaUV)))
  //        (d) dot(T.xyz, N) eps <= 1e-3 after Gram-Schmidt re-ortho
  //
  // Plan-strategy anchors: section 2 D-2 (path A); D-7 (single-file helper);
  // D-10 (procedural 12 floats vs BUILTIN 6 floats). Requirements anchor:
  // AC-10. Risk anchor: R-4 (path A vec4 forward-compatible with future
  // MikkTSpace baker via `B = cross(N, T.xyz) * T.w`).

  function unwrap(r: { ok: true; value: MeshAsset } | { ok: false; error: AssetError }): MeshAsset {
    if (!r.ok) throw new Error(`unexpected err: ${r.error.code}`);
    return r.value;
  }

  function asF32(v: ArrayBuffer | Float32Array | Uint16Array | undefined): Float32Array {
    if (v === undefined) throw new Error('attribute missing');
    if (v instanceof Float32Array) return v;
    if (v instanceof Uint16Array) throw new Error('expected Float32Array, got Uint16Array');
    return new Float32Array(v);
  }

  function readVec3(arr: Float32Array, vertexIdx: number): [number, number, number] {
    const b = vertexIdx * 3;
    return [arr[b] ?? 0, arr[b + 1] ?? 0, arr[b + 2] ?? 0];
  }

  function readVec4(arr: Float32Array, vertexIdx: number): [number, number, number, number] {
    const b = vertexIdx * 4;
    return [arr[b] ?? 0, arr[b + 1] ?? 0, arr[b + 2] ?? 0, arr[b + 3] ?? 0];
  }

  function unwrapTangent(r: Result<Float32Array, AssetError>): Float32Array {
    if (!r.ok) throw new Error(`unexpected tangent error: ${r.error.code}`);
    return r.value;
  }

  function dot3(a: [number, number, number], b: [number, number, number]): number {
    return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  }

  function len3(a: [number, number, number]): number {
    return Math.sqrt(dot3(a, a));
  }

  describe('computeTangentVec4 helper (M4 / w20)', () => {
    it('malformed normal cardinality returns a structured failure instead of throwing (M72 red gate)', () => {
      const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const malformedNormals = new Float32Array([0, 0, 1, 0, 0, 1]);
      const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
      const indices = new Uint32Array([0, 1, 2]);

      expect(() => computeTangentVec4(positions, malformedNormals, uvs, indices)).not.toThrow();
      const result = computeTangentVec4(positions, malformedNormals, uvs, indices);
      expect(result.ok).toBe(false);
    });

    it('preflights every public tangent topology boundary with the existing AssetError', () => {
      const validPositions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const validNormals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
      const validUvs = new Float32Array([0, 0, 1, 0, 0, 1]);
      const cases = [
        {
          field: 'positions',
          positions: new Float32Array(8),
          normals: validNormals,
          uvs: validUvs,
          indices: new Uint32Array([0, 1, 2]),
        },
        {
          field: 'normals',
          positions: validPositions,
          normals: new Float32Array(6),
          uvs: validUvs,
          indices: new Uint32Array([0, 1, 2]),
        },
        {
          field: 'uvs',
          positions: validPositions,
          normals: validNormals,
          uvs: new Float32Array(4),
          indices: new Uint32Array([0, 1, 2]),
        },
        {
          field: 'positions',
          positions: new Float32Array([0, 0, 0, 1, 0, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1]),
          uvs: new Float32Array([0, 0, 1, 0]),
          indices: undefined,
        },
        {
          field: 'indices',
          positions: validPositions,
          normals: validNormals,
          uvs: validUvs,
          indices: new Uint32Array([0, 1]),
        },
        {
          field: 'indices',
          positions: validPositions,
          normals: validNormals,
          uvs: validUvs,
          indices: new Uint32Array([0, 1, 3]),
        },
      ];

      for (const testCase of cases) {
        const result = computeTangentVec4(
          testCase.positions,
          testCase.normals,
          testCase.uvs,
          testCase.indices,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(AssetError);
          expect(result.error.code).toBe('asset-parse-failed');
          expect(result.error.detail).toMatchObject({ field: testCase.field });
        }
      }
    });

    it('corrected arrays recover on the next call with the established vec4 output', () => {
      const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const malformedNormals = new Float32Array([0, 0, 1, 0, 0, 1]);
      const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
      const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
      const indices = new Uint32Array([0, 1, 2]);

      const failed = computeTangentVec4(positions, malformedNormals, uvs, indices);
      expect(failed.ok).toBe(false);
      const recovered = computeTangentVec4(positions, normals, uvs, indices);
      expect(recovered.ok).toBe(true);
      if (recovered.ok) {
        expect([...recovered.value]).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
      }
    });

    it('preflights interleaved vertex and index topology before allocation', () => {
      const malformedVertices = meshFromInterleaved(
        new Float32Array(9),
        new Uint32Array([0, 1, 2]),
      );
      expect(malformedVertices.ok).toBe(false);
      if (!malformedVertices.ok) {
        expect(malformedVertices.error).toBeInstanceOf(AssetError);
        expect(malformedVertices.error.code).toBe('asset-parse-failed');
        expect(malformedVertices.error.detail).toMatchObject({ field: 'vertices' });
      }

      const validInterleaved = new Float32Array(3 * 8);
      const malformedIndices = meshFromInterleaved(validInterleaved, new Uint32Array([0, 1, 3]));
      expect(malformedIndices.ok).toBe(false);
      if (!malformedIndices.ok) {
        expect(malformedIndices.error).toBeInstanceOf(AssetError);
        expect(malformedIndices.error.code).toBe('asset-parse-failed');
        expect(malformedIndices.error.detail).toMatchObject({ field: 'indices' });
      }
    });

    it('single UV-aligned triangle yields tangent (1,0,0,1) (normal)', () => {
      // Triangle on the XY plane with +Z normal; UV maps so that u runs
      // along +X (E2), v runs along +Y (E1). Path A predicts tangent (1,0,0)
      // and handedness +1.
      const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
      const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
      const indices = new Uint32Array([0, 1, 2]);
      const out = unwrapTangent(computeTangentVec4(positions, normals, uvs, indices));
      expect(out.length).toBe(3 * 4);
      for (let i = 0; i < 3; i++) {
        const [tx, ty, tz, tw] = readVec4(out, i);
        expect(tx).toBeCloseTo(1, 4);
        expect(ty).toBeCloseTo(0, 4);
        expect(tz).toBeCloseTo(0, 4);
        expect(tw).toBe(1);
      }
    });

    it('flipped UV winding yields handedness -1 (boundary)', () => {
      // Same triangle but with U winding reversed -> det(deltaUV) < 0.
      const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
      // Swap u for vertices 1 and 2: u=0 at v1, u=1 at v2 -> deltaU's flip sign
      const uvs = new Float32Array([1, 0, 0, 0, 1, 1]);
      const indices = new Uint32Array([0, 1, 2]);
      const out = unwrapTangent(computeTangentVec4(positions, normals, uvs, indices));
      for (let i = 0; i < 3; i++) {
        const [, , , tw] = readVec4(out, i);
        expect(Math.abs(tw)).toBe(1);
        expect(tw).toBe(-1);
      }
    });

    it('Gram-Schmidt re-ortho keeps tangent perpendicular to normal (boundary)', () => {
      // Construct a triangle where the raw face tangent is not perpendicular
      // to the supplied vertex normal (normal tilted off +Z). After
      // Gram-Schmidt the output tangent must satisfy dot(T, N) ~ 0.
      const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      // Tilt all three normals to (1,0,1)/sqrt(2) so Gram-Schmidt has work.
      const k = 1 / Math.sqrt(2);
      const normals = new Float32Array([k, 0, k, k, 0, k, k, 0, k]);
      const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
      const indices = new Uint32Array([0, 1, 2]);
      const out = unwrapTangent(computeTangentVec4(positions, normals, uvs, indices));
      for (let i = 0; i < 3; i++) {
        const t = readVec3(out.subarray(i * 4, i * 4 + 3), 0);
        const n = readVec3(normals, i);
        expect(Math.abs(dot3(t, n))).toBeLessThan(1e-3);
        expect(len3(t)).toBeCloseTo(1, 4);
      }
    });

    it('non-indexed input is supported (degenerate-input shape)', () => {
      // indices undefined -> assume sequential (0,1,2,3,4,5,...)
      const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
      const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
      const out = unwrapTangent(computeTangentVec4(positions, normals, uvs));
      expect(out.length).toBe(3 * 4);
      const [tx, , , tw] = readVec4(out, 0);
      expect(tx).toBeCloseTo(1, 4);
      expect(tw).toBe(1);
    });
  });

  describe('createPlaneGeometry tangent emit (M4 / w21)', () => {
    // Plane lies on XY with +Z normal. Under the WebGPU top-left UV
    // convention (uv.v = iy/hs), vertex 0 (iy=0) carries uv=(0,0).
    // The representative triangle (0,2,1) has uv walk (0,0)->(0,1)->(1,0):
    // dU1=0 dV1=1 dU2=1 dV2=0 => det=-1 => handedness w=-1.
    // Path A thus predicts tangent (1,0,0,-1) at every vertex.
    it('emits tangent attribute with length === vertexCount * 4 (normal)', () => {
      const m = unwrap(createPlaneGeometry(2, 2));
      const tangent = asF32(m.attributes.tangent);
      const position = asF32(m.attributes.position);
      const vertexCount = position.length / 3;
      expect(tangent.length).toBe(vertexCount * 4);
    });

    it('plane v0 tangent equals (1,0,0,-1) (boundary)', () => {
      const m = unwrap(createPlaneGeometry(2, 2));
      const tangent = asF32(m.attributes.tangent);
      const [tx, ty, tz, tw] = readVec4(tangent, 0);
      expect(tx).toBeCloseTo(1, 4);
      expect(ty).toBeCloseTo(0, 4);
      expect(tz).toBeCloseTo(0, 4);
      expect(tw).toBe(-1);
    });

    it('every vertex tangent is perpendicular to its normal (boundary)', () => {
      const m = unwrap(createPlaneGeometry(2, 2, 2, 2));
      const tangent = asF32(m.attributes.tangent);
      const normal = asF32(m.attributes.normal);
      const vertexCount = normal.length / 3;
      for (let i = 0; i < vertexCount; i++) {
        const t = readVec3(tangent.subarray(i * 4, i * 4 + 3), 0);
        const n = readVec3(normal, i);
        expect(Math.abs(dot3(t, n))).toBeLessThan(1e-3);
        expect(Math.abs(tangent[i * 4 + 3] ?? 0)).toBe(1);
      }
    });
  });

  describe('createBoxGeometry tangent emit (M4 / w21)', () => {
    it('emits tangent attribute of length vertexCount * 4 (normal)', () => {
      const m = unwrap(createBoxGeometry(1, 1, 1));
      const tangent = asF32(m.attributes.tangent);
      const position = asF32(m.attributes.position);
      expect(tangent.length).toBe((position.length / 3) * 4);
    });

    it('every vertex tangent is unit length and perpendicular to normal (boundary)', () => {
      const m = unwrap(createBoxGeometry(2, 3, 4));
      const tangent = asF32(m.attributes.tangent);
      const normal = asF32(m.attributes.normal);
      const vertexCount = normal.length / 3;
      for (let i = 0; i < vertexCount; i++) {
        const t = readVec3(tangent.subarray(i * 4, i * 4 + 3), 0);
        const n = readVec3(normal, i);
        expect(len3(t)).toBeCloseTo(1, 3);
        expect(Math.abs(dot3(t, n))).toBeLessThan(1e-3);
        expect(Math.abs(tangent[i * 4 + 3] ?? 0)).toBe(1);
      }
    });

    it('+Z face vertex 0 tangent equals (1,0,0,+1) (boundary)', () => {
      // Box face order: [+X, -X, +Y, -Y, +Z, -Z]. Each face has 4 vertices
      // for ws=hs=1. The +Z face starts at vertex 4*4=16; its first vertex
      // (j=0,i=0) is at (-hw,-hh,hd) with normal (0,0,+1).
      //
      // Under the WebGPU top-left UV convention (uv.v = j/vSegs), vertex 16
      // carries uv=(0,0). The CCW-from-outside triangle (a,b,d) = (16,17,19)
      // walks BL(0,0) -> BR(1,0) -> TR(1,1): dU1=1 dV1=0 dU2=1 dV2=1 =>
      // det=+1 => handedness +1 (T=+X, B=+Y, N=+Z; T x B = +Z = +N). Path A
      // predicts (1,0,0,+1).
      const m = unwrap(createBoxGeometry(2, 2, 2));
      const tangent = asF32(m.attributes.tangent);
      const v = 16; // start of +Z face
      const [tx, ty, tz, tw] = readVec4(tangent, v);
      expect(tx).toBeCloseTo(1, 4);
      expect(ty).toBeCloseTo(0, 4);
      expect(tz).toBeCloseTo(0, 4);
      expect(tw).toBe(1);
    });
  });

  describe('createSphereGeometry tangent emit (M4 / w21)', () => {
    it('emits tangent attribute of length vertexCount * 4 (normal)', () => {
      const m = unwrap(createSphereGeometry(1));
      const tangent = asF32(m.attributes.tangent);
      const position = asF32(m.attributes.position);
      expect(tangent.length).toBe((position.length / 3) * 4);
    });

    it('equator (mid-latitude) vertices have unit tangent perpendicular to normal (boundary)', () => {
      const m = unwrap(createSphereGeometry(1, 16, 12));
      const tangent = asF32(m.attributes.tangent);
      const normal = asF32(m.attributes.normal);
      // Equator row in sphere.ts: iy = hs/2 = 6, ix scans 0..16. Stride
      // = ws + 1 = 17. Skip ix=0 (seam) and ix=ws (seam wrap-around).
      const stride = 17;
      const equatorRow = 6;
      for (let ix = 1; ix < 16; ix++) {
        const v = equatorRow * stride + ix;
        const t = readVec3(tangent.subarray(v * 4, v * 4 + 3), 0);
        const n = readVec3(normal, v);
        expect(len3(t)).toBeCloseTo(1, 2);
        expect(Math.abs(dot3(t, n))).toBeLessThan(5e-3);
        expect(Math.abs(tangent[v * 4 + 3] ?? 0)).toBe(1);
      }
    });
  });

  describe('createCylinderGeometry tangent emit (M4 / w21)', () => {
    it('emits tangent attribute of length vertexCount * 4 (normal)', () => {
      const m = unwrap(createCylinderGeometry(1, 1, 2));
      const tangent = asF32(m.attributes.tangent);
      const position = asF32(m.attributes.position);
      expect(tangent.length).toBe((position.length / 3) * 4);
    });

    it('every side vertex tangent is unit length and perpendicular to normal (boundary)', () => {
      const m = unwrap(createCylinderGeometry(1, 1, 2, 16, 1));
      const tangent = asF32(m.attributes.tangent);
      const normal = asF32(m.attributes.normal);
      const sideVertexCount = (16 + 1) * (1 + 1);
      for (let v = 1; v < sideVertexCount - 1; v++) {
        const t = readVec3(tangent.subarray(v * 4, v * 4 + 3), 0);
        const n = readVec3(normal, v);
        expect(len3(t)).toBeCloseTo(1, 2);
        expect(Math.abs(dot3(t, n))).toBeLessThan(5e-3);
        expect(Math.abs(tangent[v * 4 + 3] ?? 0)).toBe(1);
      }
    });
  });

  describe('createConeGeometry tangent emit (M4 / w21)', () => {
    it('emits tangent attribute of length vertexCount * 4 (normal)', () => {
      const m = unwrap(createConeGeometry(1, 2));
      const tangent = asF32(m.attributes.tangent);
      const position = asF32(m.attributes.position);
      expect(tangent.length).toBe((position.length / 3) * 4);
    });

    it('cone bottom-cap centre vertex has unit tangent (boundary)', () => {
      // Cone delegates to cylinder with radiusTop=0; bottom-cap exists.
      // Side vertices come first; bottom-cap centre is the first vertex
      // of the cap section. Verify tangent is unit length and .w in {+1,-1}.
      const m = unwrap(createConeGeometry(1, 2, 16, 1));
      const tangent = asF32(m.attributes.tangent);
      const normal = asF32(m.attributes.normal);
      const sideVertexCount = (16 + 1) * (1 + 1);
      // Sample a side mid-vertex (skip the seam at ix=0).
      const v = sideVertexCount / 2 + 1;
      const t = readVec3(tangent.subarray(v * 4, v * 4 + 3), 0);
      const n = readVec3(normal, v);
      expect(len3(t)).toBeCloseTo(1, 2);
      expect(Math.abs(dot3(t, n))).toBeLessThan(5e-3);
      expect(Math.abs(tangent[v * 4 + 3] ?? 0)).toBe(1);
    });
  });

  describe('createCapsuleGeometry tangent emit', () => {
    it('emits tangent attribute of length vertexCount * 4 (normal)', () => {
      const m = unwrap(createCapsuleGeometry(0.5, 1));
      const tangent = asF32(m.attributes.tangent);
      const position = asF32(m.attributes.position);
      expect(tangent.length).toBe((position.length / 3) * 4);
    });

    it('sampled vertices have unit tangent perpendicular to normal (boundary)', () => {
      const m = unwrap(createCapsuleGeometry(0.5, 1, 6, 16));
      const tangent = asF32(m.attributes.tangent);
      const normal = asF32(m.attributes.normal);
      const vertexCount = normal.length / 3;
      // Skip pole + seam vertices (row 0 north pole, ix=0 seam) by striding
      // from an interior offset.
      let sampled = 0;
      for (let v = 20; v < vertexCount - 20; v += 5) {
        const t = readVec3(tangent.subarray(v * 4, v * 4 + 3), 0);
        const n = readVec3(normal, v);
        expect(len3(t)).toBeCloseTo(1, 2);
        expect(Math.abs(dot3(t, n))).toBeLessThan(5e-3);
        expect(Math.abs(tangent[v * 4 + 3] ?? 0)).toBe(1);
        sampled++;
      }
      expect(sampled).toBeGreaterThan(0);
    });
  });

  describe('createTorusGeometry tangent emit (M4 / w21)', () => {
    it('emits tangent attribute of length vertexCount * 4 (normal)', () => {
      const m = unwrap(createTorusGeometry(1, 0.4));
      const tangent = asF32(m.attributes.tangent);
      const position = asF32(m.attributes.position);
      expect(tangent.length).toBe((position.length / 3) * 4);
    });

    it('every vertex tangent is unit length and perpendicular to normal (boundary)', () => {
      const m = unwrap(createTorusGeometry(2, 0.5, 8, 24));
      const tangent = asF32(m.attributes.tangent);
      const normal = asF32(m.attributes.normal);
      const vertexCount = normal.length / 3;
      // Sample a strided subset; skip seam vertices (j=0 and i=0/i=ts).
      let sampled = 0;
      for (let v = 26; v < vertexCount - 26; v += 7) {
        const t = readVec3(tangent.subarray(v * 4, v * 4 + 3), 0);
        const n = readVec3(normal, v);
        expect(len3(t)).toBeCloseTo(1, 2);
        expect(Math.abs(dot3(t, n))).toBeLessThan(5e-3);
        expect(Math.abs(tangent[v * 4 + 3] ?? 0)).toBe(1);
        sampled++;
      }
      expect(sampled).toBeGreaterThan(0);
    });
  });
}

{
  // --- from geometry-winding.test.ts ---
  // Procedural geometry winding-faces-outward invariant.
  //
  // bug-20260519: `createBoxGeometry` emitted CW-from-outside triangles
  // while `createPlaneGeometry` / `createSphereGeometry` emitted CCW.
  // Combined with the unlit / standard pipelines'
  // `frontFace: 'ccw' + cullMode: 'back'` setup, the box geometry's front
  // face was culled and the user saw the cube's back / left / right faces
  // from the inside instead. This test pins the invariant: every triangle
  // of every procedural factory must wind CCW when viewed from outside the
  // geometry.
  //
  // Method (works for every closed and open shape):
  //   - Read each triangle's per-vertex normals from the factory output;
  //     average them to get the surface normal at the triangle's centroid.
  //   - Compute the geometric normal `(b - a) x (c - a)`.
  //   - The triangle is CCW from outside iff the geometric normal agrees
  //     with the per-vertex normal direction (`dot > 0`).
  //
  // Per-vertex normals are authored by every factory in this codebase as
  // the surface outward normal (sphere: position; box: face normal; torus:
  // position - tube center; plane: +Z; etc.). They are the right "outward"
  // reference because the test's purpose is exactly to assert that the
  // triangle winding agrees with the authored normal direction — anything
  // else (origin-relative, factory-specific) only adds approximation noise.

  function unwrap(r: { ok: true; value: MeshAsset } | { ok: false; error: AssetError }): MeshAsset {
    if (!r.ok) throw new Error(`unexpected err: ${r.error.code}`);
    return r.value;
  }

  interface TriangleVerdict {
    readonly triangleIndex: number;
    readonly indices: readonly [number, number, number];
    readonly dot: number;
  }

  type V3 = readonly [number, number, number];

  function readPos(vertices: Float32Array, idx: number): V3 {
    const base = idx * PROCEDURAL_FLOATS_PER_VERTEX;
    return [vertices[base] ?? 0, vertices[base + 1] ?? 0, vertices[base + 2] ?? 0];
  }

  function readNormal(vertices: Float32Array, idx: number): V3 {
    const base = idx * PROCEDURAL_FLOATS_PER_VERTEX;
    return [vertices[base + 3] ?? 0, vertices[base + 4] ?? 0, vertices[base + 5] ?? 0];
  }

  function sub(a: V3, b: V3): V3 {
    return [(a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0)];
  }

  function add3(a: V3, b: V3, c: V3): V3 {
    return [
      (a[0] ?? 0) + (b[0] ?? 0) + (c[0] ?? 0),
      (a[1] ?? 0) + (b[1] ?? 0) + (c[1] ?? 0),
      (a[2] ?? 0) + (b[2] ?? 0) + (c[2] ?? 0),
    ];
  }

  function cross(a: V3, b: V3): V3 {
    return [
      (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
      (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
      (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
    ];
  }

  function dot(a: V3, b: V3): number {
    return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  }

  /**
   * Collect every triangle whose geometric winding disagrees with the
   * average of its three per-vertex normals. Degenerate triangles (zero-
   * length geometric normal — collapsed quads at sphere poles, etc.) are
   * silently skipped: a zero geometric normal cannot be inverted, and
   * winding for collapsed triangles is irrelevant to back-face cull
   * (they project to zero pixels).
   */
  function findInvertedTriangles(mesh: MeshAsset): TriangleVerdict[] {
    const inverted: TriangleVerdict[] = [];
    const indices = mesh.indices;
    if (indices === undefined) return inverted;
    const indexCount = indices.length;
    for (let t = 0; t < indexCount; t += 3) {
      const i0 = indices[t] ?? 0;
      const i1 = indices[t + 1] ?? 0;
      const i2 = indices[t + 2] ?? 0;
      const p0 = readPos(mesh.vertices, i0);
      const p1 = readPos(mesh.vertices, i1);
      const p2 = readPos(mesh.vertices, i2);
      const geomN = cross(sub(p1, p0), sub(p2, p0));
      const geomLen2 = dot(geomN, geomN);
      if (geomLen2 < 1e-12) continue;
      const refN = add3(
        readNormal(mesh.vertices, i0),
        readNormal(mesh.vertices, i1),
        readNormal(mesh.vertices, i2),
      );
      const d = dot(geomN, refN);
      if (d < 0) {
        inverted.push({ triangleIndex: t / 3, indices: [i0, i1, i2], dot: d });
      }
    }
    return inverted;
  }

  function expectAllOutward(name: string, mesh: MeshAsset): void {
    const inverted = findInvertedTriangles(mesh);
    const totalTriangles = (mesh.indices?.length ?? 0) / 3;
    expect(
      inverted,
      `${inverted.length}/${totalTriangles} ${name} triangles wind opposite to their authored normal; first offender: ${JSON.stringify(inverted[0])}`,
    ).toHaveLength(0);
  }

  describe('procedural geometry winding faces outward (bug-20260519)', () => {
    it('createBoxGeometry: every triangle CCW from outside', () => {
      expectAllOutward('box', unwrap(createBoxGeometry(2, 1.5, 0.8)));
    });

    it('createSphereGeometry: every triangle CCW from outside', () => {
      expectAllOutward('sphere', unwrap(createSphereGeometry(1)));
    });

    it('createCylinderGeometry: every triangle CCW from outside', () => {
      expectAllOutward('cylinder', unwrap(createCylinderGeometry(1, 1, 2)));
    });

    it('createConeGeometry: every triangle CCW from outside', () => {
      expectAllOutward('cone', unwrap(createConeGeometry(1, 2)));
    });

    it('createTorusGeometry: every triangle CCW from outside', () => {
      expectAllOutward('torus', unwrap(createTorusGeometry(1, 0.4)));
    });

    it('createCapsuleGeometry: every triangle CCW from outside', () => {
      expectAllOutward('capsule', unwrap(createCapsuleGeometry(0.5, 1)));
    });

    it('createCapsuleGeometry: length=0 (sphere degenerate) keeps every triangle CCW outward', () => {
      expectAllOutward('capsule (sphere)', unwrap(createCapsuleGeometry(0.75, 0)));
    });

    it('createPlaneGeometry: every triangle agrees with authored normal', () => {
      expectAllOutward('plane', unwrap(createPlaneGeometry(2, 1)));
    });

    it('createBoxGeometry: subdivided box (3x2x4 segs) keeps every triangle CCW outward', () => {
      expectAllOutward('subdivided box', unwrap(createBoxGeometry(1, 1, 1, 3, 2, 4)));
    });
  });
}

{
  // --- from geometry.test.ts ---
  // Procedural geometry factory tests (M3 / w8).
  //
  // Covers 6 factories: box / sphere / plane / cylinder / cone / torus.
  // Each factory is tested for:
  //   - idempotency: same inputs -> byte-identical vertex buffers
  //   - degenerate parameters -> Result.err(AssetError({ code: 'asset-parse-failed' }))
  //   - basic vertex / index count sanity
  //
  // AC-15 narrowing is exercised by the factory implementations themselves
  // (Object.entries(attributes) loops inside each factory body); this test file
  // additionally verifies at runtime that every factory populates the
  // `position` attribute with a Float32Array view, which matches the 6-key
  // VertexAttributeMap closed set.
  //
  // Related: requirements §AC-06 / §AC-14 / §AC-15 / §AC-16;
  //          plan-strategy D-P5 6 procedural geometries;
  //          plan-tasks.json w8 acceptanceCheck.

  function unwrapMesh(
    r: { ok: true; value: MeshAsset } | { ok: false; error: AssetError },
  ): MeshAsset {
    if (!r.ok) throw new Error(`unexpected err: ${r.error.code}`);
    return r.value;
  }

  function arraysEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
    const va = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const vb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
    return true;
  }

  function at(a: Float32Array, i: number): number {
    const v = a[i];
    if (v === undefined) throw new Error(`index ${i} out of bounds (length ${a.length})`);
    return v;
  }

  describe('createBoxGeometry', () => {
    it('idempotent: same inputs -> byte-identical vertex buffers (normal)', () => {
      const a = unwrapMesh(createBoxGeometry(1, 1, 1));
      const b = unwrapMesh(createBoxGeometry(1, 1, 1));
      expect(arraysEqual(a.vertices, b.vertices)).toBe(true);
    });

    it('default and explicit segments produce identical buffers (boundary)', () => {
      const a = unwrapMesh(createBoxGeometry(2, 3, 4, 1, 1, 1));
      const b = unwrapMesh(createBoxGeometry(2, 3, 4));
      expect(arraysEqual(a.vertices, b.vertices)).toBe(true);
      // Geometry factories always emit indices; assert non-null after indices
      // became optional on MeshAsset (feat-20260604 M2).
      expect(arraysEqual(a.indices as ArrayBufferView, b.indices as ArrayBufferView)).toBe(true);
    });

    it('degenerate (zero dim) -> asset-parse-failed (degenerate)', () => {
      const r = createBoxGeometry(0, 1, 1);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(AssetError);
        expect(r.error.code).toBe('asset-parse-failed');
      }
    });

    it('degenerate (segments < 1) -> asset-parse-failed (degenerate)', () => {
      const r = createBoxGeometry(1, 1, 1, 0, 1, 1);
      expect(r.ok).toBe(false);
    });

    it('populates position attribute with Float32Array view (normal)', () => {
      const m = unwrapMesh(createBoxGeometry(1, 1, 1));
      expect(m.attributes.position).toBeInstanceOf(Float32Array);
      expect(m.attributes.normal).toBeInstanceOf(Float32Array);
      expect(m.attributes.uv).toBeInstanceOf(Float32Array);
    });
  });

  describe('createSphereGeometry', () => {
    it('idempotent: same inputs -> byte-identical vertex buffers (normal)', () => {
      const a = unwrapMesh(createSphereGeometry(1, 8, 6));
      const b = unwrapMesh(createSphereGeometry(1, 8, 6));
      expect(arraysEqual(a.vertices, b.vertices)).toBe(true);
    });

    it('larger segments yields more vertices (boundary)', () => {
      const a = unwrapMesh(createSphereGeometry(1, 8, 6));
      const b = unwrapMesh(createSphereGeometry(1, 16, 12));
      expect(b.vertices.length).toBeGreaterThan(a.vertices.length);
    });

    it('degenerate (radius <= 0) -> asset-parse-failed (degenerate)', () => {
      const r = createSphereGeometry(0, 8, 6);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('asset-parse-failed');
    });

    it('degenerate (widthSegments < 3) -> asset-parse-failed (degenerate)', () => {
      const r = createSphereGeometry(1, 2, 6);
      expect(r.ok).toBe(false);
    });

    it('triangle count > 0 (normal)', () => {
      const m = unwrapMesh(createSphereGeometry(1, 16, 12));
      expect(m.indices?.length ?? 0).toBeGreaterThan(0);
    });

    it('vertices lie on unit sphere: |hypot(pos) - 1| < 1e-6 (normal)', () => {
      const m = unwrapMesh(createSphereGeometry(1, 16, 12));
      const pos = m.attributes.position;
      expect(pos).toBeInstanceOf(Float32Array);
      const f32 = pos as Float32Array;
      const count = f32.length;
      for (let i = 0; i + 2 < count; i += 3) {
        const h = Math.hypot(f32[i] ?? 0, f32[i + 1] ?? 0, f32[i + 2] ?? 0);
        expect(Math.abs(h - 1)).toBeLessThan(1e-6);
      }
    });
  });

  describe('createPlaneGeometry', () => {
    it('idempotent: same inputs -> byte-identical vertex buffers (normal)', () => {
      const a = unwrapMesh(createPlaneGeometry(2, 2));
      const b = unwrapMesh(createPlaneGeometry(2, 2));
      expect(arraysEqual(a.vertices, b.vertices)).toBe(true);
    });

    it('unit plane has 4 vertices and 6 indices with default 1x1 segments (boundary)', () => {
      const m = unwrapMesh(createPlaneGeometry(1, 1));
      // 4 vertices * 12 floats (pos3 + normal3 + uv2 + tangent4) = 48 floats
      // (feat-20260518 M4 / w21: stride upgraded from 8 to 12 to carry
      // tangent for the standard / pbr.wgsl pipeline; see
      // geometry/box.ts PROCEDURAL_FLOATS_PER_VERTEX = 12).
      expect(m.vertices.length).toBe(48);
      expect(m.indices?.length ?? 0).toBe(6);
    });

    it('degenerate (width <= 0) -> asset-parse-failed (degenerate)', () => {
      const r = createPlaneGeometry(-1, 1);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('asset-parse-failed');
    });
  });

  describe('createCylinderGeometry', () => {
    it('idempotent: same inputs -> byte-identical vertex buffers (normal)', () => {
      const a = unwrapMesh(createCylinderGeometry(1, 1, 2, 8));
      const b = unwrapMesh(createCylinderGeometry(1, 1, 2, 8));
      expect(arraysEqual(a.vertices, b.vertices)).toBe(true);
    });

    it('zero top radius is allowed (cone-like degenerate end) (boundary)', () => {
      const r = createCylinderGeometry(0, 1, 2, 8);
      expect(r.ok).toBe(true);
    });

    it('degenerate (both radii <= 0) -> asset-parse-failed (degenerate)', () => {
      const r = createCylinderGeometry(0, 0, 2, 8);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('asset-parse-failed');
    });

    it('degenerate (radialSegments < 3) -> asset-parse-failed (degenerate)', () => {
      const r = createCylinderGeometry(1, 1, 2, 2);
      expect(r.ok).toBe(false);
    });
  });

  describe('createConeGeometry', () => {
    it('idempotent: same inputs -> byte-identical vertex buffers (normal)', () => {
      const a = unwrapMesh(createConeGeometry(1, 2, 8));
      const b = unwrapMesh(createConeGeometry(1, 2, 8));
      expect(arraysEqual(a.vertices, b.vertices)).toBe(true);
    });

    it('cone equals cylinder with topRadius=0 (boundary)', () => {
      const cone = unwrapMesh(createConeGeometry(1, 2, 8));
      const cyl = unwrapMesh(createCylinderGeometry(0, 1, 2, 8));
      expect(arraysEqual(cone.vertices, cyl.vertices)).toBe(true);
      expect(arraysEqual(cone.indices as ArrayBufferView, cyl.indices as ArrayBufferView)).toBe(
        true,
      );
    });

    it('degenerate (radius <= 0) -> asset-parse-failed (degenerate)', () => {
      const r = createConeGeometry(0, 2, 8);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('asset-parse-failed');
    });
  });

  describe('createTorusGeometry', () => {
    it('idempotent: same inputs -> byte-identical vertex buffers (normal)', () => {
      const a = unwrapMesh(createTorusGeometry(1, 0.3, 8, 6));
      const b = unwrapMesh(createTorusGeometry(1, 0.3, 8, 6));
      expect(arraysEqual(a.vertices, b.vertices)).toBe(true);
    });

    it('tube radius smaller than ring produces finite positive vertex count (boundary)', () => {
      const m = unwrapMesh(createTorusGeometry(1, 0.3, 8, 6));
      expect(m.vertices.length).toBeGreaterThan(0);
    });

    it('degenerate (ring radius <= 0) -> asset-parse-failed (degenerate)', () => {
      const r = createTorusGeometry(0, 0.3, 8, 6);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('asset-parse-failed');
    });

    it('degenerate (tubularSegments < 3) -> asset-parse-failed (degenerate)', () => {
      const r = createTorusGeometry(1, 0.3, 2, 6);
      expect(r.ok).toBe(false);
    });
  });

  describe('createCapsuleGeometry', () => {
    it('idempotent: same inputs -> byte-identical vertex buffers (normal)', () => {
      const a = unwrapMesh(createCapsuleGeometry(0.5, 1, 4, 8));
      const b = unwrapMesh(createCapsuleGeometry(0.5, 1, 4, 8));
      expect(arraysEqual(a.vertices, b.vertices)).toBe(true);
    });

    it('default segments produce a finite positive vertex + index count (normal)', () => {
      const m = unwrapMesh(createCapsuleGeometry(0.5, 1));
      expect(m.vertices.length).toBeGreaterThan(0);
      expect(m.indices?.length ?? 0).toBeGreaterThan(0);
    });

    it('total height = length + 2*radius; extreme Y at +-(length/2 + radius) (boundary)', () => {
      const radius = 0.5;
      const length = 2;
      const m = unwrapMesh(createCapsuleGeometry(radius, length, 6, 12));
      const pos = m.attributes.position as Float32Array;
      let maxY = -Infinity;
      let minY = Infinity;
      for (let i = 0; i + 2 < pos.length; i += 3) {
        const y = pos[i + 1] ?? 0;
        if (y > maxY) maxY = y;
        if (y < minY) minY = y;
      }
      const expected = length / 2 + radius;
      expect(Math.abs(maxY - expected)).toBeLessThan(1e-5);
      expect(Math.abs(minY + expected)).toBeLessThan(1e-5);
    });

    it('length=0 collapses to a sphere of the given radius: all verts on |r| (boundary)', () => {
      const radius = 0.75;
      const m = unwrapMesh(createCapsuleGeometry(radius, 0, 6, 12));
      const pos = m.attributes.position as Float32Array;
      for (let i = 0; i + 2 < pos.length; i += 3) {
        const h = Math.hypot(pos[i] ?? 0, pos[i + 1] ?? 0, pos[i + 2] ?? 0);
        expect(Math.abs(h - radius)).toBeLessThan(1e-5);
      }
    });

    it('degenerate (radius <= 0) -> asset-parse-failed (degenerate)', () => {
      const r = createCapsuleGeometry(0, 1);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('asset-parse-failed');
    });

    it('degenerate (negative length) -> asset-parse-failed (degenerate)', () => {
      const r = createCapsuleGeometry(0.5, -1);
      expect(r.ok).toBe(false);
    });

    it('degenerate (radialSegments < 3) -> asset-parse-failed (degenerate)', () => {
      const r = createCapsuleGeometry(0.5, 1, 4, 2);
      expect(r.ok).toBe(false);
    });

    it('degenerate (capSegments < 1) -> asset-parse-failed (degenerate)', () => {
      const r = createCapsuleGeometry(0.5, 1, 0, 8);
      expect(r.ok).toBe(false);
    });
  });

  describe('VertexAttributeMap narrowing (AC-15)', () => {
    it('every factory returns a mesh whose attributes keys are a subset of the 6-key closed set', () => {
      const meshes = [
        unwrapMesh(createBoxGeometry(1, 1, 1)),
        unwrapMesh(createSphereGeometry(1, 8, 6)),
        unwrapMesh(createPlaneGeometry(1, 1)),
        unwrapMesh(createCylinderGeometry(1, 1, 2, 8)),
        unwrapMesh(createConeGeometry(1, 2, 8)),
        unwrapMesh(createTorusGeometry(1, 0.3, 8, 6)),
        unwrapMesh(createCapsuleGeometry(0.5, 1, 4, 8)),
      ];
      const allowed = new Set(['position', 'normal', 'uv', 'tangent', 'skinIndex', 'skinWeight']);
      for (const m of meshes) {
        for (const key of Object.keys(m.attributes)) {
          expect(allowed.has(key)).toBe(true);
        }
        // every factory at least populates position
        expect(m.attributes.position).toBeInstanceOf(Float32Array);
      }
    });
  });

  // VAIU-F1: the @forgeax/engine-geometry barrel is the single AI-user-facing
  // import for the 6 geometry factories. Guard it so a future accidental
  // barrel-drop breaks the test instead of the AI-user-facing import.
  // bug-20260601: procedural geometry UV.v uses the WebGPU top-left
  // convention (V=0 = image top). The torus already authored j/rs (angular
  // wrap-around-the-tube coordinate, direction-agnostic) and is asserted
  // unchanged. Factory interleaved buffer layout: position(3) + normal(3) +
  // uv(2) = 8 floats per vertex before meshFromInterleaved expands to 12.
  describe('procedural geometry UV.v orientation (bug-20260601)', () => {
    it('plane: top row (iy=0) carries v=0, bottom row carries v=1', () => {
      const m = unwrapMesh(createPlaneGeometry(2, 4, 1, 2));
      // 1x2 segments = (1+1) * (2+1) = 6 vertices. Row iy=0 vertices are
      // indices 0..1 (v is at stride offset 1 within uv2).
      const uv = m.attributes.uv;
      expect(uv).toBeInstanceOf(Float32Array);
      const uvs = uv as Float32Array;
      // Top row (iy=0, v=0): vertices 0,1
      expect(Math.abs(at(uvs, 0 * 2 + 1) - 0)).toBeLessThan(1e-6);
      expect(Math.abs(at(uvs, 1 * 2 + 1) - 0)).toBeLessThan(1e-6);
      // Bottom row (iy=2, v=1): vertices 4,5
      expect(Math.abs(at(uvs, 4 * 2 + 1) - 1)).toBeLessThan(1e-6);
      expect(Math.abs(at(uvs, 5 * 2 + 1) - 1)).toBeLessThan(1e-6);
    });

    it('box: +Y face top edge (j=0) carries v=0, bottom edge (j=vSegs) carries v=1', () => {
      // 1x1x1 box, 1 segment per face. The +Y face has 4 vertices; j=0 yields v=0.
      const m = unwrapMesh(createBoxGeometry(1, 1, 1, 1, 1, 1));
      const uvs = m.attributes.uv as Float32Array;
      // Box has 6 faces * 4 vertices = 24 vertices. The +Y face is face index 2
      // (0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z), so its 4 vertices start at
      // offset 8 within the per-face vertex sequence (2 faces * 4 verts).
      const yFaceStart = 2 * 4;
      // j=0 (top edge): vertices yFaceStart+0 and yFaceStart+1
      expect(Math.abs(at(uvs, (yFaceStart + 0) * 2 + 1) - 0)).toBeLessThan(1e-6);
      expect(Math.abs(at(uvs, (yFaceStart + 1) * 2 + 1) - 0)).toBeLessThan(1e-6);
      // j=1 (bottom edge): vertices yFaceStart+2 and yFaceStart+3
      expect(Math.abs(at(uvs, (yFaceStart + 2) * 2 + 1) - 1)).toBeLessThan(1e-6);
      expect(Math.abs(at(uvs, (yFaceStart + 3) * 2 + 1) - 1)).toBeLessThan(1e-6);
    });

    it('sphere: north pole (v=0, phi=0) carries v=0', () => {
      const m = unwrapMesh(createSphereGeometry(1, 8, 4));
      const uvs = m.attributes.uv as Float32Array;
      // 8+1=9 vertices per row, iy=0 (north pole) row occupies first 9 vertices.
      // All north-pole-row vertices carry v=0.
      for (let i = 0; i < 9; i++) {
        expect(Math.abs(at(uvs, i * 2 + 1) - 0)).toBeLessThan(1e-6);
      }
    });

    it('cylinder: top edge (v=0) carries v=0', () => {
      const m = unwrapMesh(createCylinderGeometry(1, 1, 2, 8, 2));
      const uvs = m.attributes.uv as Float32Array;
      // Side face: (8+1) * (2+1) = 27 vertices. Row iy=0 occupies first 9 vertices.
      // Top row carries v=0.
      for (let i = 0; i < 9; i++) {
        expect(Math.abs(at(uvs, i * 2 + 1) - 0)).toBeLessThan(1e-6);
      }
    });

    it('cone delegates to cylinder and inherits the corrected UV', () => {
      const cone = unwrapMesh(createConeGeometry(1, 2, 8, 2));
      const cyl = unwrapMesh(createCylinderGeometry(0, 1, 2, 8, 2));
      const coneUV = cone.attributes.uv as Float32Array;
      const cylUV = cyl.attributes.uv as Float32Array;
      // Byte-identical UVs (same as the existing cone-equals-cylinder test for buffers).
      for (let i = 0; i < coneUV.length; i++) {
        expect(Math.abs(at(coneUV, i) - at(cylUV, i))).toBeLessThan(1e-6);
      }
      // Top row v=0
      for (let i = 0; i < 9; i++) {
        expect(Math.abs(at(coneUV, i * 2 + 1) - 0)).toBeLessThan(1e-6);
      }
    });

    it('torus V is already top-left (j/rs, angular coordinate) — unchanged', () => {
      const m = unwrapMesh(createTorusGeometry(1, 0.4, 4, 6));
      const uvs = m.attributes.uv as Float32Array;
      // (4+1) * (6+1) = 35 vertices. j=0 (rs=0) row carries v=0.
      const stride = 6 + 1; // tubularSegments+1
      for (let i = 0; i < stride; i++) {
        expect(Math.abs(at(uvs, i * 2 + 1) - 0)).toBeLessThan(1e-6);
      }
    });
  });

  describe('geometry barrel re-exports (VAIU-F1)', () => {
    it('@forgeax/engine-geometry exposes all 7 factories', async () => {
      const mod = await import('@forgeax/engine-geometry');
      expect(typeof mod.createBoxGeometry).toBe('function');
      expect(typeof mod.createCapsuleGeometry).toBe('function');
      expect(typeof mod.createConeGeometry).toBe('function');
      expect(typeof mod.createCylinderGeometry).toBe('function');
      expect(typeof mod.createPlaneGeometry).toBe('function');
      expect(typeof mod.createSphereGeometry).toBe('function');
      expect(typeof mod.createTorusGeometry).toBe('function');
    });
  });
}

{
  // --- from vertex-attribute-layout.test.ts ---
  // @forgeax/engine-runtime - vertex-attribute-layout unit tests (M2 / T-23).
  //
  // Tests deriveVertexBufferLayout against each of the 6 closed-set vertex
  // attribute keys plus multi-key combination scenarios.
  // plan-strategy D-7: vertex-attribute-layout.ts is the SSOT for @location(N)
  // -> GPUVertexFormat mapping consumed by shader WGSL and geometry factories.

  function makeBuffer(len: number): Float32Array {
    return new Float32Array(len);
  }

  describe('deriveVertexBufferLayout', () => {
    it('position-only produces one layout entry with float32x3 at location 0', () => {
      const map: VertexAttributeMap = { position: makeBuffer(3) };
      const layout = deriveVertexBufferLayout(map);
      expect(layout).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      const entry = layout[0]!;
      expect(entry.arrayStride).toBe(12);
      expect(entry.attributes).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(entry.attributes[0]!.shaderLocation).toBe(0);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(entry.attributes[0]!.format).toBe('float32x3');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(entry.attributes[0]!.offset).toBe(0);
    });

    it('normal-only produces one layout entry with float32x3 at location 1', () => {
      const map: VertexAttributeMap = { normal: makeBuffer(3) };
      const layout = deriveVertexBufferLayout(map);
      expect(layout).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.shaderLocation).toBe(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.format).toBe('float32x3');
    });

    it('uv-only produces one layout entry with float32x2 at location 2', () => {
      const map: VertexAttributeMap = { uv: makeBuffer(2) };
      const layout = deriveVertexBufferLayout(map);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.shaderLocation).toBe(2);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.format).toBe('float32x2');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.offset).toBe(0);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.arrayStride).toBe(8);
    });

    it('tangent-only produces one layout entry with float32x4 at location 3', () => {
      const map: VertexAttributeMap = { tangent: makeBuffer(4) };
      const layout = deriveVertexBufferLayout(map);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.shaderLocation).toBe(3);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.format).toBe('float32x4');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.arrayStride).toBe(16);
    });

    it('skinIndex-only produces uint16x4 at location 4', () => {
      const map: VertexAttributeMap = { skinIndex: new Uint16Array(4).buffer };
      const layout = deriveVertexBufferLayout(map);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.shaderLocation).toBe(4);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.format).toBe('uint16x4');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.arrayStride).toBe(8);
    });

    it('skinWeight-only produces float32x4 at location 5', () => {
      const map: VertexAttributeMap = { skinWeight: makeBuffer(4) };
      const layout = deriveVertexBufferLayout(map);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.shaderLocation).toBe(5);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.attributes[0]!.format).toBe('float32x4');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.arrayStride).toBe(16);
    });

    it('all 6 keys produce correct sequential locations and offsets', () => {
      const map: VertexAttributeMap = {
        position: makeBuffer(3),
        normal: makeBuffer(3),
        uv: makeBuffer(2),
        tangent: makeBuffer(4),
        skinIndex: new Uint16Array(4).buffer,
        skinWeight: makeBuffer(4),
      };
      const layout = deriveVertexBufferLayout(map);
      expect(layout).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      const attrs = layout[0]!.attributes;
      expect(attrs).toHaveLength(6);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[0]!.shaderLocation).toBe(0);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[0]!.format).toBe('float32x3');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[0]!.offset).toBe(0);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[1]!.shaderLocation).toBe(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[1]!.format).toBe('float32x3');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[1]!.offset).toBe(12);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[2]!.shaderLocation).toBe(2);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[2]!.format).toBe('float32x2');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[2]!.offset).toBe(24);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[3]!.shaderLocation).toBe(3);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[3]!.format).toBe('float32x4');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[3]!.offset).toBe(32);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[4]!.shaderLocation).toBe(4);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[4]!.format).toBe('uint16x4');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[4]!.offset).toBe(48);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[5]!.shaderLocation).toBe(5);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[5]!.format).toBe('float32x4');
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[5]!.offset).toBe(56);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.arrayStride).toBe(72); // 12+12+8+16+8+16 = 72
    });

    it('produces contiguous offsets when some keys are missing', () => {
      const map: VertexAttributeMap = {
        position: makeBuffer(3),
        uv: makeBuffer(2),
        skinWeight: makeBuffer(4),
      };
      const layout = deriveVertexBufferLayout(map);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      const attrs = layout[0]!.attributes;
      expect(attrs).toHaveLength(3);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[0]!.shaderLocation).toBe(0); // position
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[0]!.offset).toBe(0);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[1]!.shaderLocation).toBe(2); // uv (normal skipped)
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[1]!.offset).toBe(12); // after position stride

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[2]!.shaderLocation).toBe(5); // skinWeight
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(attrs[2]!.offset).toBe(20); // 12 + 8

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(layout[0]!.arrayStride).toBe(36); // 12 + 8 + 16
    });

    it('empty map produces empty layout', () => {
      const map: VertexAttributeMap = {};
      const layout = deriveVertexBufferLayout(map);
      expect(layout).toHaveLength(0);
    });
  });
}
