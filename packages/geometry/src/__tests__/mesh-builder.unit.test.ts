import { describe, expect, it } from 'vitest';
import { createMeshBuilder } from '../mesh-builder.js';

const trianglePositions = new Float32Array([-1, -2, -3, 4, 5, 6, 0, 2, 1]);

describe('createMeshBuilder', () => {
  it('derives position-only layout, AABB, index width, and default submesh', () => {
    const result = createMeshBuilder({
      attributes: { position: trianglePositions },
      indices: [0, 1, 2],
    }).build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attributes).toEqual({ position: trianglePositions });
    expect(result.value.indices).toBeInstanceOf(Uint16Array);
    expect(result.value.aabb).toEqual(Float32Array.of(-1, -2, -3, 4, 5, 6));
    expect(result.value.submeshes).toEqual([
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ]);
    expect(result.value.materialSlots).toEqual([{ slotName: 'Default' }]);
    expect(result.value.vertices).toEqual(trianglePositions);
  });

  it('packs the complete canonical attribute set without a caller-owned layout', () => {
    const result = createMeshBuilder({
      attributes: {
        position: trianglePositions,
        normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uv: new Float32Array([0, 0, 1, 0, 0, 1]),
        tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
        color: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
      },
      indices: new Uint16Array([0, 1, 2]),
    }).build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vertices.byteLength).toBe(3 * 64);
    expect(result.value.attributes.color).toEqual(
      new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
    );
  });

  it('chooses Uint32 at the first index beyond the Uint16 range', () => {
    const positions = new Float32Array(65_537 * 3);
    positions[65_536 * 3] = 10;
    const result = createMeshBuilder({
      attributes: { position: positions },
      indices: [0, 65_535, 65_536],
    }).build();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.indices).toBeInstanceOf(Uint32Array);
  });

  it('returns structured errors for missing attributes, cardinality, indices, and ranges', () => {
    const missingPosition = createMeshBuilder({
      attributes: { normal: new Float32Array(3) },
    }).build();
    expect(missingPosition.ok).toBe(false);
    if (!missingPosition.ok) expect(missingPosition.error.code).toBe('asset-invalid-value');

    const mismatched = createMeshBuilder({
      attributes: { position: trianglePositions, normal: new Float32Array(3) },
    }).build();
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.detail).toMatchObject({ field: 'normal' });

    const outOfBounds = createMeshBuilder({
      attributes: { position: trianglePositions },
      indices: [0, 1, 3],
    }).build();
    expect(outOfBounds.ok).toBe(false);
    if (!outOfBounds.ok) expect(outOfBounds.error.detail).toMatchObject({ field: 'indices' });

    const invalidRange = createMeshBuilder({
      attributes: { position: trianglePositions },
      indices: [0, 1, 2],
      submeshes: [{ indexOffset: 2, indexCount: 2, vertexCount: 3, topology: 'triangle-list' }],
    }).build();
    expect(invalidRange.ok).toBe(false);
    if (!invalidRange.ok)
      expect(invalidRange.error.detail).toMatchObject({ field: 'submeshes[0]' });
  });

  it('copies accumulated source data and preserves built output immutability', () => {
    const source = new Float32Array(trianglePositions);
    const builder = createMeshBuilder({ attributes: { position: source } });
    const first = builder.build();
    expect(first.ok).toBe(true);
    source[0] = 99;
    const second = builder.build();
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.attributes.position).toEqual(trianglePositions);
    expect(second.value.attributes.position).toEqual(trianglePositions);
  });
});
