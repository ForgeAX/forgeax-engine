import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

const kernel = source('light-texture-resample-kernel.wgsl');
const compute = source('light-texture-resample-compute.wgsl');

describe('light texture resampling reduction ownership', () => {
  it('routes texture and storage-buffer reductions through one f32 mean', () => {
    expect(kernel).toMatch(
      /fn meanFour\([\s\S]*?\) -> vec4<f32> \{\s*return \(a \+ b \+ c \+ d\) \* 0\.25;/,
    );
    expect(kernel).toContain('return meanFour(a, b, c, d);');
    expect(compute).toContain('meanFour, reconstructPixel');
    expect(compute).toMatch(/return meanFour\([\s\S]*?levels\[row \+ size \* 2u \+ 1u\]\s*\);/);
    expect(compute).not.toContain('* 0.25');
  });
});
