import { describe, expect, it } from 'vitest';
import { validateTextureGenerator } from '../generator';

const shape = { viewDimension: '2d', extent: { width: 16, height: 16 } } as const;
const output = {
  shape,
  format: 'rgba8unorm',
  colorSpace: 'linear',
  mips: { kind: 'generate' },
} as const;
const recipe = () => ({
  kind: 'texture-generator' as const,
  values: { seed: 42 },
  inputs: {},
  outputs: { color: output },
  transient: { height: { shape, format: 'r16float' as const } },
  passes: [
    {
      kind: 'raster' as const,
      program: { module: 'test::paint', fragmentEntry: 'paint' },
      reads: {},
      writes: ['height'],
    },
    {
      kind: 'raster' as const,
      program: { module: 'test::color', fragmentEntry: 'color' },
      reads: { height: { kind: 'local' as const, name: 'height' } },
      writes: ['color'],
    },
  ],
});

describe('runtime GPU texture generator admission', () => {
  it('accepts a finite two-stage graph without any CPU pixels', () => {
    const source = recipe();
    expect(validateTextureGenerator(source).ok).toBe(true);
    expect(JSON.stringify(source)).not.toContain('"data"');
  });
  it('rejects unwritten resources and same-pass feedback', () => {
    const source = recipe();
    source.passes.reverse();
    expect(validateTextureGenerator(source).ok).toBe(false);
    const feedback = recipe();
    const second = feedback.passes[1];
    if (!second) throw new Error('Fixture pass missing');
    second.writes = ['height', 'color'];
    expect(validateTextureGenerator(feedback).ok).toBe(false);
  });
  it('rejects output aliases, incomplete outputs, unsupported shapes and invalid values', () => {
    expect(validateTextureGenerator({ ...recipe(), outputs: { height: output } }).ok).toBe(false);
    expect(validateTextureGenerator({ ...recipe(), passes: recipe().passes.slice(0, 1) }).ok).toBe(
      false,
    );
    expect(validateTextureGenerator({ ...recipe(), values: { seed: Number.NaN } }).ok).toBe(false);
    expect(validateTextureGenerator({ ...recipe(), values: { seed: Array(3) } }).ok).toBe(false);
    expect(validateTextureGenerator({ ...recipe(), values: { _textureLayer: 2 } }).ok).toBe(false);
    expect(validateTextureGenerator({ ...recipe(), data: new Uint8Array(4) }).ok).toBe(false);
    expect(
      validateTextureGenerator({
        ...recipe(),
        outputs: { color: { ...output, colorSpace: 'srgb' } },
      }).ok,
    ).toBe(false);
  });
});
