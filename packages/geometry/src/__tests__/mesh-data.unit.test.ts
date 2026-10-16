import { MESH_BIN_HEADER_BYTES } from '@forgeax/engine-pack/mesh-bin-contract';
import { describe, expect, it } from 'vitest';
import { packMeshBin } from '../mesh-data.js';
import { deriveVertexLayoutProjection } from '../vertex-attribute-layout.js';

describe('canonical mesh Cook bytes', () => {
  it('encodes only the validated vertex subview and owns the resulting bytes', () => {
    const attributes = {
      position: new Float32Array([-0, 1, 2, 3, 4, -5]),
      skinIndex: new Uint16Array([65535, 65535, 0, 1, 2, 3, 4, 5]),
      skinWeight: new Float32Array([1, 0, 0, 0, 0.5, 0.5, 0, 0]),
    };
    const projection = deriveVertexLayoutProjection(attributes);
    const expected = new Uint8Array(2 * projection.arrayStride);
    const wire = new DataView(expected.buffer);
    // Independent wire oracle, including uint16 lanes whose float view is NaN.
    for (const entry of projection.attributes) {
      const values = attributes[entry.key as keyof typeof attributes];
      const width = values.BYTES_PER_ELEMENT;
      const components = entry.byteLength / width;
      for (let vertex = 0; vertex < 2; vertex++) {
        for (let component = 0; component < components; component++) {
          const offset = vertex * projection.arrayStride + entry.offset + component * width;
          const value = values[vertex * components + component] as number;
          if (width === 2) wire.setUint16(offset, value, true);
          else wire.setFloat32(offset, value, true);
        }
      }
    }
    const storage = new Float32Array(expected.byteLength / 4 + 4).fill(99);
    const vertices = storage.subarray(2, storage.length - 2);
    new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength).set(expected);
    const payload = { vertices, attributes, indices: new Uint16Array([0, 1]) };
    const result = packMeshBin(payload, 'subview').unwrap();
    expect(result.subarray(MESH_BIN_HEADER_BYTES, MESH_BIN_HEADER_BYTES + expected.length)).toEqual(
      expected,
    );
    vertices.fill(8);
    attributes.position.fill(7);
    expect(result.subarray(MESH_BIN_HEADER_BYTES, MESH_BIN_HEADER_BYTES + expected.length)).toEqual(
      expected,
    );
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -0,
    1,
  ])('rejects a non-finite or inconsistent final lane (%s) before encoding', (value) => {
    const vertices = new Float32Array(6);
    const position = new Float32Array(6);
    position[5] = value;
    expect(packMeshBin({ vertices, attributes: { position } }, 'invalid').ok).toBe(false);
    // Matching non-finite bits must still fail; finite inconsistencies above
    // establish that validation is retained even when encoding copies bytes.
    if (!Number.isFinite(value)) {
      vertices[5] = value;
      expect(packMeshBin({ vertices, attributes: { position } }, 'invalid').ok).toBe(false);
    }
  });
});
