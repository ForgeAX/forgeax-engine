import { expect, it } from 'vitest';
import { bufferSignature, stableRenderFeatureValue } from '../features/prepared-gpu-work';

it('spells buffer signatures exactly like the canonical descriptor walk', () => {
  for (const [size, usage] of [
    [64, ['storage']],
    [256, ['uniform', 'storage']],
    [16, ['vertex', 'index', 'copy-src', 'indirect']],
    [0, []],
  ] as const) {
    const expected = stableRenderFeatureValue({ size, usage: [...usage].sort() });
    expect(bufferSignature(size, usage)).toBe(expected);
    expect(bufferSignature(size, Object.freeze([...usage]))).toBe(expected);
    expect(bufferSignature(size, Object.freeze([...usage]))).toBe(expected);
  }
});
