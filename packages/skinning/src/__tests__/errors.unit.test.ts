import { type SkinError, SkinJointPathUnresolvedError } from '@forgeax/engine-skinning';
import { describe, expect, it } from 'vitest';

describe('skinning error boundary', () => {
  it('keeps binding errors structured and exhaustive', () => {
    const error: SkinError = new SkinJointPathUnresolvedError(2, ['Root', 'Arm'], 1);
    expect(error).toBeInstanceOf(SkinJointPathUnresolvedError);
    expect(error.code).toBe('skin-joint-path-unresolved');
    expect(error.expected).toBe('joint entity with Name="Arm" exists in the world');
    expect(error.detail.failedAtIndex).toBe(1);
    expect(error.hint.length).toBeGreaterThan(0);
  });
});
