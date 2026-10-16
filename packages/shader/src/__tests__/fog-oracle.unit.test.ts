import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const integrateWgsl = readFileSync(
  fileURLToPath(new URL('../volume/volume-integrate.wgsl', import.meta.url)),
  'utf8',
);
const compositeWgsl = readFileSync(
  fileURLToPath(new URL('../volume/volume-composite.wgsl', import.meta.url)),
  'utf8',
);
const temporalWgsl = readFileSync(
  fileURLToPath(new URL('../volume/volume-temporal.wgsl', import.meta.url)),
  'utf8',
);
const injectWgsl = readFileSync(
  fileURLToPath(new URL('../volume/volume-inject.wgsl', import.meta.url)),
  'utf8',
);

describe('Volumetric optics shader ownership', () => {
  it('uses filterable history with exact reprojection and bounded history age', () => {
    expect(temporalWgsl).toContain('var accepted : texture_2d<f32>');
    expect(temporalWgsl).toContain('fn bilinear');
    expect(temporalWgsl).toContain('textureLoad(accepted');
    expect(temporalWgsl).toContain('0.875');
    expect(temporalWgsl).not.toContain('temporal_jitter');
    expect(temporalWgsl).toContain('let prior = bilinear(previous_uv, size);');
  });

  it('weights equal-alpha neighborhood samples by relative radiance', () => {
    expect(compositeWgsl).toContain('radiance_luma_weight');
    expect(compositeWgsl).toContain('relative_luma');
    const center = 1;
    const darkNeighbor = 0.02;
    const equalAlpha = 0.5;
    const relativeLuma = Math.abs(darkNeighbor - center) / Math.max(center, darkNeighbor, 1e-4);
    const weight = Math.exp(-relativeLuma * 8) * Math.exp(-Math.abs(equalAlpha - equalAlpha) * 24);
    expect(weight).toBeLessThan(0.01);
  });

  it('keeps optical depth and phase in the volume integration module', () => {
    expect(integrateWgsl).toContain('#define_import_path forgeax_view::volume_integrate');
    expect(integrateWgsl).toContain('fn hg');
    expect(integrateWgsl).toContain('FOUR_PI');
    expect(integrateWgsl).toContain('textureStore(resolved');
    expect(integrateWgsl).not.toContain('apply_fog');
    expect(integrateWgsl).toContain('let ray_step_count = 96u;');
    expect(integrateWgsl).toContain(
      'let ray_step = (interval_end - interval_start) / f32(ray_step_count);',
    );
    expect(integrateWgsl).toContain('let segment_start');
    expect(integrateWgsl).toContain('let segment_length');
    expect(integrateWgsl).toContain('let sigma = sigma_scale * density_value;');
    expect(integrateWgsl).toContain('extinction += sigma;');
    expect(integrateWgsl).toContain('exp(-extinction * sample_length)');
    expect(integrateWgsl).toContain('scene_distance');
    expect(injectWgsl).not.toContain('scene_depth');
    expect(injectWgsl).not.toContain('textureStore(volume_history');
    expect(injectWgsl).not.toContain('textureStore(volume_temporal');
  });

  it('composites the prepared integrated volume exactly once', () => {
    expect(compositeWgsl).toContain('#define_import_path forgeax_view::volume_composite');
    expect(compositeWgsl).toContain('resolved_volume');
    expect(compositeWgsl).not.toContain('apply_fog');
  });

  it('maps the fullscreen composite UV into the view-space Y convention', () => {
    expect(compositeWgsl).toContain('positions[index].x * 0.5 + 0.5');
    expect(compositeWgsl).toContain('0.5 - positions[index].y * 0.5');
  });

  it('selects volume cascades from the uploaded camera view-depth contract', () => {
    expect(injectWgsl).toContain('view.temporalCurrentViewProj');
    expect(injectWgsl).toContain('view.temporalProjection');
    expect(injectWgsl).not.toContain('distance(world_position, view.cameraPos)');
  });

  it('keeps volume samples independent of render frame identity, including on history reset', () => {
    for (const shader of [injectWgsl, integrateWgsl]) {
      expect(shader).not.toContain('stratified32');
      expect(shader).not.toContain('dither_unorm8');
      expect(shader).not.toContain('volume_params.light_direction.w');
    }
  });
});
