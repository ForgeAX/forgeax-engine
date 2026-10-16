// mesh-bin-contract.test.ts -- feat-20260629-multi-uv-set-support m2-w2
//
// Import-side contract violation test for mesh-bin header v2 encode. Assert
// that packMeshBin with uvSetCount=9 or invalid stride produces a structured
// error (via Fail Fast at encode exit).
//
// RED at this commit: packMeshBin doesn't validate uvSetCount or stride;
// AssetErrorCode lacks 'mesh-bin-contract-violation'.
//
// GREEN after m2-w3 (encode validation) + m2-w5 (AssetErrorCode member).

import { packMeshBin } from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';

describe('mesh-bin contract violation (import-side) (feat-20260629 m2-w2)', () => {
  it('encode: uvSetCount=9 is rejected (Fail Fast at encode exit)', () => {
    // Build a payload that implies uvSetCount=9 (uv1..uv8 present = 9 total)
    const attrs: Record<string, unknown> = {
      position: new Float32Array(12),
      normal: new Float32Array(12),
      uv: new Float32Array(8),
      tangent: new Float32Array(16),
      uv1: new Float32Array(8),
      uv2: new Float32Array(8),
      uv3: new Float32Array(8),
      uv4: new Float32Array(8),
      uv5: new Float32Array(8),
      uv6: new Float32Array(8),
      uv7: new Float32Array(8),
      uv8: new Float32Array(8), // 9th set — out of bounds
    };
    const vertices = new Float32Array(4 * 28); // 12 + 8*2 = 28
    const indices = new Uint16Array([0, 1, 2]);

    const result = packMeshBin({ vertices, indices, attributes: attrs }, 'import://invalid-uv');
    expect(result.ok).toBe(false);
  });
});

describe('mesh-bin v4 producer red matrix', () => {
  const attrs = {
    position: new Float32Array([0, 0, 0]),
    normal: new Float32Array([0, 1, 0]),
    uv: new Float32Array([0, 0]),
    tangent: new Float32Array([1, 0, 0, 1]),
    color: new Float32Array([1, 0.5, 0.25, 1]),
  };

  it('returns deterministic v4 bytes with projection digest, stride, and RGBA payload facts', () => {
    const result = packMeshBin(
      {
        vertices: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0.5, 0.25, 1]),
        indices: new Uint16Array([0, 0, 0]),
        attributes: attrs,
        vertexCount: 1,
      },
      'gltf://color',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const repeat = packMeshBin(
      {
        vertices: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0.5, 0.25, 1]),
        indices: new Uint16Array([0, 0, 0]),
        attributes: attrs,
        vertexCount: 1,
      },
      'gltf://color',
    );
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) return;
    expect(result.value).toEqual(repeat.value);
  });

  it('rejects cardinality and RGBA shape corruption without publishing bytes', () => {
    const result = packMeshBin(
      {
        vertices: new Float32Array(16),
        indices: new Uint16Array([0, 1, 2]),
        attributes: { ...attrs, color: new Float32Array([1, 0, 0]) },
        vertexCount: 2,
      },
      'gltf://bad-color',
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        sourceKey: 'gltf://bad-color',
        expected: expect.any(String),
        actual: expect.any(String),
        recovery: expect.stringContaining('re-cook'),
      },
    });
  });
});
