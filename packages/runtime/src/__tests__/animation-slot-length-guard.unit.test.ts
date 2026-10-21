import { AnimationPlayer, advanceAnimationPlayer } from '@forgeax/engine-animation';
import { World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { testAssets } from './helpers/runtime-assets';

function makeClip(duration: number): AnimationClip {
  return { kind: 'animation-clip', duration, channels: [] };
}

interface StructuredError {
  code?: unknown;
  hint?: unknown;
}

describe('AnimationPlayer — slot-length guard (M1 / w2)', () => {
  it('rejects unequal parallel-array lengths with a structured error (no silent pad/truncate)', () => {
    const world = new World();
    const clipOne = testAssets(world).create(makeClip(10)).unwrap();
    const clipTwo = testAssets(world).create(makeClip(10)).unwrap();

    // clips/times/speeds carry two slots; weights carries only one — a
    // consumer that forgot to keep the four columns length-synced.
    world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [clipOne, clipTwo],
          times: new Float64Array([0, 0]),
          weights: new Float32Array([1]),
          speeds: new Float32Array([1, 1]),
        },
      })
      .unwrap();

    let caught: StructuredError | undefined;
    try {
      advanceAnimationPlayer(world, 0.5);
    } catch (e) {
      caught = e as StructuredError;
    }

    expect(caught).toBeDefined();
    expect(caught?.code).toBe('animation-player-slot-length-mismatch');
    expect(typeof caught?.hint).toBe('string');
    expect((caught?.hint as string).length).toBeGreaterThan(0);
  });

  it('does not throw when the four columns are length-synced', () => {
    const world = new World();
    const clip = testAssets(world).create(makeClip(10)).unwrap();

    world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [clip],
          times: new Float64Array([0]),
          weights: new Float32Array([1]),
          speeds: new Float32Array([1]),
        },
      })
      .unwrap();

    expect(() => advanceAnimationPlayer(world, 0.5)).not.toThrow();
  });
});
