import { describe, expect, it } from 'vitest';
import { planPaddedViewDepthPyramid } from '../depth-pyramid/graph';
import { buildDepthPyramidPlan } from '../depth-pyramid/plan';

describe('depth pyramid plan', () => {
  it('pads each view axis independently before halving', () => {
    expect(planPaddedViewDepthPyramid({ width: 1920, height: 1080 }).extent).toEqual({
      width: 1024,
      height: 1024,
    });
    expect(planPaddedViewDepthPyramid({ width: 2560, height: 1440 }).extent).toEqual({
      width: 2048,
      height: 1024,
    });
    expect(planPaddedViewDepthPyramid({ width: 1, height: 9 }).levels).toEqual([
      { level: 0, width: 1, height: 8 },
      { level: 1, width: 1, height: 4 },
      { level: 2, width: 1, height: 2 },
      { level: 3, width: 1, height: 1 },
    ]);
  });

  it('derives a complete r32float mip chain for odd and minimum extents', () => {
    const odd = buildDepthPyramidPlan({ width: 5, height: 3 });
    expect(odd.format).toBe('r32float');
    expect(odd.mipLevelCount).toBe(3);
    expect(odd.levels).toEqual([
      { level: 0, width: 5, height: 3 },
      { level: 1, width: 2, height: 1 },
      { level: 2, width: 1, height: 1 },
    ]);

    const minimum = buildDepthPyramidPlan({ width: 1, height: 1 });
    expect(minimum.levels).toEqual([{ level: 0, width: 1, height: 1 }]);
  });
});
