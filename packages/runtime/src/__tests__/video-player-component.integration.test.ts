import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { VideoPlayer } from '@forgeax/engine-graphics-extras';
import { afterEach, describe, expect, it } from 'vitest';

const owners: AssetRegistry[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

describe('AC-04 — VideoPlayer component registration + mount + read-back', () => {
  it('VideoPlayer is a schema token owned by the importing package', () => {
    expect(VideoPlayer.name).toBe('VideoPlayer');
  });

  it('spawn entity with VideoPlayer + read back clip/playing/loop/currentTime', () => {
    const assets = new AssetRegistry();
    owners.push(assets);
    const world = new World({ assets });
    const clip = assets.create({ kind: 'video', url: 'test-video.webm' }).unwrap();

    const e = world
      .spawn({
        component: VideoPlayer,
        data: { clip, playing: true, loop: true, currentTime: 3.5 },
      })
      .unwrap();

    const r = world.get(e, VideoPlayer).unwrap();
    expect(r.clip).toBe(clip);
    expect(r.playing).toBe(true);
    expect(r.loop).toBe(true);
    expect(r.currentTime).toBe(3.5);
  });

  it('clip is a handle type (numeric u32), not a bare GUID string', () => {
    const assets = new AssetRegistry();
    owners.push(assets);
    const world = new World({ assets });
    const clip = assets.create({ kind: 'video', url: 'test-video.webm' }).unwrap();

    const e = world.spawn({ component: VideoPlayer, data: { clip } }).unwrap();

    const r = world.get(e, VideoPlayer).unwrap();
    // AC-04 red line: the reference field is a handle (number), never a GUID
    // string. A bare GUID string would fail the typeof check below.
    expect(typeof r.clip).toBe('number');
    expect(r.clip).toBe(clip);
  });

  it('playing/loop/currentTime default to false/false/0 when omitted at spawn', () => {
    const assets = new AssetRegistry();
    owners.push(assets);
    const world = new World({ assets });
    const clip = assets.create({ kind: 'video', url: 'test-video.webm' }).unwrap();

    const e = world.spawn({ component: VideoPlayer, data: { clip } }).unwrap();
    const r = world.get(e, VideoPlayer).unwrap();
    expect(r.playing).toBe(false);
    expect(r.loop).toBe(false);
    expect(r.currentTime).toBe(0);
  });
});
