import { describe, expect, it } from 'vitest';
import {
  CUBE_COUNT_DEFAULT,
  DIRECTIONAL_LIGHT_CAST_SHADOW,
  DIRECTIONAL_LIGHT_COLOR,
  DIRECTIONAL_LIGHT_DIRECTION,
  DIRECTIONAL_LIGHT_INTENSITY,
  PERF_WORKLOAD_SEED,
  PUNCTUAL_DECAY_EXPONENT,
  cubePositions,
  parseWorkloadOptions,
  positionsChecksum,
  workloadFingerprint,
} from '../workload';

describe('10k cubes workload authority', () => {
  it('keeps the default count, seed, positions, and fingerprint deterministic', () => {
    const options = parseWorkloadOptions(new URLSearchParams());
    expect(options).toEqual({
      ok: true,
      value: { cubeCount: CUBE_COUNT_DEFAULT, pointLightCount: 16, spotLightCount: 16 },
    });
    if (!options.ok) return;
    expect(PERF_WORKLOAD_SEED).toBe(0x010c0b35);
    expect(PUNCTUAL_DECAY_EXPONENT).toBe(2);
    expect(DIRECTIONAL_LIGHT_DIRECTION).toEqual([0.4, -0.8, -0.4]);
    expect(DIRECTIONAL_LIGHT_COLOR).toEqual([1, 1, 1]);
    expect(DIRECTIONAL_LIGHT_INTENSITY).toBe(1);
    expect(DIRECTIONAL_LIGHT_CAST_SHADOW).toBe(false);
    expect(positionsChecksum(cubePositions(options.value))).toBe('fc215c24');
    expect(workloadFingerprint(options.value)).toContain('hash=');
    expect(workloadFingerprint(options.value)).toContain('perf-10k-cubes-lights/v3');
    expect(workloadFingerprint(options.value)).toContain('directional=dir(0.4,-0.8,-0.4),color(1,1,1),intensity(1),shadow(0)');
    expect(workloadFingerprint(options.value)).toContain('punctualDecay=2');
    expect(workloadFingerprint(options.value)).toBe(workloadFingerprint(options.value));

    const zeroPunctual = { ...options.value, pointLightCount: 0, spotLightCount: 0 };
    expect(workloadFingerprint(zeroPunctual)).toContain('directional=dir(0.4,-0.8,-0.4),color(1,1,1),intensity(1),shadow(0)');
    expect(workloadFingerprint(zeroPunctual)).not.toBe(workloadFingerprint(options.value));
  });

  it('rejects light overflow and does not clamp explicit scale values', () => {
    const result = parseWorkloadOptions(
      new URLSearchParams({ cubes: '1000', pointLights: '200', spotLights: '57' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('workload-light-budget-exceeded');
    expect(result.error.detail).toEqual({ pointLightCount: 200, spotLightCount: 57 });
  });
});
