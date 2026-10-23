import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../${name}.wgsl`, import.meta.url), 'utf8');

describe('Standard ambient occlusion consumer contract', () => {
  it.each([
    'default-standard-pbr',
    'default-standard-pbr-skin',
    'standard-surface',
  ])('%s consumes the shared projected AO', (name) => {
    const code = source(name).replace(/\/\/[^\n]*/g, '');
    expect(code).toContain('sampleStandardAmbientOcclusion(in.worldPos, view.worldViewProj,');
    expect(code).toContain('ssaoBlurredTexture, ssaoBlurredSampler');
    expect(code).not.toMatch(/ssaoFactor\s*\*\s*ao/);
  });
  it('treats zero strength as disabled and never reapplies the producer exponent', () => {
    const code = source('standard-cluster');
    expect(code).toContain('if (get_ssao_intensity() <= 0.0) { return 1.0; }');
    expect(code).toContain(
      'return clamp(textureSampleLevel(aoTexture, aoSampler, uv, 0.0).r, 0.0, 1.0);',
    );
    for (const name of ['standard-cluster', 'standard-deferred-lighting', 'single-layer-medium'])
      expect(source(name).replace(/\/\/[^\n]*/g, '')).not.toMatch(
        /pow\([^;]*(ssao|screenOcclusion|aoTexture)/,
      );
  });
});

it('keeps material and environment AO independent from the opt-in direct AO lane', () => {
  const code = source('standard-deferred-lighting');
  expect(code).toContain('lanes : vec4<f32>');
  expect(code).toContain('occlusion : vec4<f32>');
  expect(code).toContain('let ao = response.a * screenAo;');
  expect(code).toContain('mix(1.0, screenAo, clamp(params.occlusion.x, 0.0, 1.0))');
  expect(code).toContain(
    '(environment.diffuse + environment.specular) * ao + direct.radiance * directAo',
  );
  expect(code).toContain('environment.diffuse * ao + direct.diffuse * directAo');
});
