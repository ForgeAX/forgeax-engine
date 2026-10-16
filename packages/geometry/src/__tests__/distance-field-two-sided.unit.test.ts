import { assert, expect, it } from 'vitest';
import { buildMeshDistanceField, sampleMeshDistanceField } from '../distance-field';
import {
  decodeMeshDistanceField,
  encodeMeshDistanceField,
  validateMeshDistanceField,
} from '../distance-field-artifact';
import { createTriangleQuery, type QueryTriangle } from '../triangle-query';

function sheet(divisions: number) {
  const positions: number[] = [],
    indices: number[] = [];
  for (let y = 0; y <= divisions; y++)
    for (let x = 0; x <= divisions; x++)
      positions.push((2 * x) / divisions - 1, (2 * y) / divisions - 1, 0);
  for (let y = 0; y < divisions; y++)
    for (let x = 0; x < divisions; x++) {
      const a = y * (divisions + 1) + x,
        b = a + divisions + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  return { positions, indices };
}

it('requires explicit two-sided policy and bounds distance to a zero-thickness rectangle', async () => {
  const { positions, indices } = sheet(32); // 2048 triangles exceeds the signed spike limit.
  expect((await buildMeshDistanceField(positions, indices)).ok).toBe(false);
  const field = (
    await buildMeshDistanceField(positions, indices, { resolution: 24, twoSided: true })
  ).unwrap();
  expect(field.policy.kind).toBe('two-sided');
  expect(field.quality.negativeSamples).toBe(0);
  expect(field.quality.testedTriangles).toBe(2048);
  expect(field.values.every((v) => v >= 0)).toBe(true);
  for (let i = 0; i < 1000; i++) {
    const p = [
      Math.sin(i * 1.23) * 1.06,
      Math.cos(i * 2.11) * 1.06,
      Math.sin(i * 0.71) * 0.07,
    ] as const;
    const exact = Math.hypot(
      Math.max(Math.abs(p[0]) - 1, 0),
      Math.max(Math.abs(p[1]) - 1, 0),
      p[2],
    );
    const sample = sampleMeshDistanceField(field, p);
    assert(sample !== null);
    expect(Math.abs(sample - exact)).toBeLessThanOrEqual(field.policy.errorBound);
    expect(sample - field.policy.errorBound).toBeLessThanOrEqual(exact);
  }
  const reverse = (
    await buildMeshDistanceField(positions, [...indices].reverse(), {
      resolution: 24,
      twoSided: true,
    })
  ).unwrap();
  expect(reverse.values).toEqual(field.values);
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  const loaded = (await decodeMeshDistanceField(bytes, field.meshDigest)).unwrap();
  expect(loaded).toEqual(field);
  expect(
    validateMeshDistanceField({ ...field, policy: { ...field.policy, kind: 'signed-solid' } }).ok,
  ).toBe(false);
  const negative = field.values.slice();
  negative[0] = -1;
  expect(
    validateMeshDistanceField({
      ...field,
      values: negative,
      quality: { ...field.quality, negativeSamples: 1 },
    }).ok,
  ).toBe(false);
});

it('keeps an exact closest-distance result separate from query budget exhaustion', () => {
  const triangle: QueryTriangle = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ];
  const query = createTriangleQuery(Array.from({ length: 30 }, () => triangle));
  expect(query.nearestSquared([0.1, 0.2, 1], Infinity, { remaining: 29 })).toBeNull();
  expect(query.nearestSquared([0.1, 0.2, 1], Infinity, { remaining: 30 })).toBe(1);
});

it('rejects pathological overlapping geometry when the field cook exhausts its per-sample budget', async () => {
  const { positions, indices } = sheet(1);
  const overlap = Array.from({ length: 2048 }, () => indices).flat();
  const result = await buildMeshDistanceField(positions, overlap, {
    resolution: 64,
    twoSided: true,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('distance-field-limit');
    expect(result.error.detail.reason).toBe('closest-point preparation budget exhausted');
  }
});
