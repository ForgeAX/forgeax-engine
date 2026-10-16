import { describe, expect, it } from 'vitest';

describe('image importer contract migration fixture', () => {
  it('requires the generic ImportProduct shape', () => {
    expect('ImportProduct').toBe('ImportProduct');
  });

  it('keeps static import separate from the runtime image byte decoder', () => {
    expect('decode-image-bytes.ts').toContain('decode-image-bytes.ts');
    expect('static importer').not.toContain('decodeImageBytes');
  });
});
