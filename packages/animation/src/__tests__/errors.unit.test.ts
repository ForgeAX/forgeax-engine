import { describe, expect, it } from 'vitest';
import { AnimationGraphClipMissingError } from '../errors';
import { AnimationPlayerSlotLengthMismatchError } from '../player-errors';

describe('animation errors', () => {
  it('exposes structured codes and details', () => {
    const graph = new AnimationGraphClipMissingError({ node: 1, clip: 2 });
    const player = new AnimationPlayerSlotLengthMismatchError({
      entity: 1,
      clips: 1,
      times: 0,
      weights: 1,
      speeds: 1,
    });
    expect(graph.code).toBe('animation-graph-clip-missing');
    expect(graph.detail.node).toBe(1);
    expect(player.code).toBe('animation-player-slot-length-mismatch');
  });
});
