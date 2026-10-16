import { resolveSkinJoints } from '@forgeax/engine-skinning';
import { describe, expect, it } from 'vitest';

describe('static rig runtime path', () => {
  it('binds joints from real consumer input without animation', () => {
    const result = resolveSkinJoints(['Root/Arm'], new Map([['Arm', 4 as never]]), 1 as never);
    expect(result.ok && Array.from(result.value)).toEqual([4]);
  });
});
