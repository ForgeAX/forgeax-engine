import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Standard PBR fallback graph integration contract', () => {
  it('keeps the fallback output at the canonical BRDF callsite', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../shader/src/standard-surface.wgsl'),
      'utf8',
    );
    expect(source).toContain('sampleIblDiffuse');
    expect(source).toContain('sampleIblSpecular');
    expect(source).toContain('S_fallback');
    expect(source).toContain('REFLECTION_FALLBACK_AVAILABLE');
  });

  it('does not introduce SSR history, trace, or depth-pyramid work', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../shader/src/standard-surface.wgsl'),
      'utf8',
    );
    expect(source).not.toMatch(/ssrHistory|rayMarch|depthPyramid|hiz|hi-z/i);
  });
});
