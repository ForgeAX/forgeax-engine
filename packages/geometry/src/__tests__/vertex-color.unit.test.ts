import { describe, expect, it } from 'vitest';
import {
  createBoxGeometry,
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
  withVertexColor,
  withVertexColors,
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

describe('withVertexColors', () => {
  const source = createBoxGeometry(1, 1, 1).unwrap();
  const count = (source.attributes.position as Float32Array).length / 3;

  it('packs per-vertex linear RGB and fills alpha 1, like geometry.setAttribute(color)', () => {
    const rgb = new Float32Array(count * 3).fill(0.5);
    const colored = withVertexColors(source, rgb).unwrap();
    expect(Array.from(colored.attributes.color?.subarray(0, 4) ?? [])).toEqual([0.5, 0.5, 0.5, 1]);
    const projection = deriveVertexLayoutProjection(colored.attributes);
    expect(colored.vertices.byteLength).toBe(projection.arrayStride * count);
  });

  it('accepts RGBA and converts sRGB input to linear without touching alpha', () => {
    const rgba = new Float32Array(count * 4).fill(1);
    rgba.set([0.5, 0.5, 0.5, 0.25], 0);
    const colored = withVertexColors(source, rgba, { space: 'srgb' }).unwrap();
    const first = Array.from(colored.attributes.color?.subarray(0, 4) ?? []);
    expect(first[0]).toBeCloseTo(0.214, 3);
    expect(first[3]).toBeCloseTo(0.25, 6);
  });

  it('returns a readable error naming the expected length', () => {
    const result = withVertexColors(source, new Float32Array(5));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(`${count * 3}`);
    expect(result.error.message).not.toContain('[object Object]');
  });
});
