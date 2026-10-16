import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOTION_BLUR_PARAMS,
  effectiveMotionBlurSampleCount,
  isMotionBlurIntervalValid,
  motionBlurExposureScale,
  motionBlurSampleDelta,
  motionBlurTemporalDemand,
  validateMotionBlurParams,
} from '../motion-blur-params';

describe('Motion Blur parameter validation', () => {
  it('applies the bounded defaults', () => {
    expect(validateMotionBlurParams({})).toEqual({ ok: true, value: DEFAULT_MOTION_BLUR_PARAMS });
    expect(DEFAULT_MOTION_BLUR_PARAMS).toEqual({
      shutterAngle: 180,
      maxRadiusPixels: 32,
      sampleCount: 8,
      targetFps: 60,
    });
  });

  it.each([
    [{ shutterAngle: 0 }, 'identity shutter'],
    [{ shutterAngle: 360, maxRadiusPixels: 0, sampleCount: 4 }, 'lower and upper bounds'],
    [{ shutterAngle: 12, maxRadiusPixels: 64, sampleCount: 16 }, 'valid upper bounds'],
  ] as const)('accepts %s (%s)', (input, _label) => {
    const result = validateMotionBlurParams(input);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['shutterAngle', -0.01],
    ['shutterAngle', 360.01],
    ['maxRadiusPixels', -0.01],
    ['maxRadiusPixels', 64.01],
    ['sampleCount', 3],
    ['sampleCount', 17],
    ['sampleCount', 8.5],
    ['targetFps', -1],
    ['targetFps', 240.5],
    ['targetFps', 59.5],
  ] as const)('returns structured failure for %s=%s', (field, value) => {
    const result = validateMotionBlurParams({ [field]: value });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('motion-blur-invalid-params');
      expect(result.error.detail.field).toBe(field);
      expect(result.error.expected).toContain(field);
      expect(result.error.hint).toContain(field);
    }
  });

  it('does no temporal work when omitted or shutter is zero', () => {
    expect(motionBlurTemporalDemand(undefined)).toBe(false);
    expect(
      motionBlurTemporalDemand({
        shutterAngle: 0,
        maxRadiusPixels: 32,
        sampleCount: 8,
        targetFps: 60,
      }),
    ).toBe(false);
    expect(
      motionBlurTemporalDemand({
        shutterAngle: 180,
        maxRadiusPixels: 0,
        sampleCount: 8,
        targetFps: 60,
      }),
    ).toBe(false);
    expect(motionBlurTemporalDemand(DEFAULT_MOTION_BLUR_PARAMS)).toBe(true);
  });

  it('rounds authored sample budgets down to the fixed shader tiers', () => {
    expect(effectiveMotionBlurSampleCount(3)).toBe(0);
    expect(effectiveMotionBlurSampleCount(4)).toBe(4);
    expect(effectiveMotionBlurSampleCount(7)).toBe(4);
    expect(effectiveMotionBlurSampleCount(8)).toBe(8);
    expect(effectiveMotionBlurSampleCount(15)).toBe(8);
    expect(effectiveMotionBlurSampleCount(16)).toBe(16);
  });

  it('rejects unstable intervals and scales displacement to the target rate', () => {
    expect(isMotionBlurIntervalValid(1 / 60)).toBe(true);
    expect(isMotionBlurIntervalValid(0)).toBe(false);
    expect(isMotionBlurIntervalValid(0.101)).toBe(false);
    expect(motionBlurExposureScale(1 / 60, 60)).toBeCloseTo(1);
    expect(motionBlurExposureScale(1 / 120, 60)).toBeCloseTo(2);
    expect(motionBlurExposureScale(1 / 60, 0)).toBe(1);
    expect(motionBlurExposureScale(0, 60)).toBe(0);
    expect(motionBlurExposureScale(1 / 60, 60.5)).toBe(0);
    expect(motionBlurExposureScale(1 / 60, 241)).toBe(0);
  });

  it('keeps raw render hitches visible before ECS clamp policy', () => {
    expect(motionBlurSampleDelta(1.2, 1, 0.1)).toBeCloseTo(0.2);
    expect(motionBlurSampleDelta(1 / 30, 0, 0.1)).toBeCloseTo(1 / 30);
    expect(isMotionBlurIntervalValid(motionBlurSampleDelta(1.2, 1, 0.1))).toBe(false);
    expect(isMotionBlurIntervalValid(motionBlurSampleDelta(1 / 30, 0, 0.1))).toBe(true);
    expect(motionBlurSampleDelta(undefined, undefined, 0.1)).toBe(0.1);
  });

  it('fails closed for an explicitly invalid host/replay sample', () => {
    expect(Number.isNaN(motionBlurSampleDelta(Number.NaN, 1, 1 / 60))).toBe(true);
    expect(Number.isNaN(motionBlurSampleDelta(1, Number.POSITIVE_INFINITY, 1 / 60))).toBe(true);
  });
});
