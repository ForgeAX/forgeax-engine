// feat-20260623-world-space-video-asset M3 / w8 — AC-05: multiple entities
// share one VideoAsset GUID with independent play state.
//
// AC-05 (requirements.md:67): two entities referencing the SAME VideoAsset
// GUID, each with its own VideoPlayer, may hold different loop / currentTime
// without crosstalk. Per-entity playing / loop / currentTime occupy
// independent archetype column slots (research Finding 6 — AudioSource already
// proves this pattern).
//
// Decision anchors:
//   - requirements AC-05 (same GUID, different play state, no crosstalk).
//   - research Finding 6 (ECS archetype columns isolate per-entity fields).

import { World } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { VideoPlayer } from '../video-player';

describe('AC-05 — multi-entity VideoPlayer independent play state', () => {
  it('two entities share one VideoAsset GUID with distinct loop/currentTime', () => {
    const world = new World();
    // Same VideoAsset handle (one GUID) referenced by both entities.
    const clip: Handle<'VideoAsset', 'shared'> = toShared<'VideoAsset'>(99);

    const a = world
      .spawn({
        component: VideoPlayer,
        data: { clip, playing: true, loop: true, currentTime: 5 },
      })
      .unwrap();
    const b = world
      .spawn({
        component: VideoPlayer,
        data: { clip, playing: false, loop: false, currentTime: 10 },
      })
      .unwrap();

    const ra = world.get(a, VideoPlayer).unwrap();
    const rb = world.get(b, VideoPlayer).unwrap();

    // Both reference the identical clip GUID.
    expect(ra.clip).toBe(99);
    expect(rb.clip).toBe(99);

    // Play state is per-entity, no crosstalk.
    expect(ra.loop).toBe(true);
    expect(rb.loop).toBe(false);
    expect(ra.currentTime).toBe(5);
    expect(rb.currentTime).toBe(10);
    expect(ra.playing).toBe(true);
    expect(rb.playing).toBe(false);
  });

  it('mutating entity A play state does not leak into entity B', () => {
    const world = new World();
    const clip: Handle<'VideoAsset', 'shared'> = toShared<'VideoAsset'>(42);

    const a = world.spawn({ component: VideoPlayer, data: { clip, currentTime: 0 } }).unwrap();
    const b = world.spawn({ component: VideoPlayer, data: { clip, currentTime: 0 } }).unwrap();

    // Advance only A's playhead.
    world.set(a, VideoPlayer, { currentTime: 7.25, loop: true });

    const ra = world.get(a, VideoPlayer).unwrap();
    const rb = world.get(b, VideoPlayer).unwrap();

    expect(ra.currentTime).toBe(7.25);
    expect(ra.loop).toBe(true);
    // B untouched — independent column slot.
    expect(rb.currentTime).toBe(0);
    expect(rb.loop).toBe(false);
  });
});
