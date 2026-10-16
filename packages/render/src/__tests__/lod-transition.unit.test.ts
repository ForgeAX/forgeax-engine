import { describe, expect, it } from 'vitest';
import { lodDraws } from '../scene/visibility/lod-selector';

describe('adjacent LOD coverage', () => {
  const levels = [{ screenCoverage: 0.5 }, { screenCoverage: 0.2 }];
  const select = (height: number, ready = [true, true, true], width = 0.1) =>
    lodDraws({
      levels,
      projectedHeight: height,

      hysteresis: width,
      ready,
    });
  it('submits one level outside the transition and exactly two adjacent levels inside', () => {
    expect(select(0.6)).toEqual([{ level: 0, fade: 0 }]);
    expect(select(0.3)).toEqual([{ level: 1, fade: 0 }]);
    expect(select(0.1)).toEqual([{ level: 2, fade: 0 }]);
    expect(select(0.5)).toEqual([
      { level: 0, fade: 0.5 },
      { level: 1, fade: -0.5 },
    ]);
  });
  it('reverses continuously and preserves complementary coverage', () => {
    for (const height of [0.54, 0.52, 0.5, 0.48, 0.46, 0.48, 0.52]) {
      const pair = select(height);
      expect(pair).toHaveLength(2);
      expect((pair[0]?.fade ?? NaN) + (pair[1]?.fade ?? NaN)).toBeCloseTo(0);
      expect(pair[0]?.fade).toBeCloseTo((0.55 - height) / 0.1);
    }
  });
  it('keeps both coverage thresholds identical after float32 upload', () => {
    const pair = select(0.55 - (0.25 + 2 ** -25) * 0.1);
    expect(Math.abs(Math.fround(pair[0]?.fade ?? NaN))).toBe(
      Math.abs(Math.fround(pair[1]?.fade ?? NaN)),
    );
  });
  it('does not fade an unavailable level or an invalid projection', () => {
    expect(select(0.5, [true, false, true])).toEqual([{ level: 0, fade: 0 }]);
    expect(select(Number.NaN)).toEqual([{ level: 0, fade: 0 }]);
    expect(select(-1)).toEqual([{ level: 0, fade: 0 }]);
    expect(select(0.5, undefined, 0)).toEqual([{ level: 0, fade: 0 }]);
  });
  it('bounds wide, tightly spaced transition bands to prevent triple coverage', () => {
    for (let height = 0.01; height < 1; height += 0.001) {
      const result = lodDraws({
        levels: [{ screenCoverage: 0.5 }, { screenCoverage: 0.49 }, { screenCoverage: 0.48 }],
        projectedHeight: height,

        hysteresis: 0.9,
        ready: [true, true, true, true],
      });
      expect(result.length).toBeLessThanOrEqual(2);
      if (result.length === 2)
        expect((result[1]?.level ?? NaN) - (result[0]?.level ?? NaN)).toBe(1);
    }
  });
});
