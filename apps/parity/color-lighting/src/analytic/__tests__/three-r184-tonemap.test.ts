import { describe, expect, it } from 'vitest';
import { THREE_R184_TONE_MODES, toneMapThreeR184, type ThreeR184ToneMode } from '../three-r184-tonemap';

const ramp: readonly [number, number, number] = [0.18, 1.5, 8];

const expectedAtExposureOne: Record<ThreeR184ToneMode, readonly [number, number, number]> = {
  linear: [0.18, 1, 1],
  reinhard: [0.15254237288135591, 0.6, 0.8888888888888888],
  cineon: [0.2253997126833474, 0.7689248664042744, 0.9489294219869132],
  'aces-filmic': [0.7161650295874333, 0.8541025730866384, 0.9904050179979638],
  agx: [0.5476284199187452, 0.7664113715327612, 1],
  neutral: [0.5156177652278897, 0.5960736725246258, 0.9922580645161292],
};

function expectRgbClose(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(3);
  for (let index = 0; index < 3; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index] ?? 0, 10);
  }
}

describe('Three r184 tone mapping analytic oracle', () => {
  it('covers the six public same-name modes', () => {
    expect(THREE_R184_TONE_MODES).toEqual(['linear', 'reinhard', 'cineon', 'aces-filmic', 'agx', 'neutral']);
  });

  it.each(THREE_R184_TONE_MODES)('%s matches the fixed ramp at exposure 1', (mode) => {
    expectRgbClose(toneMapThreeR184(mode, ramp, 1), expectedAtExposureOne[mode]);
  });

  it.each(THREE_R184_TONE_MODES)('%s applies exposure before its curve', (mode) => {
    const exposed = toneMapThreeR184(mode, ramp, 2);
    const doubled = toneMapThreeR184(mode, [ramp[0] * 2, ramp[1] * 2, ramp[2] * 2], 1);
    expectRgbClose(exposed, doubled);
  });

  it('keeps the boundary behavior distinct across the modes', () => {
    const linear = toneMapThreeR184('linear', ramp, 1);
    const reinhard = toneMapThreeR184('reinhard', ramp, 1);
    const cineon = toneMapThreeR184('cineon', ramp, 1);
    expect(linear).not.toEqual(reinhard);
    expect(reinhard).not.toEqual(cineon);
    expect(toneMapThreeR184('neutral', [0, 0, 0], 1)).toEqual([0, 0, 0]);
  });
});
