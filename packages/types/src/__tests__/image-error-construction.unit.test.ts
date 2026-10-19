import { describe, expect, it } from 'vitest';
import { IMAGE_ERROR_EXPECTED, IMAGE_ERROR_HINTS, ImageErrorImpl, imageError } from '../index';

describe('image error construction', () => {
  it('retains the code/detail pair and decoder precondition', () => {
    const detail = { code: 'image-decode-failed', reason: 'truncated source' } as const;
    const error = imageError(detail);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ImageErrorImpl);
    expect(error.name).toBe('ImageError');
    expect(error.code).toBe(detail.code);
    expect(error.detail).toBe(detail);
    expect(error.expected).toBe(IMAGE_ERROR_EXPECTED[detail.code]);
    expect(error.hint).toBe(IMAGE_ERROR_HINTS[detail.code]);
  });

  it('reports the consumer precondition in both structured and text diagnostics', () => {
    const error = imageError(
      { code: 'image-format-unsupported', actualMime: 'image/gif' },
      'PNG only',
    );
    expect(error.expected).toBe('PNG only');
    expect(error.message).toContain('expected: PNG only;');
    expect(error.hint).toBe(IMAGE_ERROR_HINTS['image-format-unsupported']);
    expect(imageError({ code: 'atlas-empty-input', receivedCount: 0 }).expected).toBe(
      'images.length >= 1',
    );
  });
});
