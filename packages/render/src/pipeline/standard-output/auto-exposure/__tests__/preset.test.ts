import { describe, expect, it } from 'vitest';
import { AUTO_EXPOSURE_PRESET_V1, type AutoExposurePreset } from '../preset';

describe('auto-exposure product preset', () => {
  it('freezes the V1 sampling, histogram, clipping, and middle-gray contract', () => {
    const preset: AutoExposurePreset = AUTO_EXPOSURE_PRESET_V1;
    expect(preset).toMatchObject({
      version: 'auto-exposure-v1',
      histogramBins: 256,
      sampleBlockSize: 4,
      lowPercentile: 0.05,
      highPercentile: 0.95,
      middleGray: 0.18,
    });
    expect(Object.isFrozen(preset)).toBe(true);
  });

  it('keeps product constants separate from external formula references', () => {
    expect(AUTO_EXPOSURE_PRESET_V1.referenceFormulas).toEqual([
      'linear-rgb-to-xyz-d65',
      'bradford-d65-adaptation',
      'cielab-delta-e-2000',
    ]);
    expect(AUTO_EXPOSURE_PRESET_V1).not.toHaveProperty('histogramBuckets');
  });
});
