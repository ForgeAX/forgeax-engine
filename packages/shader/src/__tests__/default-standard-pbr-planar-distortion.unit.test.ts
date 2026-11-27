import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const standard = readFileSync(
  fileURLToPath(new URL('../default-standard-pbr.wgsl', import.meta.url)),
  'utf8',
);
const medium = readFileSync(
  fileURLToPath(new URL('../single-layer-medium.wgsl', import.meta.url)),
  'utf8',
);
const sample = readFileSync(
  fileURLToPath(new URL('../planar-reflection.wgsl', import.meta.url)),
  'utf8',
);

describe('Shared planar reflection sampling', () => {
  it('projects the shading-normal reflection ray at the uniform radius (Unreal virtual sphere)', () => {
    // A flat normal's reflected ray runs along the mirror eye's line, so it lands on uv.
    expect(sample).toContain('position + reflect(-toEye, normal) * planar.capture.y');
    expect(sample).toContain('let probe = planar.viewProjection *');
    expect(standard).toMatch(
      /samplePlanarReflection\(standardPlanarReflection, standardPlanarReflectionTexture,\s*viewLinearSampler, standardPositionWS, physicalNormal, v, iblRoughness\)/,
    );
    expect(medium).toMatch(
      /samplePlanarReflection\(planarReflection, planarReflectionTexture,\s*surfaceBackdropSampler, input\.positionWS, orientedNormal, viewDirection, roughness\)/,
    );
  });

  it('attenuates by plane distance and shading-normal angle before sampling the capture', () => {
    expect(sample).toContain('abs(dot(planar.plane, vec4<f32>(position, 1.0)))');
    expect(sample).toContain('dot(normal, planar.plane.xyz) * planar.receiverFade.z');
    expect(sample).toContain('distanceFade * angleFade * roughnessFade');
    expect(sample).toMatch(
      /if \(any\(uv < vec2<f32>\(0\.0\)\) \|\| any\(uv > vec2<f32>\(1\.0\)\)\) \{ return vec4<f32>\(0\.0\); \}/,
    );
    expect(sample).toContain('clamp(lookup, vec2<f32>(0.0), vec2<f32>(1.0))');
  });

  it('blurs a mipped capture by roughness and keeps the single-level fade', () => {
    expect(sample).toContain('let mipped = planar.capture.z > 1.0;');
    expect(sample).toContain(
      'select(1.0 - clamp((roughness - 0.2) * 10.0, 0.0, 1.0), 1.0, mipped)',
    );
    expect(sample).toContain('clamp(roughness, 0.0, 1.0) * (planar.capture.z - 1.0)');
    expect(sample).toMatch(/textureSampleLevel\(reflection, linearSampler, .*, lod\)/);
    expect(sample).toContain('vec4<f32>(reflected.rgb, clamp(reflected.a, 0.0, 1.0)) * weight');
    expect(standard).toContain('environment.specular * (1.0 - planar.a)');
    expect(medium).toContain(
      'sampleSkyReflection(orientedNormal, viewDirection, roughness, input.positionWS) * (1.0 - planar.a)',
    );
  });
});
