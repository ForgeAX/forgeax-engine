import { readFileSync } from 'node:fs';
import { publishedVariantDefines } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { generalComparison, validateStandardLeanRoster } from './standard-lean-oracle.fixture';

const standardSource = readFileSync(
  new URL('../../../shader/src/default-standard-pbr.wgsl', import.meta.url),
  'utf8',
);
const publishedRows = publishedVariantDefines(standardSource);
const variantKey = (defines: Readonly<Record<string, boolean>>) =>
  Object.entries(defines)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([axis, value]) => `${axis}=${value}`)
    .join('+');
const publishedVariants = publishedRows.map((defines) => ({
  defines,
  definesKey: variantKey(defines),
}));

it('compares every lean row with its exact published general Water format row', () => {
  const byKey = new Map(publishedVariants.map((variant) => [variant.definesKey, variant]));
  const lean = publishedVariants.filter((variant) => variant.defines.STANDARD_LEAN_INPUTS);
  const normalized = lean.filter(
    (variant) => !variant.defines.WATER_WAVES_AVAILABLE && variant.defines.WATER_INFO_RGBA16,
  );
  expect(normalized).toHaveLength(640);
  const added = normalized.filter(
    ({ defines }) => !defines.DIRECTIONAL_SHADOW_SIMPLE && defines.LEAN_LIGHTING,
  );
  expect(added).toHaveLength(32);
  expect(normalized.filter((row) => !added.includes(row))).toHaveLength(608);
  for (const variant of lean) {
    const general = generalComparison(variant, byKey);
    expect(general.defines).toEqual({
      ...variant.defines,
      STANDARD_LEAN_INPUTS: false,
      WATER_INFO_RGBA16: variant.defines.WATER_WAVES_AVAILABLE
        ? variant.defines.WATER_INFO_RGBA16
        : false,
    });
  }
});

it('rejects missing or mismatched general rows instead of selecting another published row', () => {
  const byKey = new Map(publishedVariants.map((variant) => [variant.definesKey, variant]));
  const variant = publishedVariants.find(
    (row) =>
      row.defines.STANDARD_LEAN_INPUTS &&
      !row.defines.WATER_WAVES_AVAILABLE &&
      row.defines.WATER_INFO_RGBA16,
  );
  if (variant === undefined) throw new Error('Missing maintained lean Water format lane');
  const general = generalComparison(variant, byKey);
  byKey.delete(general.definesKey);
  expect(() => generalComparison(variant, byKey)).toThrow('missing general row');
  byKey.set(general.definesKey, {
    ...general,
    defines: { ...general.defines, WATER_WAVES_AVAILABLE: true },
  });
  expect(() => generalComparison(variant, byKey)).toThrow();
});

it('rejects unrelated permutation violations in the general comparison', () => {
  const variant = publishedVariants.find((row) => row.defines.STANDARD_LEAN_INPUTS);
  if (variant === undefined) throw new Error('Missing lean row');
  const invalid = {
    ...variant,
    defines: {
      ...variant.defines,
      STORAGE_BUFFER_AVAILABLE: false,
      WATER_WAVES_AVAILABLE: true,
    },
  };
  expect(() => generalComparison(invalid, new Map())).toThrow('unsupported general comparison');
});

it('keeps every published lean row and the four maintained Water compile lanes', () => {
  const source = readFileSync(
    new URL('../../../shader/src/default-standard-pbr.wgsl', import.meta.url),
    'utf8',
  );
  const rows = publishedVariantDefines(source);
  const lean = rows.filter((row) => row.STANDARD_LEAN_INPUTS === true);
  expect(lean).toHaveLength(4 * 640);
  for (const waves of [false, true]) {
    for (const rgba16 of [false, true]) {
      const lane = lean.filter(
        (row) => row.WATER_WAVES_AVAILABLE === waves && row.WATER_INFO_RGBA16 === rgba16,
      );
      expect(lane).toHaveLength(640);
      // Camera clipping adds its full general-lighting domain; simplified
      // shadow/lighting selections retain their unclipped admission.
      expect(lane.filter((row) => row.CLIPPING_PLANES)).toHaveLength(256);
      expect(lane.filter((row) => !row.CLIPPING_PLANES)).toHaveLength(384);
      const added = lane.filter((row) => !row.DIRECTIONAL_SHADOW_SIMPLE && row.LEAN_LIGHTING);
      expect(added).toHaveLength(32);
      expect(lane.filter((row) => !added.includes(row))).toHaveLength(608);
    }
  }
  expect(
    lean.every(
      (row) =>
        row.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true && row.STORAGE_BUFFER_AVAILABLE === true,
    ),
  ).toBe(true);
  const variants = rows.map((defines) => ({ defines }));
  expect(() => validateStandardLeanRoster(variants, rows)).not.toThrow();
  const missing = variants.filter((row) => row.defines !== lean[0]);
  expect(() => validateStandardLeanRoster(missing, rows)).toThrow();
  const duplicate = [...missing, { defines: lean[1] }];
  expect(() => validateStandardLeanRoster(duplicate, rows)).toThrow();
});
