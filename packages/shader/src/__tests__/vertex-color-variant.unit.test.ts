import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SHADER_ROOT = new URL('../', import.meta.url);
const SOURCES = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'unlit.wgsl',
] as const;

function source(file: (typeof SOURCES)[number]): string {
  return readFileSync(new URL(file, SHADER_ROOT), 'utf8');
}

describe('M4 vertex-color shader contract', () => {
  it.each(SOURCES)('%s declares the geometry-owned color variant axis', (file) => {
    const text = source(file);
    expect(text).toContain('#pragma variant_axis VERTEX_COLOR_AVAILABLE');
    expect(text).toMatch(
      /#ifdef\s+VERTEX_COLOR_AVAILABLE[\s\S]*?@location\(13\)\s+color\s*:\s*vec4<f32>/,
    );
    expect(text).toMatch(
      /#ifdef\s+VERTEX_COLOR_AVAILABLE[\s\S]*?@location\(14\)\s+color\s*:\s*vec4<f32>/,
    );
    if (file === 'default-standard-pbr.wgsl') {
      expect(text).toMatch(/@location\(12\)\s+uvPair3\s*:\s*vec4<f32>/);
    } else if (file === 'default-standard-pbr-skin.wgsl') {
      expect(text).toMatch(/@location\(12\)\s+uv6And7\s*:\s*vec4<f32>/);
    }
  });

  it.each(
    SOURCES,
  )('%s has an explicit white false variant and does not add a material flag', (file) => {
    const text = source(file);
    expect(text).toMatch(/#else[\s\S]*?vec4<f32>\(1\.0\)/);
    expect(text).not.toMatch(/hasColor|VERTEX_COLOR\s*:/);
    expect(text).not.toMatch(/struct\s+Material\s*\{[^}]*\bcolor\b/s);
  });

  it.each(SOURCES)('%s applies vertex color to linear RGB and all alpha consumers', (file) => {
    const text = source(file);
    if (file === 'unlit.wgsl') {
      expect(text).toMatch(/baseColor\.rgb\s*\*\s*texSample\.rgb\s*\*\s*vertexColor\.rgb/);
      expect(text).toMatch(
        /baseColor\.a\s*\*\s*unlitTextureAlpha\(texSample\.a\)\s*\*\s*vertexColor\.a/,
      );
    } else {
      expect(text).toContain(
        '#import forgeax_material::slot::surface::{evaluate_surface, evaluate_standard_surface}',
      );
      expect(text).toContain('materialVertexColor(in), frontFacing');
    }
    expect(text).toMatch(/alphaCutoff/);
    expect(text).toMatch(/fs_temporal/);
  });

  it('canonical Standard surface applies vertex color to linear RGB and alpha', () => {
    const text = readFileSync(new URL('../default_standard_surface.wgsl', import.meta.url), 'utf8');
    expect(text).toMatch(/baseColor\.rgb\s*\*\s*baseSample\.rgb\s*\*\s*vertexColor\.rgb/);
    expect(text).toMatch(/baseColor\.a\s*\*\s*baseSample\.a\s*\*\s*vertexColor\.a/);
  });

  it('preserves all eight UV sets in paired varyings while reserving color at 14', () => {
    const text = source('default-standard-pbr.wgsl');
    for (const [pair, location] of [2, 5, 8, 12].entries()) {
      expect(text).toContain(`@location(${location}) uvPair${pair} : vec4<f32>`);
      const first = pair === 0 ? 'uv' : `uv${pair * 2}`;
      expect(text).toContain(`out.uvPair${pair} = vec4<f32>(in.${first}, in.uv${pair * 2 + 1})`);
      expect(text).toContain(`in.uvPair${pair}.xy`);
      expect(text).toContain(`in.uvPair${pair}.zw`);
    }
    expect(text).toMatch(/@location\(14\)\s+color\s*:\s*vec4<f32>/);
  });
});
