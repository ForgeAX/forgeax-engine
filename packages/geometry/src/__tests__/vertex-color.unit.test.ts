import { describe, expect, it } from 'vitest';
import {
  createBoxGeometry,
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
  withVertexColor,
} from '../index';

describe('withVertexColor', () => {
  it('adds one constant linear RGBA per vertex and repacks the canonical layout', () => {
    const source = createBoxGeometry(1, 1, 1).unwrap();
    const colored = withVertexColor(source, [0.25, 0.5, 0.75, 1]).unwrap();
    const vertexCount = (source.attributes.position as Float32Array).length / 3;
    expect(colored.attributes.color).toHaveLength(vertexCount * 4);
    expect(Array.from(colored.attributes.color?.subarray(-4) ?? [])).toEqual([0.25, 0.5, 0.75, 1]);
    const projection = deriveVertexLayoutProjection(colored.attributes);
    expect(colored.vertices.byteLength).toBe(projection.arrayStride * vertexCount);
    const unpacked = unpackInterleavedVertexAttributes(colored.vertices, projection);
    expect(Array.from(unpacked?.color as Float32Array)).toEqual(
      Array.from(colored.attributes.color as Float32Array),
    );
    expect(Array.from(unpacked?.tangent as Float32Array)).toEqual(
      Array.from(source.attributes.tangent as Float32Array),
    );
    expect(colored.submeshes).toEqual(source.submeshes);
    expect(colored.aabb).toEqual(source.aabb);
    expect(source.attributes.color).toBeUndefined();
  });

  it('rejects non-finite colors through the canonical packer', () => {
    const source = createBoxGeometry(1, 1, 1).unwrap();
    expect(withVertexColor(source, [Number.NaN, 0, 0, 1]).ok).toBe(false);
  });
});
