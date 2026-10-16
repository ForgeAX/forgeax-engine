import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('glTF asset-local artifacts', () => {
  it('keeps image decoding injected and emits artifacts on the produced asset rows', () => {
    const source = readFileSync(new URL('../gltf-importer.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^import .*engine-image/m);
    expect(source).toContain('artifacts: {');
    expect(source).toContain('refs:');
  });
});
