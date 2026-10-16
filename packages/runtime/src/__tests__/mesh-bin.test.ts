import { unpackMeshBin } from '@forgeax/engine-assets-runtime';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { packMeshBin } from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';

describe('mesh-bin runtime roundtrip', () => {
  it('preserves canonical interleaved vertices, color, UV sets, and indices', () => {
    const attributes = {
      position: new Float32Array([1.5, 0, 0, 0, 0, 0]),
      normal: new Float32Array(6),
      uv: new Float32Array(4),
      uv1: new Float32Array(4),
      tangent: new Float32Array(8),
      color: new Float32Array([1, 0.5, 0.25, 1, 0.25, 0.5, 0.75, 1]),
    };
    const { vertices } = packInterleavedVertexAttributes(attributes, 2).unwrap();
    const packed = packMeshBin(
      { vertices, indices: Uint16Array.of(0, 1, 0), attributes },
      'runtime://mesh',
    );
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const unpacked = unpackMeshBin(packed.value, 'runtime://mesh');
    expect(unpacked.ok).toBe(true);
    if (!unpacked.ok) return;
    expect(unpacked.value.vertices[0]).toBeCloseTo(1.5);
    expect(unpacked.value.indices).toBeInstanceOf(Uint16Array);
    expect(unpacked.value.attributes.color).toEqual(attributes.color);
    expect(unpacked.value.projection.attributes.map((entry) => entry.key)).toContain('uv1');
  });

  it('fails closed for a legacy artifact and preserves no partial result', () => {
    const result = unpackMeshBin(new Uint8Array([3, 0, 0]), 'runtime://legacy');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.sourceKey).toBe('runtime://legacy');
    expect(result.error.recovery).toContain('re-cook');
  });
});
