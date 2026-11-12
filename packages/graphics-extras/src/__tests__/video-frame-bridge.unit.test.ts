// The default Engine realm is a DOM-less Worker, so a material that samples a
// VideoAsset there had no frames: the DOM provider refuses the realm. These
// gates pin the page-to-Worker bridge: the wire guards, one frame in flight per
// consumer, every frame closed exactly once, the provider lifecycle on the
// World, and structured refusals for unsupported realms and blocked autoplay.
import { World } from '@forgeax/engine-ecs';
import { type AssetHandle, err, ok, type VideoAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createVideoFrameHost } from '../video-frame-host';
import {
  isVideoFrameNotice,
  isVideoFrameRequest,
  videoFrameBridgeError,
} from '../video-frame-protocol';
import {
  createVideoFrameEndpoint,
  installWorkerVideoSourceProvider,
  VIDEO_FRAME_SYNC_SYSTEM,
} from '../video-frame-worker';
import { VideoPlayer } from '../video-player';
import { VIDEO_SOURCE_PROVIDER_KEY } from '../video-source-provider';

/** A frame that counts closes; closing twice is the bug these tests catch. */
class FakeFrame {
  static live = new Set<FakeFrame>();
  closes = 0;
  constructor(
    readonly source: unknown,
    readonly init?: { timestamp: number },
  ) {
    FakeFrame.live.add(this);
  }
  close() {
    this.closes++;
    FakeFrame.live.delete(this);
  }
}
const Frame = FakeFrame as unknown as typeof VideoFrame;

type Listener = (event: MessageEvent) => void;

/** Synchronous in-memory MessagePort; `held` defers delivery to test backpressure. */
class TestPort {
  peer: TestPort | undefined;
  readonly sent: unknown[] = [];
  readonly queue: unknown[] = [];
  readonly listeners = new Set<Listener>();
  held = false;
  closed = false;
  postMessage(message: unknown): void {
    this.sent.push(message);
    if (this.held) this.queue.push(message);
    else this.peer?.deliver(message);
  }
  deliver(message: unknown): void {
    for (const listener of [...this.listeners]) listener({ data: message } as MessageEvent);
  }
  addEventListener(_: 'message', listener: Listener): void {
    this.listeners.add(listener);
  }
  removeEventListener(_: 'message', listener: Listener): void {
    this.listeners.delete(listener);
  }
  start(): void {}
  close(): void {
    this.closed = true;
  }
}

function channel() {
  const page = new TestPort();
  const worker = new TestPort();
  page.peer = worker;
  worker.peer = page;
  return { page, worker };
}

function worldFixture() {
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
  return world;
}

const clip = 7 as unknown as AssetHandle<'video', VideoAsset>;

describe('video frame wire protocol', () => {
  it('admits only well-formed requests and notices', () => {
    expect(
      isVideoFrameRequest({ kind: 'video-open', id: 1, url: 'a.mp4', playing: true, loop: true }),
    ).toBe(true);
    expect(isVideoFrameRequest({ kind: 'video-open', id: 1, url: 'a.mp4' })).toBe(false);
    expect(isVideoFrameRequest({ kind: 'video-state', id: 0, playing: true, loop: true })).toBe(
      false,
    );
    expect(isVideoFrameRequest({ kind: 'video-ack', id: 3 })).toBe(true);
    expect(isVideoFrameRequest({ kind: 'video-resume' })).toBe(true);
    expect(isVideoFrameRequest({ kind: 'frame' })).toBe(false);
    expect(isVideoFrameRequest(null)).toBe(false);
    const frame = new FakeFrame(null);
    expect(isVideoFrameNotice({ kind: 'video-frame', id: 2, frame, timestamp: 0 })).toBe(true);
    expect(isVideoFrameNotice({ kind: 'video-frame', id: 2, frame: {}, timestamp: 0 })).toBe(false);
    expect(isVideoFrameNotice({ kind: 'video-status', id: 2, error: null })).toBe(true);
    expect(
      isVideoFrameNotice({
        kind: 'video-status',
        id: 2,
        error: videoFrameBridgeError('video-load-failed'),
      }),
    ).toBe(true);
    frame.close();
  });

  it('builds structured errors with expected and hint', () => {
    expect(videoFrameBridgeError('video-autoplay-blocked', { url: 'a.mp4' })).toMatchObject({
      code: 'video-autoplay-blocked',
      expected: expect.any(String),
      hint: expect.stringContaining('resume'),
      detail: { url: 'a.mp4' },
    });
  });
});

describe('installWorkerVideoSourceProvider', () => {
  it('refuses a realm without VideoFrame with video-frame-unsupported', () => {
    const world = worldFixture();
    const { worker } = channel();
    const endpoint = createVideoFrameEndpoint(worker);
    const result = installWorkerVideoSourceProvider(world, endpoint, {
      videoFrame: undefined as never,
    });
    if ((globalThis as { VideoFrame?: unknown }).VideoFrame === undefined) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('video-frame-unsupported');
      expect(world.hasResource(VIDEO_SOURCE_PROVIDER_KEY)).toBe(false);
    }
  });

  it('opens one page consumer per (entity, clip), mirrors VideoPlayer and promotes the newest frame', () => {
    const world = worldFixture();
    const { worker } = channel();
    const endpoint = createVideoFrameEndpoint(worker);
    const provider = installWorkerVideoSourceProvider(world, endpoint, {
      videoFrame: Frame,
    }).unwrap();
    expect(world.getResource(VIDEO_SOURCE_PROVIDER_KEY)).toBe(provider);
    const entity = world.spawn({ component: VideoPlayer, data: { clip, playing: false } }).unwrap();

    expect(provider.getSource(entity, clip)).toBeUndefined();
    expect(provider.getSource(entity, clip)).toBeUndefined();
    const opens = worker.sent.filter((m) => (m as { kind: string }).kind === 'video-open');
    expect(opens).toEqual([
      {
        kind: 'video-open',
        id: 1,
        url: 'https://game.test/ad-01.mp4',
        playing: false,
        loop: false,
      },
    ]);
    expect(provider.status(entity, clip).unwrap()).toMatchObject({ id: 1, hasFrame: false });

    // Two frames arrive before the next sync: the older one is closed unseen.
    const a = new FakeFrame('a');
    const b = new FakeFrame('b');
    worker.deliver({ kind: 'video-frame', id: 1, frame: a, timestamp: 0 });
    worker.deliver({ kind: 'video-frame', id: 1, frame: b, timestamp: 33_000 });
    expect(a.closes).toBe(1);
    expect(worker.sent.filter((m) => (m as { kind: string }).kind === 'video-ack')).toHaveLength(2);
    expect(provider.getSource(entity, clip)).toBeUndefined();

    world.set(entity, VideoPlayer, { playing: true, loop: true }).unwrap();
    world.update(1 / 60).unwrap();
    expect(provider.getSource(entity, clip)).toBe(b as never);
    expect(worker.sent.at(-1)).toEqual({ kind: 'video-state', id: 1, playing: true, loop: true });
    expect(provider.status(entity, clip).unwrap()).toMatchObject({
      hasFrame: true,
      received: 2,
      dropped: 1,
    });

    // The next frame replaces the bound one only at the following sync.
    const c = new FakeFrame('c');
    worker.deliver({ kind: 'video-frame', id: 1, frame: c, timestamp: 66_000 });
    expect(b.closes).toBe(0);
    world.update(1 / 60).unwrap();
    expect(b.closes).toBe(1);
    expect(provider.getSource(entity, clip)).toBe(c as never);

    // Page errors surface as Result errors on status().
    worker.deliver({
      kind: 'video-status',
      id: 1,
      error: videoFrameBridgeError('video-autoplay-blocked'),
    });
    expect(provider.status(entity, clip).ok).toBe(false);
    provider.resume();
    expect(worker.sent.at(-1)).toEqual({ kind: 'video-resume' });
    provider.dispose();
    expect(c.closes).toBe(1);
  });

  it('wraps ImageBitmap fallbacks and closes the bitmap', () => {
    const world = worldFixture();
    const { worker } = channel();
    const provider = installWorkerVideoSourceProvider(world, createVideoFrameEndpoint(worker), {
      videoFrame: Frame,
    }).unwrap();
    const entity = world.spawn().unwrap();
    provider.getSource(entity, clip);
    const bitmap = {
      closes: 0,
      close() {
        this.closes++;
      },
    };
    worker.deliver({ kind: 'video-frame', id: 1, frame: bitmap, timestamp: 5 });
    world.update(0).unwrap();
    const frame = provider.getSource(entity, clip) as unknown as FakeFrame;
    expect(frame).toBeInstanceOf(FakeFrame);
    expect(frame.source).toBe(bitmap);
    expect(frame.init).toEqual({ timestamp: 5 });
    expect(bitmap.closes).toBe(1);
    provider.dispose();
  });

  it('releases consumers of despawned entities and closes late frames for released ids', () => {
    const world = worldFixture();
    const { worker } = channel();
    const provider = installWorkerVideoSourceProvider(world, createVideoFrameEndpoint(worker), {
      videoFrame: Frame,
    }).unwrap();
    const entity = world.spawn().unwrap();
    provider.getSource(entity, clip);
    const held = new FakeFrame('held');
    worker.deliver({ kind: 'video-frame', id: 1, frame: held, timestamp: 0 });
    world.despawn(entity).unwrap();
    world.update(0).unwrap();
    expect(held.closes).toBe(1);
    expect(worker.sent.at(-1)).toEqual({ kind: 'video-release', id: 1 });
    const late = new FakeFrame('late');
    worker.deliver({ kind: 'video-frame', id: 1, frame: late, timestamp: 1 });
    expect(late.closes).toBe(1);
    provider.dispose();
  });

  it('reinstall replaces the previous provider; dispose removes only its own system and resource', () => {
    const world = worldFixture();
    const { worker } = channel();
    const endpoint = createVideoFrameEndpoint(worker);
    const first = installWorkerVideoSourceProvider(world, endpoint, { videoFrame: Frame }).unwrap();
    const entity = world.spawn().unwrap();
    first.getSource(entity, clip);
    const second = installWorkerVideoSourceProvider(world, endpoint, {
      videoFrame: Frame,
    }).unwrap();
    expect(worker.sent.at(-1)).toEqual({ kind: 'video-release', id: 1 });
    expect(world.getResource(VIDEO_SOURCE_PROVIDER_KEY)).toBe(second);
    first.dispose();
    expect(world.getResource(VIDEO_SOURCE_PROVIDER_KEY)).toBe(second);
    second.getSource(entity, clip);
    expect(worker.sent.at(-1)).toMatchObject({ kind: 'video-open', id: 2 });
    second.dispose();
    expect(world.hasResource(VIDEO_SOURCE_PROVIDER_KEY)).toBe(false);
    expect(world.removeSystem(world.scheduleToken('Update'), VIDEO_FRAME_SYNC_SYSTEM).ok).toBe(
      false,
    );
  });

  it('endpoint close detaches the port and closes frames for nobody', () => {
    const { worker } = channel();
    const endpoint = createVideoFrameEndpoint(worker);
    const stray = new FakeFrame('stray');
    worker.deliver({ kind: 'video-frame', id: 9, frame: stray, timestamp: 0 });
    expect(stray.closes).toBe(1);
    endpoint.close();
    endpoint.close();
    expect(worker.closed).toBe(true);
    expect(worker.listeners.size).toBe(0);
    endpoint.send({ kind: 'video-resume' });
    expect(worker.sent).toHaveLength(0);
  });
});

/** Page element double with controllable play() outcome and rVFC pacing. */
class PageFakeVideo {
  src = '';
  muted = false;
  playsInline = false;
  preload = '';
  crossOrigin: string | null = null;
  loop = false;
  paused = true;
  currentTime = 0;
  readyState = 4;
  error: { code: number; message: string } | null = null;
  refusal: { name: string } | undefined;
  callbacks = new Map<number, () => void>();
  nextHandle = 0;
  listeners = new Map<string, Set<() => void>>();
  load() {}
  play() {
    if (this.refusal !== undefined) return Promise.reject(this.refusal);
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  addEventListener(type: string, l: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(l);
  }
  removeEventListener(type: string, l: () => void) {
    this.listeners.get(type)?.delete(l);
  }
  emit(type: string) {
    for (const l of this.listeners.get(type) ?? []) l();
  }
  requestVideoFrameCallback(cb: () => void) {
    this.callbacks.set(++this.nextHandle, cb);
    return this.nextHandle;
  }
  cancelVideoFrameCallback(handle: number) {
    this.callbacks.delete(handle);
  }
  /** Present one frame: run pending rVFC callbacks. */
  present(time: number) {
    this.currentTime = time;
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const cb of pending) cb();
  }
}

function hostFixture() {
  const { page, worker } = channel();
  const created: PageFakeVideo[] = [];
  const gestures = new Map<string, () => void>();
  const gestureTarget = {
    addEventListener: (type: string, l: () => void) => void gestures.set(type, l),
    removeEventListener: (type: string) => void gestures.delete(type),
  };
  const captured: FakeFrame[] = [];
  const host = createVideoFrameHost(page, {
    document: {
      createElement: () => {
        const video = new PageFakeVideo();
        created.push(video);
        return video as never;
      },
    },
    gestureTarget: gestureTarget as never,
    capture: async (video, timestamp) => {
      const frame = new FakeFrame(video.currentTime, { timestamp });
      captured.push(frame);
      return frame as never;
    },
  });
  const open = (id: number, playing = true) =>
    page.deliver({
      kind: 'video-open',
      id,
      url: `https://game.test/${id}.mp4`,
      playing,
      loop: true,
    });
  return { host, page, worker, created, gestures, captured, open };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const frames = (sent: unknown[]) =>
  sent.filter((m) => (m as { kind: string }).kind === 'video-frame') as {
    frame: FakeFrame;
    timestamp: number;
  }[];

describe('createVideoFrameHost', () => {
  it('creates a muted inline element per consumer and follows play state', async () => {
    const { host, page, created, open } = hostFixture();
    open(1, false);
    expect(host.size).toBe(1);
    expect(created[0]).toMatchObject({
      src: 'https://game.test/1.mp4',
      muted: true,
      playsInline: true,
      crossOrigin: 'anonymous',
      loop: true,
      paused: true,
    });
    page.deliver({ kind: 'video-state', id: 1, playing: true, loop: false });
    await settle();
    expect(created[0]).toMatchObject({ paused: false, loop: false });
    page.deliver({ kind: 'video-release', id: 1 });
    expect(host.size).toBe(0);
    expect(created[0]?.src).toBe('');
    host.dispose();
  });

  it('keeps one frame in flight and sends the newest presentation after ack', async () => {
    const { host, page, worker, created, captured, open } = hostFixture();
    worker.held = true; // the Worker has not consumed anything yet
    open(1);
    await settle();
    const video = created[0] as PageFakeVideo;
    video.present(0.1);
    await settle();
    video.present(0.2);
    video.present(0.3);
    await settle();
    expect(frames(page.sent)).toHaveLength(1);
    expect(captured).toHaveLength(1);

    page.deliver({ kind: 'video-ack', id: 1 });
    await settle();
    const sent = frames(page.sent);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.timestamp).toBe(300_000);
    expect(captured).toHaveLength(2);
    for (const frame of captured) frame.close();
    host.dispose();
  });

  it('closes a frame whose post fails and reports capture failure', async () => {
    const { host, page, created, captured, open } = hostFixture();
    open(1);
    await settle();
    const original = page.postMessage.bind(page);
    page.postMessage = (message: unknown) => {
      if ((message as { kind: string }).kind === 'video-frame') throw new DOMException('detached');
      original(message);
    };
    (created[0] as PageFakeVideo).present(0.1);
    await settle();
    expect(captured[0]?.closes).toBe(1);
    expect(page.sent.at(-1)).toMatchObject({
      kind: 'video-status',
      id: 1,
      error: { code: 'video-frame-capture-failed' },
    });
    host.dispose();
  });

  it('reports blocked autoplay and retries on the next gesture', async () => {
    const { page } = channel();
    const created: PageFakeVideo[] = [];
    const gestures = new Map<string, () => void>();
    const host = createVideoFrameHost(page, {
      document: {
        createElement: () => {
          const video = new PageFakeVideo();
          video.refusal = { name: 'NotAllowedError' };
          created.push(video);
          return video as never;
        },
      },
      gestureTarget: {
        addEventListener: (type: string, l: () => void) => void gestures.set(type, l),
        removeEventListener: (type: string) => void gestures.delete(type),
      } as never,
      capture: async () => new FakeFrame(null) as never,
    });
    page.deliver({
      kind: 'video-open',
      id: 4,
      url: 'https://game.test/4.mp4',
      playing: true,
      loop: true,
    });
    await settle();
    expect(page.sent.at(-1)).toMatchObject({
      kind: 'video-status',
      id: 4,
      error: { code: 'video-autoplay-blocked', hint: expect.any(String) },
    });
    expect([...gestures.keys()].sort()).toEqual(['keydown', 'pointerdown', 'touchend']);
    const video = created[0] as PageFakeVideo;
    video.refusal = undefined;
    gestures.get('pointerdown')?.();
    await settle();
    expect(video.paused).toBe(false);
    expect(gestures.size).toBe(0);
    expect(page.sent.at(-1)).toEqual({ kind: 'video-status', id: 4, error: null });
    host.dispose();
  });

  it('reports load errors and unsupported capture', async () => {
    const { page } = channel();
    const created: PageFakeVideo[] = [];
    const host = createVideoFrameHost(page, {
      document: {
        createElement: () => {
          const video = new PageFakeVideo();
          created.push(video);
          return video as never;
        },
      },
      gestureTarget: { addEventListener() {}, removeEventListener() {} },
    });
    // Node has no VideoFrame nor createImageBitmap: the default capture is absent.
    if ((globalThis as { VideoFrame?: unknown }).VideoFrame === undefined) {
      page.deliver({ kind: 'video-open', id: 1, url: 'x.mp4', playing: false, loop: true });
      expect(page.sent.at(-1)).toMatchObject({ error: { code: 'video-frame-unsupported' } });
    }
    page.deliver({ kind: 'video-open', id: 2, url: 'y.mp4', playing: false, loop: true });
    const video = created.at(-1) as PageFakeVideo;
    video.error = { code: 4, message: 'unsupported source' };
    video.emit('error');
    expect(page.sent.at(-1)).toMatchObject({
      id: 2,
      error: { code: 'video-load-failed', detail: { reason: 'unsupported source' } },
    });
    host.dispose();
    expect(page.closed).toBe(true);
    expect(page.listeners.size).toBe(0);
  });

  it('end to end: Worker provider binds frames the page host captured, each closed once', async () => {
    const world = worldFixture();
    const { page, worker } = channel();
    const created: PageFakeVideo[] = [];
    const host = createVideoFrameHost(page, {
      document: {
        createElement: () => {
          const video = new PageFakeVideo();
          created.push(video);
          return video as never;
        },
      },
      gestureTarget: { addEventListener() {}, removeEventListener() {} },
      capture: async (video, timestamp) => new FakeFrame(video.currentTime, { timestamp }) as never,
    });
    FakeFrame.live.clear();
    const provider = installWorkerVideoSourceProvider(world, createVideoFrameEndpoint(worker), {
      videoFrame: Frame,
    }).unwrap();
    const entity = world
      .spawn({ component: VideoPlayer, data: { clip, playing: true, loop: true } })
      .unwrap();
    provider.getSource(entity, clip);
    await settle();
    const video = created[0] as PageFakeVideo;
    for (const time of [0.1, 0.2, 0.3]) {
      video.present(time);
      await settle();
      world.update(1 / 60).unwrap();
      expect((provider.getSource(entity, clip) as unknown as FakeFrame).source).toBe(time);
    }
    expect(FakeFrame.live.size).toBe(1);
    world.despawn(entity).unwrap();
    world.update(0).unwrap();
    expect(FakeFrame.live.size).toBe(0);
    expect(host.size).toBe(0);
    provider.dispose();
    host.dispose();
  });
});
