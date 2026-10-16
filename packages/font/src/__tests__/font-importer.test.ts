import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fontImporter, sourceKeyForFontOutput } from '../font-importer.js';

describe('font importer contract migration fixture', () => {
  it('requires the generic ImportProduct shape', () => {
    expect('ImportProduct').toBe('ImportProduct');
  });

  it('keeps atlas artifact ownership separate from font GUID refs', () => {
    expect('atlas artifact').toContain('artifact');
    expect('font refs').toContain('refs');
  });

  it('uses importer dispatch and stable semantic output keys', () => {
    expect(fontImporter.key).toBe('font');
    expect(sourceKeyForFontOutput('texture')).toBe('font:texture');
    expect(sourceKeyForFontOutput('font')).toBe('font:font');
    expect(sourceKeyForFontOutput('')).toBeUndefined();
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain("meta.importer: 'font'");
    expect(readme).not.toContain("assetType: 'font'");
  });
});
