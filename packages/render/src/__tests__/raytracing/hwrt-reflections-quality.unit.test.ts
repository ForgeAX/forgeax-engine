import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { rayShaderTestImports } from './ray-shader-imports.fixture';

const shaderSource = readFileSync(
  new URL('../../../../shader/src/ray-irradiance-field.wgsl', import.meta.url),
  'utf8',
);

describe('HWRT reflection sampling and temporal accumulation contracts', () => {
  it('compiles generateFieldReflections with IGN+R2 sampling and GGXSamplingBias', async () => {
    const compiled = (
      await compileShader(shaderSource, {
        id: 'generateFieldReflections',
        computeEntry: 'generateFieldReflections',
        defines: { IRRADIANCE_FIELD_VISIBILITY: true },
        imports: await rayShaderTestImports(),
      })
    ).unwrap();
    expect(shaderSource).toContain('REFLECTION_GGX_SAMPLING_BIAS = 0.1');
    expect(compiled.wgsl).toContain('reflectionBlueSample');
    expect(compiled.wgsl).toContain('* 0.9f');
    expect(compiled.wgsl).not.toContain('hash32(');
  });

  it('compiles accumulateFieldReflections with separate surface/virtual history taps and YCoCg variance clamp', async () => {
    const compiled = (
      await compileShader(shaderSource, {
        id: 'accumulateFieldReflections',
        computeEntry: 'accumulateFieldReflections',
        defines: { IRRADIANCE_FIELD_VISIBILITY: true },
        imports: await rayShaderTestImports(),
      })
    ).unwrap();
    expect(compiled.wgsl).toContain('sampleReflectionHistoryAt');
    expect(compiled.wgsl).toContain('reflectionRgbToYCoCg');
    expect(compiled.wgsl).toContain('reflectionYCoCgToRgb');
    expect(compiled.wgsl).toContain('sameReflectorSurface');
    // Never linearly interpolate unrelated surface vs virtual UV coordinates.
    expect(compiled.wgsl).not.toContain('mix(uv, reflectionHistoryUv');
  });

  it('compiles generateReflectionsChebyshev without software canonical visibility walks', async () => {
    const compiled = (
      await compileShader(shaderSource, {
        id: 'generateReflectionsChebyshev',
        computeEntry: 'generateReflectionsChebyshev',
        defines: { IRRADIANCE_FIELD_VISIBILITY: false },
        imports: await rayShaderTestImports(),
      })
    ).unwrap();
    expect(compiled.wgsl).toContain('fn generateReflectionsChebyshev(');
    expect(compiled.wgsl).toContain('reflectionBlueSample');
    expect(compiled.wgsl).not.toContain('fieldCanonicalVisibility');
    expect(compiled.wgsl).not.toContain('sdfSurfaceBoundsRow');
  });
});
