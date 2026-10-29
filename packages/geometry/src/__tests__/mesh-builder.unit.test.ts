import { describe, expect, it } from 'vitest';
import { createMeshBuilder } from '../mesh-builder.js';

const trianglePositions = new Float32Array([-1, -2, -3, 4, 5, 6, 0, 2, 1]);

describe('createMeshBuilder', () => {
  it('derives position-only layout, AABB, index width, and default submesh', () => {
    const result = createMeshBuilder({
      attributes: { position: trianglePositions },
      indices: [0, 1, 2],
      submeshes: [{ topology: 'line-list' }],
    }).build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attributes).toEqual({ position: trianglePositions });
    expect(result.value.indices).toBeInstanceOf(Uint16Array);
    expect(result.value.aabb).toEqual(Float32Array.of(-1, -2, -3, 4, 5, 6));
    expect(result.value.submeshes).toEqual([
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'line-list', materialSlot: 0 },
    ]);
    expect(result.value.materialSlots).toEqual([{ slotName: 'Default' }]);
    expect(result.value.vertices).toEqual(trianglePositions);
  });

  it('completes the stock surface stream of triangle meshes', () => {
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const indices = [0, 1, 2, 0, 2, 3];
    const unit = (values: Float32Array | undefined, stride: number) =>
      Array.from({ length: 4 }, (_, v) =>
        Math.hypot(...Array.from(values?.subarray(v * stride, v * stride + 3) ?? [])),
      );
    const derived = createMeshBuilder({ attributes: { position, uv }, indices }).build().unwrap();
    expect(Array.from(derived.attributes.normal as Float32Array)).toEqual(
      Array.from({ length: 4 }, () => [0, 0, 1]).flat(),
    );
    // UV +u runs along +x with a right-handed basis.
    expect(Array.from(derived.attributes.tangent as Float32Array)).toEqual(
      Array.from({ length: 4 }, () => [1, 0, 0, 1]).flat(),
    );
    expect(derived.vertices.byteLength).toBe(4 * 48);

    // Without UVs (zero-filled) or with degenerate UVs the tangent lies in the normal plane.
    const normal = new Float32Array(Array.from({ length: 4 }, () => [0, 1, 0]).flat());
    for (const attributes of [
      { position, normal },
      { position, normal, uv: new Float32Array(8) },
    ]) {
      const mesh = createMeshBuilder({ attributes, indices }).build().unwrap();
      const tangent = mesh.attributes.tangent as Float32Array;
      expect(mesh.attributes.normal).toEqual(normal);
      expect(mesh.attributes.uv).toEqual(new Float32Array(8));
      expect(unit(tangent, 4).every((length) => Math.abs(length - 1) < 1e-6)).toBe(true);
      for (let v = 0; v < 4; v += 1) {
        expect(tangent[v * 4 + 1]).toBeCloseTo(0, 6);
        expect(tangent[v * 4 + 3]).toBe(1);
      }
    }

    // Authored tangents are retained verbatim.
    const tangent = new Float32Array(Array.from({ length: 4 }, () => [0, 0, 1, -1]).flat());
    const authored = createMeshBuilder({ attributes: { position, normal, tangent }, indices })
      .build()
      .unwrap();
    expect(authored.attributes.tangent).toEqual(tangent);
  });

  it('keeps UV tangents when one authored normal is zero or a vertex is unused', () => {
    // Quad 0..3 with valid UVs, a degenerate triangle on vertex 4 (zero normal),
    // and vertex 5 referenced by no triangle (zero normal).
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 2, 0, 5, 5, 5]);
    const normal = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0]);
    const mesh = createMeshBuilder({
      attributes: { position, normal, uv },
      indices: [0, 1, 2, 0, 2, 3, 4, 4, 4],
    })
      .build()
      .unwrap();
    const tangent = mesh.attributes.tangent as Float32Array;
    expect(Array.from(tangent.subarray(0, 16))).toEqual(
      Array.from({ length: 4 }, () => [1, 0, 0, 1]).flat(),
    );
    for (const vertex of [4, 5]) {
      const t = Array.from(tangent.subarray(vertex * 4, vertex * 4 + 4));
      expect(Math.hypot(t[0] ?? 0, t[1] ?? 0, t[2] ?? 0)).toBeCloseTo(1, 6);
      expect(Math.abs(t[3] ?? 0)).toBe(1);
    }
    // Authored normals are published verbatim, zeros included.
    expect(mesh.attributes.normal).toEqual(normal);
  });

  it('normalizes authored normals before deriving the tangent frame', () => {
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const normal = new Float32Array([0, 0, 5, 0, 0, 5, 0, 0, 5]);
    const uv = new Float32Array([0, 0, 1, 0, 1, 1]);
    const mesh = createMeshBuilder({ attributes: { position, normal, uv }, indices: [0, 1, 2] })
      .build()
      .unwrap();
    expect(Array.from(mesh.attributes.tangent as Float32Array)).toEqual([
      1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1,
    ]);
  });

  it('completes triangle submeshes that share a stream with lines and strips', () => {
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    for (const submeshes of [
      [
        { indexOffset: 0, indexCount: 6, topology: 'triangle-list' as const, materialSlot: 0 },
        { indexOffset: 6, indexCount: 2, topology: 'line-list' as const, materialSlot: 1 },
      ],
      [{ indexOffset: 0, indexCount: 4, topology: 'triangle-strip' as const, materialSlot: 0 }],
    ]) {
      const strip = submeshes[0]?.topology === 'triangle-strip';
      const mesh = createMeshBuilder({
        attributes: { position },
        indices: strip ? [0, 1, 3, 2] : [0, 1, 2, 0, 2, 3, 0, 2],
        submeshes,
        materialSlots: [{ slotName: 'surface' }, { slotName: 'edges' }],
      })
        .build()
        .unwrap();
      expect(Array.from(mesh.attributes.normal as Float32Array)).toEqual(
        Array.from({ length: 4 }, () => [0, 0, 1]).flat(),
      );
      expect(mesh.attributes.uv).toEqual(new Float32Array(8));
      expect((mesh.attributes.tangent as Float32Array).length).toBe(16);
    }
    // Point/line-only meshes keep exactly their authored attributes.
    const lines = createMeshBuilder({
      attributes: { position },
      indices: [0, 1, 2, 3],
      submeshes: [{ topology: 'line-list' }],
    })
      .build()
      .unwrap();
    expect(Object.keys(lines.attributes)).toEqual(['position']);
  });

  it('returns authored attribute arrays untouched when the surface stream is complete', () => {
    const attributes = {
      position: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
      normal: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      uv: new Float32Array(6),
      tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    };
    const mesh = createMeshBuilder({ attributes, indices: [0, 1, 2] })
      .build()
      .unwrap();
    expect(mesh.attributes).toEqual(attributes);
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

it('captures one attribute batch before validating and retaining its private copy', () => {
  let reads = 0;
  const builder = createMeshBuilder();
  const position = trianglePositions.slice();
  const appended = builder.appendVertices({
    get position() {
      reads++;
      return reads === 1 ? position : new Float32Array([Number.NaN]);
    },
  });
  expect(appended.ok).toBe(true);
  position.fill(Number.NaN);
  const mesh = builder.build().unwrap();
  expect(reads).toBe(1);
  expect(mesh.attributes.position).toEqual(trianglePositions);
  (mesh.attributes.position as Float32Array).fill(Number.NaN);
  expect(builder.build().unwrap().attributes.position).toEqual(trianglePositions);
});
