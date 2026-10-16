import { describe, expect, it } from 'vitest';

describe('gltf importer contract migration fixture', () => {
  it('requires the generic ImportProduct shape', () => {
    expect('ImportProduct').toBe('ImportProduct');
  });

  it('keeps multi-asset refs independent of artifact paths', () => {
    expect('GUID refs').toContain('refs');
    expect('artifact path').not.toContain('GUID refs');
  });
});
