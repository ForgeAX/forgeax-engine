import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const lightingSource = readFileSync(new URL('../standard-lighting.wgsl', import.meta.url), 'utf8');
const samplingSource = readFileSync(new URL('../ibl-sampling.wgsl', import.meta.url), 'utf8');
const standardSource = readFileSync(
  new URL('../default-standard-pbr.wgsl', import.meta.url),
  'utf8',
);
const skinSource = readFileSync(
  new URL('../default-standard-pbr-skin.wgsl', import.meta.url),
  'utf8',
);

describe('Standard reflection probe sampling contract', () => {
  it('uses one selected reflection slot for fallback environments and local box projection', () => {
    expect(samplingSource).toContain('fn box_project(');
    expect(lightingSource).toContain('fn sampleStandardReflectionRadiance(');
    expect(lightingSource).toContain(
      'direction = box_project(worldPosition, direction, tint, sky.rotation.xyz)',
    );
    expect(lightingSource).toContain(
      'samplePmrem(prefilterMap, prefilterSampler, direction, roughness)',
    );
    expect(lightingSource).toContain(
      'sampleIblRadiance(reflectionDirection, roughness, sky.rotation, prefilterMap, prefilterSampler)',
    );
    for (const root of [standardSource, skinSource]) {
      expect(root).toContain('evaluateStandardEnvironment(');
      expect(root).toContain('evaluateStandardClearcoatReflection(');
      expect(root).not.toContain('@binding(47) var');
    }
  });

  it('projects only the environment specular lobe for c=1 without removing diffuse light', () => {
    expect(standardSource).toContain(
      'var reflectionFallback = environment.specular * (vec3<f32>(1.0) - coatF) * specularAo;',
    );
    expect(lightingSource).toContain('lowFrequency = diffuseWeight * irradiance.front');
    expect(lightingSource).toContain('let front = sampleSkylightDiffuse(sky, normal, skySh);');
    expect(lightingSource).toContain('* skylightHemisphereScale(sky, scale, normal);');
    // The lit tail carries the fallback; every forward entry copies it out.
    expect(standardSource).toContain(
      'lit.reflectionFallback = vec4<f32>(reflectionFallback, standardSsrCoverage());',
    );
    expect(standardSource).toContain('output.reflectionFallback = lit.reflectionFallback;');
    expect(standardSource).not.toContain('output.reflectionFallback = vec4<f32>(ambient, 1.0);');
  });

  it('keeps zero-intensity local captures and fallback tint separate from box metadata', () => {
    expect(lightingSource).toContain('if (sky.intensity < 0.0)');
    expect(lightingSource).toContain('* (-sky.intensity - 1.0)');
    expect(lightingSource).toContain('* tint * sky.intensity');
    expect(lightingSource).toContain('return StandardEnvironment(diffuse, specular * single,');
  });
});
