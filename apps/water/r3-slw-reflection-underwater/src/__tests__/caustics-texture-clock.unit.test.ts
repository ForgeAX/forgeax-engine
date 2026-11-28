import { cookWaterAsset } from '@forgeax/engine/water';
import { expect, it } from 'vitest';
import { createCausticsTextureClock } from '../caustics-texture-clock';

it('derives texture cadence from wave energy and the shared frozen or running clock', () => {
  const waves = (wavelengthM: number) => {
    const cooked = cookWaterAsset({
      kind: 'water-wave-set',
      waveSource: {
        kind: 'predefined',
        waves: [{ directionXZ: [1, 0], wavelengthM, amplitudeM: 0.1, steepness: 0.05 }],
      },
      depthMaskM: 2,
      maxWaveHeightM: 0.2,
      timeSource: 'scene-clock',
    }).unwrap();
    if (cooked.kind !== 'water-wave-set') throw new Error('Expected WaveSet');
    return cooked;
  };
  const clock = createCausticsTextureClock();
  const long = waves(8);
  const short = waves(2);
  const phase = clock.sample(long, 3);
  expect(clock.sample(long, 3)).toBe(phase);
  expect(clock.sample(long, 4) / phase).toBeCloseTo(4 / 3);
  expect(clock.sample(short, 3) / phase).toBeCloseTo(2);
  expect(clock.sample(undefined, 9)).toBe(0);
});
