import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';

describe('GPU-driven Standard PBR contract', () => {
  it('keeps the producer receipt as the source of scene-index ABI facts', () => {
    const receipt = createStandardPbrArtifactReceipt();
    expect(receipt.directEntry).toBe('vs_main');
    expect(receipt.sceneIndexEntry).toBe('vs_scene_index');
    expect(receipt.resourceSlots).toHaveLength(24);
    expect(receipt.alphaMask.cutoff).toBe('alphaCutoff');
    expect(receipt.alphaMask.source).toBe('baseColor.a');
    expect(receipt.reflection.layoutIdentity).toBe(receipt.receiptIdentity);
  });

  it('keeps Alpha Blend outside the opaque and Alpha Mask GPU lane', () => {
    expect(createStandardPbrArtifactReceipt().alphaMask.cutoff).toBe('alphaCutoff');
    expect(createStandardPbrArtifactReceipt().resourceSlots.every((slot) => slot.group === 1)).toBe(
      true,
    );
  });
});
