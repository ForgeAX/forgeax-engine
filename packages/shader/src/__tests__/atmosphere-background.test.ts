import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../${file}.wgsl`, import.meta.url)), 'utf8');

describe('physical atmosphere background ray and disc', () => {
  it('shares the world ray with aerial perspective and evaluates the disc along that ray', () => {
    const background = source('atmosphere-background');
    expect(background).toContain('atmosphere_view_ray(view,input.uv)');
    expect(background).toContain('dot(ray.direction,sun)');
    expect(background).toContain(
      'atmosphere_solar_transmittance(view.atmosphere,origin,ray.direction',
    );
    const coordinates = source('atmosphere-coordinates');
    expect(coordinates).toContain('v.inverseViewProj');
    expect(coordinates).toContain('v.temporalProjection.z');
    expect(source('atmosphere-sampling')).toContain('atmosphere_view_ray');
  });

  it('adds finite-solid-angle Sun radiance only in the background, excluding cube and IBL integration', () => {
    const background = source('atmosphere-background');
    expect(background).toContain('let radius=view.atmosphereControl.y;');
    expect(background).toContain('if radius>0.0');
    expect(background).toContain('solidAngle');
    for (const file of ['atmosphere-cubemap', 'atmosphere-ibl']) {
      const integration = source(file);
      expect(integration).not.toContain('solidAngle');
      expect(integration).not.toContain('atmosphereControl.y');
    }
  });
});
