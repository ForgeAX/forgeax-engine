import { assert, describe, expect, it } from 'vitest';
import { buildMeshDistanceField, sampleMeshDistanceField } from '../distance-field';

const positions = [
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
];
const indices = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6,
  1, 6, 5,
];
describe('mesh distance-field derived representation', () => {
  it('rejects inward winding before publishing a field', async () => {
    expect(
      (await buildMeshDistanceField(positions, [...indices].reverse(), { resolution: 12 })).ok,
    ).toBe(false);
  });
  it('bounds trilinear error against an independent analytic box and owns source data', async () => {
    const source = positions.slice();
    const field = (await buildMeshDistanceField(source, indices, { resolution: 16 })).unwrap();
    source[0] = 99;
    expect(field.bounds.min).toEqual([-1, -1, -1]);
    expect(field.values.byteLength + field.bricks.byteLength).toBeLessThan(32 * 1024 * 1024);
    for (let i = 0; i < 300; i++) {
      const p = [
        Math.sin(i * 1.23) * 1.08,
        Math.cos(i * 2.11) * 1.08,
        Math.sin(i * 0.71) * 1.08,
      ] as const;
      const q = p.map((v) => Math.abs(v) - 1),
        exact = Math.hypot(...q.map((v) => Math.max(v, 0))) + Math.min(Math.max(...q), 0);
      const sample = sampleMeshDistanceField(field, p);
      assert(sample !== null);
      expect(Math.abs(sample - exact)).toBeLessThanOrEqual(field.policy.errorBound);
    }
    expect(sampleMeshDistanceField(field, [0, 0, 0])).toBeCloseTo(-1, 5);
    expect(sampleMeshDistanceField(field, [10, 0, 0])).toBeNull();
    const again = (await buildMeshDistanceField(positions, indices, { resolution: 16 })).unwrap();
    expect(again.meshDigest).toBe(field.meshDigest);
    expect(again.values).toEqual(field.values);
    const translated = positions.map((v, i) => v + (i % 3 === 0 ? 0.5 : 0));
    expect(
      (await buildMeshDistanceField(translated, indices, { resolution: 16 })).unwrap().meshDigest,
    ).not.toBe(field.meshDigest);
  });
  it('welds attribute seams but rejects open, degenerate and inconsistent topology', async () => {
    const expanded = indices.flatMap((i) => positions.slice(i * 3, i * 3 + 3));
    expect(
      (
        await buildMeshDistanceField(
          expanded,
          indices.map((_, i) => i),
          { resolution: 8 },
        )
      ).ok,
    ).toBe(true);
    for (const invalid of [
      indices.slice(3),
      [...indices, 0, 1, 2],
      [0, 0, 1, ...indices.slice(3)],
      [0, 1, 2, ...indices.slice(3)],
    ])
      expect((await buildMeshDistanceField(positions, invalid, { resolution: 8 })).ok).toBe(false);
  });
  it('rejects unresolved thin solids and recovers at higher resolution', async () => {
    const thin = positions.map((v, i) => (i % 3 === 1 ? v * 0.045 : v));
    const low = await buildMeshDistanceField(thin, indices, { resolution: 8 });
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.error.code).toBe('distance-field-unsupported');
    const high = await buildMeshDistanceField(thin, indices, { resolution: 48 });
    expect(high.ok, high.ok ? undefined : high.error.detail.reason).toBe(true);
  });
  it('rejects malformed and excessive inputs before allocation', async () => {
    for (const resolution of [0, 7, 65, NaN, 8.5])
      expect(
        (await buildMeshDistanceField(positions, indices, { resolution: resolution })).ok,
      ).toBe(false);
    expect((await buildMeshDistanceField([NaN, ...positions.slice(1)], indices)).ok).toBe(false);
    expect((await buildMeshDistanceField(positions, [999, ...indices.slice(1)])).ok).toBe(false);
  });
});
