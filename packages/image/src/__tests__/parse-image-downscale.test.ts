import { describe, expect, it } from 'vitest';
import { parseImage } from '../parse-image.js';
import { makeJpg } from './make-fixture.js';

describe('parseImage asset-owned downscale', () => {
  it('emits an aspect-preserving cooked payload under the declared target', async () => {
    const result = parseImage(makeJpg(2, 2, [255, 0, 0, 255]), 'image/jpeg', {
      downscaleMaxDimension: 1,
      maxDimension: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.width).toBe(1);
    expect(result.value.height).toBe(1);
    expect(result.value.bytes).toHaveLength(4);
  });

  it('keeps current hard-bound behavior when no downscale target is declared', async () => {
    const result = parseImage(makeJpg(2, 2, [255, 0, 0, 255]), 'image/jpeg', { maxDimension: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('image-dimension-out-of-bounds');
  });
});
