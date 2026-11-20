import { violatedVariantPermutationRules } from '@forgeax/engine-shader';
import { expect } from 'vitest';

interface StandardSelection {
  readonly defines: Readonly<Record<string, boolean>>;
  readonly definesKey: string;
}

export function generalComparison<T extends StandardSelection>(
  variant: T,
  byKey: ReadonlyMap<string, T>,
): T {
  const generalDefines: Record<string, boolean> = {
    ...variant.defines,
    STANDARD_LEAN_INPUTS: false,
  };
  for (const rule of violatedVariantPermutationRules(generalDefines)) {
    if (
      rule.axis !== 'WATER_INFO_RGBA16' ||
      rule.value !== false ||
      generalDefines.WATER_WAVES_AVAILABLE !== false
    ) {
      throw new Error(`unsupported general comparison for ${variant.definesKey}`);
    }
    generalDefines[rule.axis] = rule.value;
  }
  const general = byKey.get(
    variant.definesKey
      .replace('STANDARD_LEAN_INPUTS=true', 'STANDARD_LEAN_INPUTS=false')
      .replace(
        `WATER_INFO_RGBA16=${variant.defines.WATER_INFO_RGBA16}`,
        `WATER_INFO_RGBA16=${generalDefines.WATER_INFO_RGBA16}`,
      ),
  );
  if (general === undefined) throw new Error(`missing general row for ${variant.definesKey}`);
  expect(general.defines).toEqual(generalDefines);
  return general;
}

export function validateStandardLeanRoster<T extends Pick<StandardSelection, 'defines'>>(
  variants: readonly T[],
  declared: readonly Readonly<Record<string, boolean>>[],
): T[] {
  const expectedLean = declared.filter((defines) => defines.STANDARD_LEAN_INPUTS === true);
  const lean = variants.filter((variant) => variant.defines.STANDARD_LEAN_INPUTS === true);
  expect(lean.map((variant) => variant.defines)).toEqual(expectedLean);
  for (const waves of [false, true]) {
    for (const rgba16 of [false, true]) {
      const lane = lean.filter(
        (variant) =>
          variant.defines.WATER_WAVES_AVAILABLE === waves &&
          variant.defines.WATER_INFO_RGBA16 === rgba16,
      );
      expect(lane).toHaveLength(640);
      const added = lane.filter(
        ({ defines }) => !defines.DIRECTIONAL_SHADOW_SIMPLE && defines.LEAN_LIGHTING,
      );
      expect(added).toHaveLength(32);
      expect(lane.filter((row) => !added.includes(row))).toHaveLength(608);
    }
  }
  return lean;
}
