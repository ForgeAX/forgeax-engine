import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shader = readFileSync(
  fileURLToPath(new URL('../default-standard-pbr.wgsl', import.meta.url)),
  'utf8',
);

function body(name: string): string {
  const start = shader.indexOf(`fn ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  return shader.slice(start, shader.indexOf('\n}\n', start) + 2);
}

describe('Standard planar reflection normal distortion', () => {
  it('projects the shading-normal reflection ray at the uniform radius (Unreal virtual sphere)', () => {
    const specular = body('standardPlanarSpecular');
    // A flat normal's reflected ray runs along the mirror eye's line, so it lands on uv.
    expect(specular).toContain(
      'position + reflect(-v, shadingNormal) * planar.enabledAndPadding.y',
    );
    expect(specular).toContain('let probe = planar.viewProjection *');
  });

  it('keeps plane membership on the geometric normal and distorts with the shading normal', () => {
    const specular = body('standardPlanarSpecular');
    expect(specular).toContain('dot(normal, planar.plane.xyz) < 0.999');
    // Off-screen fragments keep the environment; the distorted lookup stays inside the capture.
    expect(specular.indexOf('any(uv > vec2<f32>(1.0))')).toBeLessThan(
      specular.indexOf('let lookup'),
    );
    expect(specular).toContain('clamp(lookup, vec2<f32>(0.0), vec2<f32>(1.0))');
    expect(shader).toContain(
      'standardPlanarSpecular(in.worldPos, geometricNormal, physicalNormal, v, iblRoughness',
    );
  });

  it('blurs a mipped capture by roughness and keeps the single-level fade', () => {
    const specular = body('standardPlanarSpecular');
    expect(specular).toContain('let levels = planar.enabledAndPadding.z;');
    // A mip chain keeps the mirror at every roughness; one level keeps the 0.5 fade.
    expect(specular).toContain(
      'let weight = select(clamp(1.0 - 2.0 * roughness, 0.0, 1.0), 1.0, mipped);',
    );
    expect(specular).toContain(
      'let lod = select(0.0, clamp(roughness, 0.0, 1.0) * (levels - 1.0), mipped);',
    );
    expect(specular).toMatch(
      /textureSampleLevel\(standardPlanarReflectionTexture, prefilterSampler, .*, lod\)/,
    );
    // Only capture holes (alpha below 1) fall back to the environment.
    expect(specular).toContain('environment * (1.0 - clamp(reflected.a, 0.0, 1.0))');
  });
});
