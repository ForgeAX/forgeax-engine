import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SkyPass } from '../record/gpu-pass-timing/sky-pass-names';

const inject = readFileSync(
  new URL('../../../shader/src/volume/volume-inject.wgsl', import.meta.url),
  'utf8',
);
const integrate = readFileSync(
  new URL('../../../shader/src/volume/volume-integrate.wgsl', import.meta.url),
  'utf8',
);
const passes = readFileSync(new URL('../volume/passes.ts', import.meta.url), 'utf8');

describe('volumetric fog Point and Spot accumulation', () => {
  it('accumulates Point and Spot in one fixed inject stage', () => {
    expect(inject).toContain('light_data');
    expect(inject).toContain('cluster_uniform');
    expect(inject).not.toContain('pointLightsBuffer');
    expect(inject).not.toContain('spotLightsBuffer');
    expect(inject).toContain('evalVolumePoint');
    expect(inject).toContain('evalVolumeSpot');
    expect(inject).toContain('shadow_visibility');
    expect(integrate).toContain('evalVolumePoint');
    expect(integrate).toContain('evalVolumeSpot');
    expect(integrate).toContain('scattering = scattering +');
  });

  it('keeps the four-pass topology and has no synthetic beam pass', () => {
    const registeredPasses = [
      ...passes.matchAll(/graph\.add(?:Compute|Raster)Pass\(SkyPass\.(volume\w+),/g),
    ].map(([, name]) => SkyPass[name as keyof typeof SkyPass]);
    expect(registeredPasses).toEqual([
      'volume-inject',
      'volume-integrate',
      'volume-temporal',
      'volume-composite',
    ]);
    expect(passes).not.toContain('volume-beam');
    expect(passes).not.toContain('godray');
  });

  it('retains falsifier hooks for off lights, occluders, and shadow visibility', () => {
    expect(inject).toContain('selected_cluster_light_slot');
    expect(inject).toContain('cluster_uniform.grid.w');
    expect(inject).toContain('shadowAtlasTile');
    expect(inject).toContain('return 0.0');
    expect(integrate).toContain('evalSpotAttenuation');
    expect(integrate).toContain('let shadow_visibility =');
    expect(integrate).toContain('mix(1.0, shadow_visibility, volume_spot_shadow_intensity())');
    expect(integrate).not.toContain('shadow_visibility * attenuation');
    expect(integrate).toContain('transmittance');
  });
});
