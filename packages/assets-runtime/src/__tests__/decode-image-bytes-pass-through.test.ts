// @forgeax/engine-assets-runtime -- decoder error pass-through regression

import type { ImageError } from '@forgeax/engine-types';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { decodeImageBytes } from '../decode-image-bytes';

vi.mock('@forgeax/engine-image', () => ({
  decodeImageInBrowser: vi.fn(),
}));

describe('decodeImageBytes decoder error pass-through', () => {
  it('returns the decoder ImageError object unchanged', async () => {
    const { decodeImageInBrowser } = await import('@forgeax/engine-image');
    const decoderError = {
      name: 'ImageError',
      message: 'decoder failure',
      code: 'image-decode-failed',
      expected: 'decoder expected',
      hint: 'decoder hint',
      detail: {
        code: 'image-decode-failed',
        reason: 'decoder failure',
      },
    } as ImageError;
    vi.mocked(decodeImageInBrowser).mockResolvedValue(err(decoderError));

    const result = await decodeImageBytes(new Uint8Array([1]), 'image/png');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(decoderError);
  });
});
