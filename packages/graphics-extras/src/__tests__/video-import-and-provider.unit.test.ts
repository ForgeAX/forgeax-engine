// A Three port could not play its billboard `.mp4`s: no importer admitted the
// container, and a VideoAsset could only come from a hand-typed URL plus a
// hand-written host provider. These gates pin the native path: the importer
// streams the container, the decoder resolves that artifact's published URL,
// and the DOM provider drives one <video> per consumer from VideoPlayer state.
import { World } from '@forgeax/engine-ecs';
import {
  type AssetHandle,
  err,
  type ImportContext,
  ok,
  type VideoAsset,
} from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { installDomVideoSourceProvider } from '../video-dom-provider';
import { videoImporter } from '../video-importer';
import { videoContribution } from '../video-loader';
import { VideoPlayer } from '../video-player';
import { VIDEO_SOURCE_PROVIDER_KEY } from '../video-source-provider';

const GUID = '019f5d11-0e1f-7c21-a4d2-7e4f6e8f2001';

function context(source: string, kind = 'video'): ImportContext {
  return {
    source,
    readSource: async () => ({ ok: true as const, value: Uint8Array.of(0, 0, 0, 24, 102, 116) }),
    readSibling: async () => ({ ok: true as const, value: new Uint8Array() }),
    decodeImage: async () => {
      throw new Error('video import must not decode');
    },
    subAssets: [{ guid: GUID, sourceIndex: 0, kind }],
    importSettings: {},
  };
}

describe('videoImporter', () => {
  it.each([
    ['billboards/ad-01.mp4', 'video/mp4'],
    ['clip.WEBM', 'video/webm'],
    ['intro.ogv', 'video/ogg'],
  ])('streams %s as one %s artifact without inlining bytes in the payload', async (source, mediaType) => {
    const result = await videoImporter.import(context(source));
    if (!result.ok) throw result.error;
    const [asset] = result.value.assets;
    expect(asset).toMatchObject({ guid: GUID, kind: 'video', refs: [] });
    expect(asset?.payload).toEqual({ kind: 'video', mediaType });
    expect(asset?.artifacts.source).toMatchObject({
      delivery: 'stream',
      mediaType,
      assetCodec: { name: 'browser-video', version: '1' },
      bytes: Uint8Array.of(0, 0, 0, 24, 102, 116),
    });
    expect(result.value.sourceDependencies).toEqual([source]);
  });

  it('admits the browser containers through asset add and refuses foreign topology', async () => {
    expect(videoImporter.capabilities?.sourceFormats?.[0]).toMatchObject({
      kind: 'video',
      extensions: ['.mp4', '.m4v', '.webm', '.ogv'],
    });
    expect(await videoImporter.import(context('a.mp4', 'texture'))).toMatchObject({
      ok: false,
      error: { code: 'source-validation-failed' },
    });
    expect(await videoImporter.import(context('a.avi'))).toMatchObject({
      ok: false,
      error: { code: 'source-validation-failed' },
    });
  });
});

describe('videoContribution', () => {
  const envelope = (payload: unknown, artifacts: Record<string, unknown> = {}) =>
    ({ guid: GUID, kind: 'video', payload, artifacts }) as never;
  const descriptor = { delivery: 'stream', path: `${GUID}/source.bin`, mediaType: 'video/mp4' };

  it('resolves an imported clip to the published URL of its streamed artifact without reading it', async () => {
    const read = vi.fn();
    const locate = vi.fn(() => `https://game.test/__pack/${GUID}/source.bin`);
    const result = await videoContribution.decoder.decode({
      envelope: envelope({ kind: 'video', mediaType: 'video/mp4' }, { source: descriptor }),
      artifacts: { read, locate },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      ok: true,
      value: { kind: 'video', url: `https://game.test/__pack/${GUID}/source.bin` },
    });
    expect(locate).toHaveBeenCalledWith(descriptor);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps runtime URL descriptors and refuses an unlocatable or eager source', async () => {
    const signal = new AbortController().signal;
    const read = vi.fn();
    expect(
      await videoContribution.decoder.decode({
        envelope: envelope({ kind: 'video', url: '/cutscene.webm' }),
        artifacts: { read },
        signal,
      }),
    ).toEqual({ ok: true, value: { kind: 'video', url: '/cutscene.webm' } });
    for (const [source, locate] of [
      [descriptor, undefined],
      [{ ...descriptor, delivery: undefined }, () => 'https://game.test/a.mp4'],
      [{ ...descriptor, mediaType: 'image/png' }, () => 'https://game.test/a.png'],
    ] as const) {
      const result = await videoContribution.decoder.decode({
        envelope: envelope({ kind: 'video' }, { source }),
        artifacts: { read, ...(locate === undefined ? {} : { locate }) },
        signal,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'asset-package-invalid' } });
    }
  });
});

class FakeVideo {
  src = '';
  muted = false;
  playsInline = false;
  preload = '';
  crossOrigin: string | null = null;
  loop = false;
  paused = true;
  currentTime = 0;
  loads = 0;
  load() {
    this.loads++;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

function providerFixture() {
  const urls = new Map<number, string>([[7, 'https://game.test/ad-01.mp4']]);
  const assets = {
    identity: 'fixture',
    attach: () => ok(undefined),
    read: (handle: AssetHandle<string, unknown>) =>
      urls.has(handle as unknown as number)
        ? ok({ kind: 'video', url: urls.get(handle as unknown as number) })
        : err({ code: 'asset-not-found' }),
    validate: () => ok(undefined),
    retain: () => ok(undefined),
    release: () => ok(undefined),
  };
  const world = new World({ assets: assets as never });
  world.components.register(VideoPlayer).unwrap();
  const created: FakeVideo[] = [];
  const document = {
    createElement: () => {
      const video = new FakeVideo();
      created.push(video);
      return video;
    },
  };
  return { world, created, document: document as never };
}

describe('installDomVideoSourceProvider', () => {
  it('creates one muted inline element per consumer from the clip URL and follows VideoPlayer', () => {
    const { world, created, document } = providerFixture();
    const provider = installDomVideoSourceProvider(world, { document }).unwrap();
    expect(world.getResource(VIDEO_SOURCE_PROVIDER_KEY)).toBe(provider);
    const clip = 7 as unknown as AssetHandle<'video', VideoAsset>;
    const entity = world.spawn({ component: VideoPlayer, data: { clip, playing: false } }).unwrap();
    const first = provider.getSource(entity, clip) as unknown as FakeVideo;
    expect(created).toHaveLength(1);
    expect(first).toMatchObject({
      src: 'https://game.test/ad-01.mp4',
      muted: true,
      playsInline: true,
      crossOrigin: 'anonymous',
      loop: false,
      paused: true,
    });
    world.set(entity, VideoPlayer, { playing: true, loop: true }).unwrap();
    expect(provider.getSource(entity, clip)).toBe(first as never);
    expect(first).toMatchObject({ paused: false, loop: true });
    expect(created).toHaveLength(1);
    world.set(entity, VideoPlayer, { playing: false }).unwrap();
    provider.getSource(entity, clip);
    expect(first.paused).toBe(true);

    // A renderable without its own VideoPlayer plays its clip looped, like a
    // Three VideoTexture whose page started the element.
    const panel = world.spawn().unwrap();
    const second = provider.getSource(panel, clip) as unknown as FakeVideo;
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ paused: false, loop: true });

    expect(provider.getSource(panel, 99 as unknown as AssetHandle<'video'>)).toBeUndefined();
    provider.release(panel);
    expect(second.src).toBe('');
    provider.dispose();
    expect(first.src).toBe('');
    expect(world.hasResource(VIDEO_SOURCE_PROVIDER_KEY)).toBe(false);
  });

  it('refuses a realm without a DOM instead of installing a provider that returns nothing', () => {
    const world = new World();
    const result = installDomVideoSourceProvider(world);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'video-dom-unavailable', detail: { realm: 'non-browser' } },
    });
    expect(world.hasResource(VIDEO_SOURCE_PROVIDER_KEY)).toBe(false);
  });
});
