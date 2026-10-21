import { describe, expect, it } from 'vitest';
import { AnimationPlayerSlotLengthMismatchError } from '../player-errors';

describe('animation errors', () => {
  it('exposes structured codes and details', () => {
    const player = new AnimationPlayerSlotLengthMismatchError({
      entity: 1,
      clips: 1,
      times: 0,
      weights: 1,
      speeds: 1,
    });
    expect(player.code).toBe('animation-player-slot-length-mismatch');
  });
});
