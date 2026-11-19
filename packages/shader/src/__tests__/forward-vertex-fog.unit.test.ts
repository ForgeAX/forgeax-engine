import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('Forward vertex height fog', () => {
  it.each([
    'default-standard-pbr.wgsl',
    'default-standard-pbr-skin.wgsl',
    'unlit.wgsl',
  ])('%s carries the interpolated transmittance without another varying location', (file) => {
    const text = source(file);
    expect(text).toContain('worldNormal : vec4<f32>');
    expect(text).toContain(
      `vertex_height_fog(view, ${file.includes('-skin') ? 'skinnedLocal' : 'world'}.xyz)`,
    );
    expect(text).toMatch(
      file === 'default-standard-pbr.wgsl'
        ? /forward_fog(?:_transmission)?\(view,[^\n]+standardVertexFog\(in\)/
        : /forward_fog(?:_transmission)?\(view,[^\n]+in\.worldNormal\.w/,
    );
    const output = /struct VsOut \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? '';
    const locations = new Set([...output.matchAll(/@location\((\d+)\)/g)].map((m) => m[1]));
    expect(locations.size + 1).toBeLessThanOrEqual(16);
  });

  it('uses the shared height integral and blend composition without vertex atmosphere lookups', () => {
    const text = source('fog.wgsl');
    const vertex = /fn vertex_height_fog\([\s\S]*?\n\}/.exec(text)?.[0] ?? '';
    expect(vertex).toContain('height_fog_with_source(');
    expect(vertex).not.toMatch(/view_atmosphere|view_solar_transmittance|view_distant_sky_light/);
    expect(text).toContain('fn compose_material_fog(');
    expect(text).toContain('fn forward_fog_transmission(');
    expect(text).toContain('v.fogColorDensity.xyz * (1.0 - transmittance)');
  });
});
