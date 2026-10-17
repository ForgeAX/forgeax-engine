import type { AnimationSampler } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { sampleChannel } from '../sample-channel';

const sampler = (
  input: number[],
  output: number[],
  interpolation: AnimationSampler['interpolation'] = 'LINEAR',
): AnimationSampler => ({
  input: new Float32Array(input),
  output: new Float32Array(output),
  interpolation,
});

describe('caller-owned animation samples', () => {
  it('reuses one destination across keys, clamps, STEP and changing channel widths', () => {
    const result: number[] = [];
    const position = sampler([0, 1, 2], [0, 2, 4, 2, 4, 8, 6, 10, 12]);
    for (const [time, expected] of [
      [-1, [0, 2, 4]],
      [0.5, [1, 3, 6]],
      [1.5, [4, 7, 10]],
      [3, [6, 10, 12]],
    ] as const) {
      expect(sampleChannel(position, time, 'translation', result)).toBe(result);
      expect(result).toEqual(expected);
    }
    const weights = sampler([0, 1], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'STEP');
    expect(sampleChannel(weights, 0.5, 'weights', result)).toBe(result);
    expect(result).toEqual([0, 1, 2, 3, 4]);
    expect(sampleChannel(position, 0.5, 'scale', result)).toBe(result);
    expect(result).toEqual([1, 3, 6]);
    expect([...position.output]).toEqual([0, 2, 4, 2, 4, 8, 6, 10, 12]);
  });

  it('keeps shortest-arc slerp and near-parallel normalization in the destination', () => {
    const result: number[] = [];
    const quarterTurn = sampler([0, 1], [0, 0, 0, 1, 0, 1, 0, 0]);
    expect(sampleChannel(quarterTurn, 0.5, 'rotation', result)).toBe(result);
    expect(result).toHaveLength(4);
    expect(result[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(result[3]).toBeCloseTo(Math.SQRT1_2, 12);
    const opposed = sampler([0, 1], [0, 0, 0, 1, 0, 0, 0, -1]);
    expect(sampleChannel(opposed, 0.4, 'rotation', result)).toBe(result);
    expect(result).toEqual([0, 0, 0, 1]);
  });

  it('retains cubic tangents, quaternion normalization and zero-quaternion rejection', () => {
    const result: number[] = [];
    const cubic = sampler(
      [0, 2],
      [0, 0, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 2, 4, 6, 0, 0, 0],
      'CUBICSPLINE',
    );
    expect(sampleChannel(cubic, 1, 'translation', result)).toBe(result);
    expect(result).toEqual([1.25, 2, 2.75]);
    const quat = sampler(
      [0, 2],
      [0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0],
      'CUBICSPLINE',
    );
    expect(sampleChannel(quat, 1, 'rotation', result)).toBe(result);
    expect(result[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(result[3]).toBeCloseTo(Math.SQRT1_2, 12);
    quat.output.fill(0);
    expect(sampleChannel(quat, 1, 'rotation', result)).toBeUndefined();
  });

  it('preserves independent return values when no destination is supplied', () => {
    const source = sampler([0, 1], [0, 1, 2, 2, 3, 4]);
    const first = sampleChannel(source, 0.25, 'translation');
    const second = sampleChannel(source, 0.75, 'translation');
    expect(first).toEqual([0.5, 1.5, 2.5]);
    expect(second).toEqual([1.5, 2.5, 3.5]);
    expect(second).not.toBe(first);
    expect(sampleChannel(sampler([], []), 0, 'weights', [])).toBeUndefined();
  });

  it('does not read another key as a missing quaternion component', () => {
    const short = sampler([0, 1], [0, 0, 0, 0, 1, 0]);
    const result: number[] = [];
    expect(sampleChannel(short, 0.5, 'rotation', result)).toBe(result);
    expect(result).toEqual([0, 0.5 / Math.sqrt(1.25), 0, 1 / Math.sqrt(1.25)]);
  });
});
