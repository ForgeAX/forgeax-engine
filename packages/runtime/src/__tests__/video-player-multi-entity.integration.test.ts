import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { VideoPlayer } from '@forgeax/engine-graphics-extras';
import { afterEach, describe, expect, it } from 'vitest';

const owners: AssetRegistry[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

describe('AC-05 — multi-entity VideoPlayer independent play state', () => {
  it('two entities share one VideoAsset GUID with distinct loop/currentTime', () => {
    const assets = new AssetRegistry();
    owners.push(assets);
    const world = new World({ assets });
    // Same VideoAsset handle (one GUID) referenced by both entities.
    const clip = assets.create({ kind: 'video', url: 'test-video.webm' }).unwrap();

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
    expect(ra.clip).toBe(clip);
    expect(rb.clip).toBe(clip);

    // Play state is per-entity, no crosstalk.
    expect(ra.loop).toBe(true);
    expect(rb.loop).toBe(false);
    expect(ra.currentTime).toBe(5);
    expect(rb.currentTime).toBe(10);
    expect(ra.playing).toBe(true);
    expect(rb.playing).toBe(false);
  });

  it('mutating entity A play state does not leak into entity B', () => {
    const assets = new AssetRegistry();
    owners.push(assets);
    const world = new World({ assets });
    const clip = assets.create({ kind: 'video', url: 'test-video.webm' }).unwrap();

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
