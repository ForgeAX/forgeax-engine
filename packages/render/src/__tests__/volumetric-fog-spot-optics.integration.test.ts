import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const volumeInject = readFileSync(
  new URL('../../../shader/src/volume/volume-inject.wgsl', import.meta.url),
  'utf8',
);
const volumeIntegrate = readFileSync(
  new URL('../../../shader/src/volume/volume-integrate.wgsl', import.meta.url),
  'utf8',
);
const punctual = readFileSync(
  new URL('../../../shader/src/lighting-punctual.wgsl', import.meta.url),
  'utf8',
);

describe('Spot volume optics integration', () => {
  it('uses the same distance and cone helper as surface lighting', () => {
    expect(volumeIntegrate).toContain('fn evalSpotAttenuation');
    expect(volumeIntegrate).toContain('evalSpotAttenuation');
    expect(punctual).toContain('evalSpotAttenuation');
  });

  it('does not derive volume radiance from luminaire geometry', () => {
    expect(volumeInject).not.toContain('emitter');
    expect(volumeInject).not.toContain('mesh');
    expect(volumeInject).not.toContain('luminaire');
  });
});
