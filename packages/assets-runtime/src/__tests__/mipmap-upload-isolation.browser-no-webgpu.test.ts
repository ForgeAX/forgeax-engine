import { expect, it } from 'vitest';
import { sampleSequentialMips } from './mipmap-upload-isolation.fixture';

it.each([
  'rgba8unorm',
  'rgba8unorm-srgb',
] as const)('keeps sequential uploads and all six sampled mips isolated on WebGL2 (%s)', {
  timeout: 60_000,
}, async (format) => {
  const result = await sampleSequentialMips(format);
  expect(result.backend).toBe('wgpu-webgl2');
  expect(result.samples).toHaveLength(12);
  for (const sample of result.samples) {
    for (const [channel, actual] of sample.actual.entries()) {
      const expected = sample.expected[channel];
      if (expected === undefined) throw new Error('Missing expected color channel');
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
    }
  }
});
