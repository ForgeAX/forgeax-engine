import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const punctual = readFileSync(new URL('../lighting-punctual.wgsl', import.meta.url), 'utf8');
const attenuation = readFileSync(new URL('../lighting-attenuation.wgsl', import.meta.url), 'utf8');
const inject = readFileSync(new URL('../volume/volume-inject.wgsl', import.meta.url), 'utf8');
const integrate = readFileSync(new URL('../volume/volume-integrate.wgsl', import.meta.url), 'utf8');

describe('shared punctual optics for volumetric fog', () => {
  it('publishes one finite Point and Spot volume evaluator', () => {
    expect(punctual).toContain('fn evalVolumePoint(');
    expect(punctual).toContain('fn evalVolumeSpot(');
    expect(punctual).toContain('evalDistanceAttenuation');
    expect(punctual).toContain('evalSpotAttenuation');
    expect(punctual).toContain('max(dSquared, 1e-4)');
    expect(attenuation).toContain('smoothstep(cosOuter, cosInner');
    expect(attenuation).toContain('safeDistance');
  });

  it('uses the shared evaluators from the fixed inject and integrate stages', () => {
    expect(inject).toContain('forgeax_pbr::lighting_punctual');
    expect(integrate).toContain('forgeax_pbr::lighting_punctual');
    expect(inject).toContain('evalVolumePoint');
    expect(inject).toContain('evalVolumeSpot');
    expect(integrate).toContain('evalVolumePoint');
    expect(integrate).toContain('evalVolumeSpot');
    expect(inject).toContain('light_data');
    expect(inject).toContain('cluster_uniform');
    expect(inject).not.toContain('pointLightsBuffer');
    expect(inject).not.toContain('spotLightsBuffer');
    expect(integrate).toContain('light_data');
    expect(integrate).toContain('cluster_uniform');
    expect(integrate).not.toContain('pointLightsBuffer');
    expect(integrate).not.toContain('spotLightsBuffer');
  });

  it('keeps volume View aligned with the directional filter carrier', () => {
    expect(inject).toContain('directionalShadowFilter : vec4<f32>');
    expect(inject).toContain('normalBias : f32,\n  directionalShadowFilter');
    expect(inject).not.toContain('view.pcfKernelSize');
    expect(inject).toContain('filter_profile >= 4u');
    expect(inject).toContain('stable PCF3 receiver');
  });

  it('keeps the punctual volume path finite and monotonic at range boundaries', () => {
    expect(punctual).toMatch(/max\([^\n]*1e-4/);
    expect(attenuation).toMatch(/clamp\(1\.0 - \(safeDistance \* invRangeSquared\)/);
    expect(attenuation).toContain('return distance * cone');
    expect(integrate).toContain('isFinite');
  });

  it('uses the pinned Three density grain and smoke amount mapping', () => {
    expect(integrate).toContain('fn volume_sample_grain(');
    expect(integrate).toContain('fract((position + time_scaled * time_scale) * scale)');
    expect(integrate).toContain('volume_sample_grain(position, 0.1, time_scaled, 1.0)');
    expect(integrate).toContain('volume_sample_grain(position, 0.05, time_scaled, 1.0)');
    expect(integrate).toContain('volume_sample_grain(position, 0.02, time_scaled, 2.0)');
    expect(integrate).toContain('return vec4<f32>(max(2.0 * grain - 1.0, 0.0));');
    expect(integrate).toContain(
      'volume_optical_sample(world_position, volume_params.simulation.x)',
    );
    expect(integrate).not.toContain('density_uv');
  });
});
