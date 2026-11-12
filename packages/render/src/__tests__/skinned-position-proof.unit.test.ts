import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { skinnedPositionProof } from '../render-system-extract';

const rigid = createStandardPbrArtifactReceipt(false);
const skinned = createStandardPbrArtifactReceipt(true);
const variant = (skinningDisabled: boolean, receipt = skinningDisabled ? rigid : skinned) => ({
  definesKey: `SKINNING_DISABLED=${skinningDisabled}`,
  defines: { SKINNING_DISABLED: skinningDisabled },
  composedWgsl: '',
  receipt,
});
const shaders = (variants: ReturnType<typeof variant>[]) => ({
  materialShaderManifestEntry: () => ({
    identifier: 'forgeax::default-shadow-caster',
    sourcePath: '',
    composedWgsl: '',
    paramSchema: '',
    variants,
  }),
});

// Regression: a skinned crowd behind the camera kept the rigid primary receipt
// of the stock ShadowCaster, lost its position proof, and every row was
// admitted (and Skin-demanded) by the classic camera cull.
it('certifies a skinned row through the Skin variants an axis program selects', () => {
  expect(skinnedPositionProof(rigid, 'k', shaders([variant(true), variant(false)]))).toBe(true);
  expect(skinnedPositionProof(skinned, 'k', shaders([]))).toBe(true);
});

it('refuses the proof when any Skin variant or the Skin receipt lacks it', () => {
  const { positionBounds: _, ...unproven } = skinned;
  expect(skinnedPositionProof(rigid, 'k', shaders([variant(true)]))).toBe(false);
  expect(
    skinnedPositionProof(rigid, 'k', shaders([variant(false), variant(false, unproven)])),
  ).toBe(false);
  expect(skinnedPositionProof(rigid, 'k', shaders([variant(false, rigid)]))).toBe(false);
  expect(skinnedPositionProof(unproven, 'k', shaders([variant(false)]))).toBe(false);
  expect(
    skinnedPositionProof(undefined, 'k', { materialShaderManifestEntry: () => undefined }),
  ).toBe(false);
});
