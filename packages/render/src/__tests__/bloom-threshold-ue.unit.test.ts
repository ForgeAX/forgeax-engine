import { describe, expect, it } from 'vitest';
import {
  CAMERA_BLOOM_THRESHOLD_MAX,
  CAMERA_BLOOM_THRESHOLD_MIN,
  validateCameraBloom,
} from '../components/camera';

// Unreal PostProcessBloom.usf BloomSetup is skipped when BloomThreshold <= -1;
// ForgeaX accepts the same [-1, max] range and treats any negative value as "off".
describe('Camera bloomThreshold Unreal range', () => {
  it('accepts -1 (Unreal default, no threshold) up to the HDR maximum', () => {
    expect(CAMERA_BLOOM_THRESHOLD_MIN).toBe(-1);
    expect(validateCameraBloom(1, -1, 0.5, 0.01, 0)).toBe('on');
    expect(validateCameraBloom(1, -0.25, 0.5, 0.01, 0)).toBe('on');
    expect(validateCameraBloom(1, CAMERA_BLOOM_THRESHOLD_MAX, 0.5, 0.01, 0)).toBe('on');
  });

  it.each([-1.001, Number.NaN, CAMERA_BLOOM_THRESHOLD_MAX + 1])('rejects %s', (value) => {
    expect(() => validateCameraBloom(1, value, 0.5, 0.01, 0)).toThrowError(/camera-bloom-invalid/);
  });
});
