import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const capabilitySource = readFileSync(new URL('../volume/capability.ts', import.meta.url), 'utf8');

describe('volumetric fog light consumers', () => {
  it('consume selected-light projection through the real-light resolvers', () => {
    expect(capabilitySource).toContain('resolveSelectedVolumetricLight');
    expect(capabilitySource).toContain('resolveVolumetricFogLightPair');
    expect(capabilitySource).not.toContain('VolumetricFogDirectionalLight');
    expect(capabilitySource).not.toContain('VolumetricFogCsmSnapshot');
  });

  it('keeps the integrated result as the only consumer resource identity', () => {
    expect(capabilitySource).toContain("identity: 'volume-integrated'");
    expect(capabilitySource).not.toContain('pointLights');
  });
});
