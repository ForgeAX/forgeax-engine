import { compileShader } from '@forgeax/engine-shader-compiler';
import { describe, expect, it } from 'vitest';
import { advancedFftShader } from '../water/advanced-fft-shader';

describe('advanced FFT noise sample contract', () => {
  it.each([
    'rgba16float',
    'rgba32float',
  ] as const)('reuses the immutable source for %s', (format) => {
    expect(advancedFftShader(format)).toBe(advancedFftShader(format));
  });

  it('does not cache an unsupported runtime format into a fixed slot', () => {
    const unsupported = 'rgba64float' as Parameters<typeof advancedFftShader>[0];
    expect(advancedFftShader(unsupported)).toContain('texture_storage_2d<rgba64float,write>');
    expect(advancedFftShader('rgba32float')).toContain('texture_storage_2d<rgba32float,write>');
  });

  it.each([
    'rgba16float',
    'rgba32float',
  ] as const)('retains all four interpolated noise channels for %s', async (format) => {
    const source = `${advancedFftShader(format)}
@group(0) @binding(7) var<storage,read_write> sampledNoise:array<vec4<f32>>;
@compute @workgroup_size(1) fn inspectNoise(){
  let sample:vec4<f32> = noiseAt(vec2<f32>(0.125,0.375));
  sampledNoise[0]=sample;
}`;
    const compiled = await compileShader(source, { computeEntry: 'inspectNoise' });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw compiled.error;
    expect(
      compiled.value.reflection.boundGlobals
        .filter((row) => row.resourceKind === 'storage-buffer')
        .map((row) => row.binding),
    ).toEqual([2, 3, 7]);
  });
});
