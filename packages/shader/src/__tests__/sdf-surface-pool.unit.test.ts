import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/index';
import { SDF_SURFACE_POOL_LAYOUT, SDF_SURFACE_POOL_WGSL } from '../sdf-surface-pool-wgsl';
import { surfacePoolCases, surfacePoolVariants } from './sdf-surface-pool.fixture';

it('keeps one private packet layout and binding-free decoder independent of asset codec numbering', () => {
  expect(SDF_SURFACE_POOL_LAYOUT).toEqual({
    magic: 0x53534650,
    version: 4,
    indexedVersion: 0x80000004,
    candidateMagic: 0x53434256,
    candidateFooterWords: 8,
    sceneWords: 4,
    rowWords: 20,
    coverageRecordWords: 4,
    coveragePayloadWords: 4,
    coverageMagic: 0x53434f56,
    instanceWords: 36,
    maxRows: 1024,
    maxBytes: 16 * 1024 * 1024,
    maxVertices: 1_048_576,
    maxPrimitives: 1_048_576,
    maxNodes: 2_097_151,
    candidateRowWords: 8,
    candidateNodeWords: 8,
  });
  expect(SDF_SURFACE_POOL_WGSL).not.toMatch(/@binding|@group|var<storage|bitcast<f32>/);
  expect(SDF_SURFACE_POOL_WGSL).toContain('scene.z!=capacity');
  expect(SDF_SURFACE_POOL_WGSL).toContain('scene.w>count');
});
it('authored metadata controls distinguish a live row after a hole and reject source padding assumptions', () => {
  const cases = surfacePoolCases();
  expect(cases.length).toBe(38);
  expect(cases.find((row) => row.name === 'source-lattice-prefix-eligible')?.expected[23]).toBe(1);
  expect(cases.find((row) => row.name === 'old-private-version1-not-mixed')?.expected[0]).toBe(0);
  expect(cases.find((row) => row.name === 'old-private-version2-not-mixed')?.expected[0]).toBe(0);
  expect(new Set(cases.map((row) => row.name)).size).toBe(cases.length);
  expect(cases.find((row) => row.name === 'live-row1-after-hole')?.expected[0]).toBe(1);
  expect(cases.find((row) => row.name === 'disabled-row-header')?.expected[0]).toBe(0);
  expect(cases.find((row) => row.name === 'logical-field-span-truncated')?.fieldCount).toBe(87);
  expect(
    cases
      .find((row) => row.name === 'positive-minnormal-relative3-absoluteHalf')
      ?.expected.slice(18, 21),
  ).toEqual([0x00800000, 0x40400000, 0x3f000000]);
  for (const row of cases) expect(row.expected).toHaveLength(24);
});
it('negative variants really modify the executed tail guard and logical source count', () => {
  const variants = surfacePoolVariants();
  expect(variants).toHaveLength(4);
  expect(variants[2]?.source).not.toBe(variants[0]?.source);
  expect(variants[3]?.source).not.toBe(variants[1]?.source);
});

it('maps positive authored V4 metadata to literal row, coverage and aligned span fields', () => {
  for (const row of surfacePoolCases().filter((entry) => entry.expected[0] === 1)) {
    const first = 4 + row.row * 20;
    expect(Array.from(row.fields.subarray(0, 4)), row.name).toEqual([0x53534650, 4, 2, 88]);
    expect(row.fieldCount, row.name).toBe(89);
    expect(row.fields[first + 3], row.name).toBe(44 + row.row * 4);
    expect(Array.from(row.fields.subarray(44 + row.row * 4, 48 + row.row * 4)), row.name).toEqual([
      row.row,
      1,
      0,
      0,
    ]);
    expect(Array.from(row.fields.subarray(first, first + 2)), row.name).toEqual(
      row.expected.slice(4, 6),
    );
    expect(Array.from(row.fields.subarray(first + 4, first + 6)), row.name).toEqual(
      row.expected.slice(6, 8),
    );
    expect(Array.from(row.fields.subarray(first + 8, first + 18)), row.name).toEqual(
      row.expected.slice(8, 18),
    );
    expect([row.fields[first + 6], row.fields[first + 18], row.fields[first + 19]]).toEqual(
      row.expected.slice(18, 21),
    );
    expect(row.fields[84], row.name).toBe(1);
    expect(row.fields[88], row.name).toBe(0xffffffff);
  }
});

it('compiles the production packet decoder through both actual metadata adapters and controls', async () => {
  for (const variant of surfacePoolVariants())
    expect((await compileShader(variant.source, { id: `pool-${variant.name}` })).ok).toBe(true);
});
