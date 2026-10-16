import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const volumeInject = readFileSync(new URL('../volume/volume-inject.wgsl', import.meta.url), 'utf8');
const volumeIntegrate = readFileSync(
  new URL('../volume/volume-integrate.wgsl', import.meta.url),
  'utf8',
);

describe('volume Spot attenuation precision', () => {
  it('keeps the shared finite-range attenuation monotonic', () => {
    expect(volumeInject).not.toContain('evalSpotAttenuation');
    expect(volumeInject).not.toContain('attenuation * cone_distance');
    expect(volumeInject).toContain('spot_shadow_visibility_at');
    expect(volumeIntegrate).toContain('evalSpotAttenuation');
    expect(volumeIntegrate).toContain('spot_attenuation_at');
    expect(volumeIntegrate).toContain('light.position.w');
    // The paired Point+Spot owner applies visibility only to the Spot term;
    // the Point radiance remains independent of the spot shadow. Keep the
    // assertion at the semantic call boundary so WGSL formatting changes do
    // not turn this contract test into a stale substring check.
    expect(volumeIntegrate).toContain('volume_light_radiance_pair(world_position, visibility)');
    expect(volumeIntegrate).toContain('volume_spot_radiance(world_position) *');
    expect(volumeIntegrate).toContain('mix(1.0, spot_visibility, volume_spot_shadow_intensity())');
  });
});
