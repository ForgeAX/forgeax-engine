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
  it('keeps global IBL helpers and adds a bounded local probe sampling helper', () => {
    expect(samplingSource).toMatch(/fn\s+sampleIblDiffuse\s*\(/);
    expect(samplingSource).toMatch(/fn\s+sampleIblSpecular\s*\(/);
    expect(samplingSource).toMatch(/fn\s+sampleReflectionProbeSpecular\s*\(/);
  });

  it('uses box projection and explicit Skylight fallback in the Standard shader', () => {
    expect(samplingSource).toMatch(/box_project/);
    expect(standardSource).toMatch(/sampleReflectionProbeSpecular/);
    expect(standardSource).toContain('skylight.intensity < 0.0');
    expect(standardSource).toMatch(/sampleIblSpecular/);
    expect(standardSource).toMatch(/skylight/);
  });

  it('projects only the environment specular lobe for c=1 without removing diffuse light', () => {
    expect(standardSource).toContain(
      'var reflectionFallback = environment.specular * (vec3<f32>(1.0) - coatF) * ao;',
    );
    expect(lightingSource).toContain('kD * irradiance * albedo * diffuseScale');
    // The lit tail carries the fallback; every forward entry copies it out.
    expect(standardSource).toContain(
      'lit.reflectionFallback = vec4<f32>(reflectionFallback, standardSsrCoverage());',
    );
    expect(standardSource).toContain('output.reflectionFallback = lit.reflectionFallback;');
    expect(standardSource).not.toContain('output.reflectionFallback = vec4<f32>(ambient, 1.0);');
  });

  it('keeps probe clearcoat on the selected probe source', () => {
    expect(standardSource).toMatch(
      /if \(skylight\.intensity < 0\.0\) \{[\s\S]*?clearcoatIbl = sampleReflectionProbeSpecular\(/,
    );
  });

  it('keeps zero-intensity probes distinguishable from an absent Skylight', () => {
    expect(standardSource).toContain('decodeSpecularEnvironmentScale(');
    expect(samplingSource).toContain('* probeIntensity');
    expect(standardSource).toContain('max(-skylight.intensity - 1.0, 0.0)');
  });

  it('keeps probe-blend and SSR on one sentinel-safe specular environment scale', () => {
    // ReflectionProbe resources encode their intensity as a negative sentinel
    // and use the Skylight color lanes for box metadata. Never multiply that
    // metadata by the specular lobe. The same decoded scale must drive the
    // PROBE_BLEND specular ambient term and detached SSR fallback.
    expect(lightingSource).toContain(
      'specular * decodeSpecularEnvironmentScale(tint, sky.intensity)',
    );
    for (const root of [standardSource, skinSource]) {
      expect(root).toContain('evaluateStandardEnvironment(');
      expect(root).toContain(
        'var reflectionFallback = environment.specular * (vec3<f32>(1.0) - coatF) * ao;',
      );
      expect(root).toContain('reflectionFallback *= screenAo;');
    }
  });
});
