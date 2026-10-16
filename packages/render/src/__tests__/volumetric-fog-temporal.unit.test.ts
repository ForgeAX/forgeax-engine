import { describe, expect, it } from 'vitest';
import { resolveVolumeTemporalReset, type VolumeTemporalSignature } from '../volume/temporal';

const signature: VolumeTemporalSignature = {
  cameraRevision: 4,
  fogRevision: 2,
  lightRevision: 7,
  densityGeneration: 3,
  width: 1280,
  height: 720,
  worldTimeSeconds: 4,
};

describe('volumetric fog temporal contract', () => {
  it('keeps history for a stable signature and TAA-independent volume temporal', () => {
    expect(resolveVolumeTemporalReset(signature, signature)).toEqual({ reset: false });
    expect(resolveVolumeTemporalReset(signature, signature, { taaEnabled: false })).toEqual({
      reset: false,
    });
  });

  it.each([
    ['camera-cut', { ...signature, cameraRevision: 5 }],
    ['fog-revision', { ...signature, fogRevision: 3 }],
    ['light-revision', { ...signature, lightRevision: 8 }],
    ['density-generation', { ...signature, densityGeneration: 4 }],
    ['simulation-time', { ...signature, worldTimeSeconds: 4.5 }],
    ['resize', { ...signature, width: 640, height: 360 }],
  ] as const)('resets history for %s', (reason, next) => {
    expect(resolveVolumeTemporalReset(signature, next)).toEqual({ reset: true, reason });
  });

  it.each([1 / 144, 1 / 60, 1 / 30, 1 / 15])('retains animated history at dt=%s', (delta) => {
    expect(
      resolveVolumeTemporalReset(signature, { ...signature, worldTimeSeconds: 4 + delta }),
    ).toEqual({ reset: false });
  });

  it.each([3.9, 4.101, NaN, Infinity])('rejects discontinuous time %s', (worldTimeSeconds) => {
    expect(resolveVolumeTemporalReset(signature, { ...signature, worldTimeSeconds })).toEqual({
      reset: true,
      reason: 'simulation-time',
    });
  });

  it('rejects changed clock availability', () => {
    const { worldTimeSeconds: _time, ...withoutTime } = signature;
    expect(resolveVolumeTemporalReset(signature, withoutTime)).toEqual({
      reset: true,
      reason: 'simulation-time',
    });
    expect(resolveVolumeTemporalReset(withoutTime, signature)).toEqual({
      reset: true,
      reason: 'simulation-time',
    });
  });

  it('rejects out-of-screen reprojection and depth discontinuity without NaN', () => {
    expect(
      resolveVolumeTemporalReset(signature, signature, { reprojection: 'out-of-screen' }),
    ).toEqual({
      reset: true,
      reason: 'reprojection-out-of-screen',
    });
    expect(
      resolveVolumeTemporalReset(signature, signature, { reprojection: 'depth-discontinuity' }),
    ).toEqual({
      reset: true,
      reason: 'reprojection-depth-discontinuity',
    });
  });
});
