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
  const lean = publishedRows.filter((row) => row.STANDARD_LEAN_INPUTS === true);
  expect(
    lean.every(
      (row) =>
        row.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true && row.STORAGE_BUFFER_AVAILABLE === true,
    ),
  ).toBe(true);
  expect(() => validateStandardLeanRoster(publishedVariants, publishedRows)).not.toThrow();
  const [first, second] = publishedVariants.filter((row) => row.defines.STANDARD_LEAN_INPUTS);
  if (first === undefined || second === undefined) throw new Error('Missing maintained lean rows');
  const missing = publishedVariants.filter((row) => row !== first);
  expect(() => validateStandardLeanRoster(missing, publishedRows)).toThrow();
  const duplicate = [...missing, second];
  expect(() => validateStandardLeanRoster(duplicate, publishedRows)).toThrow();
});
