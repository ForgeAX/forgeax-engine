import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

describe('volumetric fog Vite pack route', () => {
  it('keeps the selected light and density in the JSON pack path', () => {
    expect(source).toContain('createRuntimeAssetImportTransport');
    expect(source).toContain('spawnVolumetricSpot');
    expect(source).toContain('densityHandle');
  });

  it('does not create a presentation-only beam shader or volume stand-in', () => {
    expect(source).not.toContain('screen-space');
    expect(source).not.toContain('fakeBeam');
    expect(source).not.toContain('volumeShader');
  });
});
