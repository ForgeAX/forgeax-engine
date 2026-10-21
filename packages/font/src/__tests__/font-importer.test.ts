import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fontImporter } from '../font-importer.js';

describe('font importer contract', () => {
  it('dispatches through the font importer key', () => {
    expect(fontImporter.key).toBe('font');
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain("meta.importer: 'font'");
    expect(readme).not.toContain("assetType: 'font'");
  });
});
