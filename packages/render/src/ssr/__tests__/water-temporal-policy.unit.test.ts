import { describe, expect, it } from 'vitest';
import { WaterSsrTemporalValue } from '../../components/screen-space-reflection';
import { waterSsrTemporalEnabled } from '../water-profile';

describe('Water SSR temporal policy', () => {
  it.each([
    'none',
    'fxaa',
    'smaa',
    'msaa',
    'taa',
  ] as const)('derives auto, always and off from the same %s camera mode', (antialias) => {
    expect(waterSsrTemporalEnabled(antialias, WaterSsrTemporalValue.auto)).toBe(
      antialias !== 'taa',
    );
    expect(waterSsrTemporalEnabled(antialias, WaterSsrTemporalValue.always)).toBe(true);
    expect(waterSsrTemporalEnabled(antialias, WaterSsrTemporalValue.off)).toBe(false);
  });
});
