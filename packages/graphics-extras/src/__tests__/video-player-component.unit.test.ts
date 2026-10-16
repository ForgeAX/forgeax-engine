// feat-20260623-world-space-video-asset M3 / w6 — AC-04: VideoPlayer ECS
// component registration + mount + read-back.
//
// AC-04 (requirements.md:66): a new `VideoPlayer` component must register
// through `defineComponent`, mount on a spawned entity, and read back its
// field values via `world.get`. The reference field `clip` must be a handle
// type (NOT a bare GUID string); the field set must include at least
// playing / loop / currentTime.
//
// Decision anchors:
//   - plan-strategy D-4 (clip: Handle<'VideoAsset','shared'>, brand string
//     'VideoAsset' aligns with AudioSource.clip: Handle<'AudioClipAsset',
//     'shared'>).
//   - research Finding 5 (ECS schema vocab is closed — VideoPlayer fields use
//     only shared<T> / bool / f32, no opaque/object field type).
//   - charter P4 (consistent abstraction: same defineComponent pattern as
//     AudioSource / Transform / Camera).

import { World } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { VideoPlayer } from '../video-player';

describe('AC-04 — VideoPlayer component registration + mount + read-back', () => {
  it('VideoPlayer is a schema token owned by the importing package', () => {
    expect(VideoPlayer.name).toBe('VideoPlayer');
  });

  it('spawn entity with VideoPlayer + read back clip/playing/loop/currentTime', () => {
    const world = new World();
    const clip: Handle<'VideoAsset', 'shared'> = toShared<'VideoAsset'>(42);

    const e = world
      .spawn({
        component: VideoPlayer,
        data: { clip, playing: true, loop: true, currentTime: 3.5 },
      })
      .unwrap();

    const r = world.get(e, VideoPlayer).unwrap();
    // clip is the raw u32 carried inside the Handle brand (43 in handle terms).
    expect(r.clip).toBe(42);
    expect(r.playing).toBe(true);
    expect(r.loop).toBe(true);
    expect(r.currentTime).toBe(3.5);
  });

  it('clip is a handle type (numeric u32), not a bare GUID string', () => {
    const world = new World();
    const clip: Handle<'VideoAsset', 'shared'> = toShared<'VideoAsset'>(7);

    const e = world.spawn({ component: VideoPlayer, data: { clip } }).unwrap();

    const r = world.get(e, VideoPlayer).unwrap();
    // AC-04 red line: the reference field is a handle (number), never a GUID
    // string. A bare GUID string would fail the typeof check below.
    expect(typeof r.clip).toBe('number');
    expect(r.clip).toBe(7);
  });

  it('playing/loop/currentTime default to false/false/0 when omitted at spawn', () => {
    const world = new World();
    const clip: Handle<'VideoAsset', 'shared'> = toShared<'VideoAsset'>(1);

    const e = world.spawn({ component: VideoPlayer, data: { clip } }).unwrap();
    const r = world.get(e, VideoPlayer).unwrap();
    expect(r.playing).toBe(false);
    expect(r.loop).toBe(false);
    expect(r.currentTime).toBe(0);
  });
});
