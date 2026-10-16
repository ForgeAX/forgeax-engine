// w18 — Integration: compression ratio
// @perf-budget-skip: intentional multi-megabyte zstd compression-ratio gate.
//
// AC-05 compression ratio: compress a programmatic ~3.2MB f32 vertex
//       fixture with zstd, assert compressedSize / originalSize <= 0.70
//       (>= 30% reduction). Fixture is programmatic f32 array mimicking real
//       mesh bin layout (28B header + Float32Array vertices + Uint16Array
//       indices + JSON tail).
//
// TDD-RED before w20 — the mesh default flip had not happened yet.
//
// Plan decisions:
//   AC-05: mesh .bin ≥30% compression ratio
//   R5: ratio is interval inference, assert >= 0.30 lower bound
//   D-10: all fixture data programmatic

import { describe, expect, it } from 'vitest';

describe('w18: zero-compression zero-decoder loading + compression ratio', () => {
  /**
   * AC-05 compression ratio: compress a ~3.2MB vertex payload with zstd,
   * verify >= 30% reduction.
   *
   * Not TDD-red — this is a direct codec compressZstd call against a
   * synthetic fixture, and the codec is already complete from M1.
   */
  it('AC-05: zstd compression ratio >= 30% for ~3.2MB f32 vertex fixture', async () => {
    const { compressZstd } = await import('@forgeax/engine-codec/encode');

    // Build a realistic mesh bin payload simulating a ~100K vertex mesh.
    // 28B header + 100K vertices * 12 floats/vertex * 4 bytes/float
    // = 28 + 4,800,000 = ~4.8MB. We use 80K vertices to stay near 3.2MB
    // of vertex data.
    const vertexCount = 80000;
    const floatsPerVertex = 12;
    const vlen = vertexCount * floatsPerVertex; // 960000
    const ilen = 120000; // roughly 1.5x vertex count for indices
    const iwidth = 2;
    const jsonTail =
      '{"submeshes":[{"indexOffset":0,"indexCount":120000,"vertexCount":960000,"topology":"triangle-list"}],"aabb":[-1,-1,-1,1,1,1]}';
    const jsonBytes = new TextEncoder().encode(jsonTail);

    const header = new ArrayBuffer(28);
    const dv = new DataView(header);
    dv.setUint32(0, 2, true);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, 12, true);
    dv.setUint32(12, vlen, true);
    dv.setUint32(16, ilen, true);
    dv.setUint32(20, iwidth, true);
    dv.setUint32(24, jsonBytes.length, true);

    const vertices = new Float32Array(vlen);
    for (let i = 0; i < vertexCount; i++) {
      const b = i * floatsPerVertex;
      // position (pseudo-random pattern mimicking real mesh data)
      vertices[b + 0] = Math.sin(i * 0.1) * 10;
      vertices[b + 1] = Math.cos(i * 0.1) * 10;
      vertices[b + 2] = Math.sin(i * 0.05) * 5;
      // normal (unit-lengthish)
      const nx = Math.sin(i * 0.07);
      const ny = 0.5 + Math.cos(i * 0.07) * 0.5;
      const nz = Math.cos(i * 0.03);
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      vertices[b + 3] = nx / len;
      vertices[b + 4] = ny / len;
      vertices[b + 5] = nz / len;
      // uv
      vertices[b + 6] = (i % 100) / 100;
      vertices[b + 7] = Math.floor(i / 100) / 100;
      // tangent
      vertices[b + 8] = 1;
      vertices[b + 9] = 0;
      vertices[b + 10] = 0;
      vertices[b + 11] = 1;
    }

    const indices = new Uint16Array(ilen);
    for (let i = 0; i < ilen; i++) {
      indices[i] = i % vertexCount;
    }

    const totalSize = 28 + vlen * 4 + ilen * iwidth + jsonBytes.length;
    const meshBin = new Uint8Array(totalSize);
    let offset = 0;
    meshBin.set(new Uint8Array(header), offset);
    offset += 28;
    meshBin.set(new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength), offset);
    offset += vlen * 4;
    meshBin.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), offset);
    offset += ilen * iwidth;
    meshBin.set(jsonBytes, offset);

    const originalSize = meshBin.length;
    // Should be roughly: 28 + 3,840,000 + 240,000 + ~100 = ~4,080,128 bytes (~4MB)
    expect(originalSize).toBeGreaterThan(3_000_000); // sanity: > 3MB

    const compRes = await compressZstd(meshBin);
    expect(compRes.ok).toBe(true);
    if (!compRes.ok) return;

    const compressedSize = compRes.value.length;
    const ratio = compressedSize / originalSize;

    // AC-05: >= 30% reduction (compressed <= 70% of original)
    expect(ratio).toBeLessThanOrEqual(0.7);
  });
});
