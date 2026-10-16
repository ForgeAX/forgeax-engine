import { describe, expect, it } from 'vitest';
import { buildDepthPyramidPlan } from '../depth-pyramid/plan';

describe('depth pyramid plan', () => {
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
