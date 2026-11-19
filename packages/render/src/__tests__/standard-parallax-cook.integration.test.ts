import { AssetGuid } from '@forgeax/engine-pack/guid';
import { definePackageId } from '@forgeax/engine-pack/source';
import {
  STANDARD_PARALLAX_HEIGHT_DEFINE,
  STANDARD_PARALLAX_HEIGHT_PAIR,
} from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { lowerStandardContract } from '../../../shader-compiler/src/material/lower-standard-contract';
import { Materials } from '../materials';

it.each([
  'vertex',
  'parallax',
] as const)('lowers the fragment height binding for authored Standard displacement mode %s', (displacementMode) => {
  const packageId = definePackageId('019a0000-0000-7000-8000-000000000100');
  const source = Materials.standard({
    baseColor: [1, 1, 1, 1],
    baseColorTexture: AssetGuid.derive(packageId, 'texture/color'),
    normalTexture: AssetGuid.derive(packageId, 'texture/normal'),
    displacementTexture: AssetGuid.derive(packageId, 'texture/height'),
    displacementScale: 0.065,
    displacementMode,
  });

  const cooked = lowerStandardContract(source.parameters ?? [], source.passes);
  if (!cooked.ok) throw cooked.error;

  const parallax = displacementMode === 'parallax';
  expect(cooked.value.defines[STANDARD_PARALLAX_HEIGHT_DEFINE] === true).toBe(parallax);
  expect(
    cooked.value.paramSchema.some((entry) => entry.name === STANDARD_PARALLAX_HEIGHT_PAIR.host),
  ).toBe(parallax);
  expect(source.values?.[STANDARD_PARALLAX_HEIGHT_PAIR.host]).toBeUndefined();
});
