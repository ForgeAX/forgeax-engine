import { describe, expect, it } from 'vitest';
import { MotionBlur } from '../motion-blur';

describe('MotionBlur component schema', () => {
  it('is a single-semantic component with bounded authoring fields', () => {
    expect(MotionBlur.name).toBe('MotionBlur');
    expect(MotionBlur.fields).toMatchObject({
      shutterAngle: { type: 'f32', default: 180 },
      maxRadiusPixels: { type: 'f32', default: 32 },
      sampleCount: { type: 'f32', default: 8 },
      targetFps: { type: 'f32', default: 60 },
    });
    expect(MotionBlur.fields).not.toHaveProperty('enabled');
  });
});
