import { readFileSync } from 'node:fs';
import { violatedVariantPermutationRules } from '@forgeax/engine-shader';
import { publishedVariantDefines } from '@forgeax/engine-vite-plugin-shader';
import { transpile } from 'typescript';
import { expect, it } from 'vitest';

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

function originalGeneralComparison() {
  const fixture = readFileSync(new URL('gpu-driven-pbr.dawn.test.ts', import.meta.url), 'utf8');
  const original = fixture.slice(fixture.indexOf("it('validates every STANDARD_LEAN_INPUTS row"));
  const comparison =
    / {4}const general(?:Defines)?(?:: Record<string, boolean>)? = [\s\S]*?(?=\n {4}const fields =)/.exec(
      original,
    )?.[0];
  if (comparison === undefined) throw new Error('Missing original general row comparison');
  return new Function(
    'variant',
    'byKey',
    'violatedVariantPermutationRules',
    'expect',
    `${transpile(comparison)}\nreturn general;`,
  );
}

it('compares every lean row with its exact published general Water format row', () => {
  const compare = originalGeneralComparison();
  const byKey = new Map(publishedVariants.map((variant) => [variant.definesKey, variant]));
  const lean = publishedVariants.filter((variant) => variant.defines.STANDARD_LEAN_INPUTS);
  const normalized = lean.filter(
    (variant) => !variant.defines.WATER_WAVES_AVAILABLE && variant.defines.WATER_INFO_RGBA16,
  );
  expect(normalized).toHaveLength(288);
  for (const variant of lean) {
    const general = compare(variant, byKey, violatedVariantPermutationRules, expect);
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
  const compare = originalGeneralComparison();
  const byKey = new Map(publishedVariants.map((variant) => [variant.definesKey, variant]));
  const variant = publishedVariants.find(
    (row) =>
      row.defines.STANDARD_LEAN_INPUTS &&
      !row.defines.WATER_WAVES_AVAILABLE &&
      row.defines.WATER_INFO_RGBA16,
  );
  if (variant === undefined) throw new Error('Missing maintained lean Water format lane');
  const general = compare(variant, byKey, violatedVariantPermutationRules, expect);
  byKey.delete(general.definesKey);
  expect(() => compare(variant, byKey, violatedVariantPermutationRules, expect)).toThrow(
    'missing general row',
  );
  byKey.set(general.definesKey, {
    ...general,
    defines: { ...general.defines, WATER_WAVES_AVAILABLE: true },
  });
  expect(() => compare(variant, byKey, violatedVariantPermutationRules, expect)).toThrow();
});

it('rejects unrelated permutation violations in the general comparison', () => {
  const compare = originalGeneralComparison();
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
  expect(() => compare(invalid, new Map(), violatedVariantPermutationRules, expect)).toThrow(
    'unsupported general comparison',
  );
});

it('keeps every published lean row and the four maintained Water compile lanes', () => {
  const source = readFileSync(
    new URL('../../../shader/src/default-standard-pbr.wgsl', import.meta.url),
    'utf8',
  );
  const rows = publishedVariantDefines(source);
  const lean = rows.filter((row) => row.STANDARD_LEAN_INPUTS === true);
  expect(lean).toHaveLength(4 * 288);
  for (const waves of [false, true]) {
    for (const rgba16 of [false, true]) {
      expect(
        lean.filter(
          (row) => row.WATER_WAVES_AVAILABLE === waves && row.WATER_INFO_RGBA16 === rgba16,
        ),
      ).toHaveLength(288);
    }
  }
  expect(
    lean.every(
      (row) =>
        row.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true && row.STORAGE_BUFFER_AVAILABLE === true,
    ),
  ).toBe(true);
  const fixture = readFileSync(new URL('gpu-driven-pbr.dawn.test.ts', import.meta.url), 'utf8');
  const gate = / {2}const (?:expectedLean|lean) = [\s\S]*?(?=\n {2}const adapter)/.exec(
    fixture.slice(fixture.indexOf("it('validates every STANDARD_LEAN_INPUTS row")),
  )?.[0];
  if (gate === undefined) throw new Error('Missing original lean roster gate');
  const validate = new Function(
    'standard',
    'publishedVariantDefines',
    'STANDARD_PBR_SOURCE',
    'expect',
    gate,
  );
  const variants = rows.map((defines) => ({ defines }));
  const publishedRows = () => rows;
  expect(() => validate({ variants }, publishedRows, source, expect)).not.toThrow();
  const missing = variants.filter((row) => row.defines !== lean[0]);
  expect(() => validate({ variants: missing }, publishedRows, source, expect)).toThrow();
  const duplicate = [...missing, { defines: lean[1] }];
  expect(() => validate({ variants: duplicate }, publishedRows, source, expect)).toThrow();
});
