// Page half of the Worker video bridge. The page realm owns every <video>:
// one muted inline element per Worker consumer, played or paused as the
// Worker's VideoPlayer state says. Each newly presented frame is captured as a
// WebCodecs VideoFrame (or an ImageBitmap where VideoFrame is missing) and
// transferred to the Worker, with at most one frame in flight per consumer:
// while the Worker has not acknowledged the last frame, newer presentations
// only mark the consumer dirty, so a slow Worker sees the newest frame, never
// a queue.

import {
  closeFrameSource,
  isVideoFrameRequest,
  type VideoFrameBridgeError,
  type VideoFrameBridgeErrorCode,
  type VideoFramePort,
  type VideoFrameRequest,
  videoFrameBridgeError,
} from './video-frame-protocol';

type FrameCapture = (
  video: HTMLVideoElement,
  timestamp: number,
) => Promise<VideoFrame | ImageBitmap>;

/** Some browsers lack `requestVideoFrameCallback`; the host then paces on animation frames. */
function hasVideoFrameCallback(video: HTMLVideoElement): boolean {
  return (
    typeof (video as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback ===
    'function'
  );
}

export interface VideoFrameHostOptions {
  /** Defaults to `document`. */
  readonly document?: Pick<Document, 'createElement'>;
  /** Defaults to true; browsers only autoplay muted media without a gesture. */
  readonly muted?: boolean;
  /** Defaults to `'anonymous'` so the frame stays readable for transfer. */
  readonly crossOrigin?: '' | 'anonymous' | 'use-credentials';
  /** Where a refused play() waits for a gesture. Defaults to `globalThis` when it has listeners. */
  readonly gestureTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** Frame capture override. Defaults to `VideoFrame`, then `createImageBitmap`. */
  readonly capture?: FrameCapture;
  /** Pacing fallback when the element has no `requestVideoFrameCallback`. Defaults to rAF. */
  readonly requestAnimationFrame?: (callback: () => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
}

export interface VideoFrameHost {
  /** Retry every refused play(). Call it from a user gesture handler. */
  resume(): void;
  /** Number of live page elements; diagnostics and tests. */
  readonly size: number;
  /** Stop every element, detach listeners and close the port. */
  dispose(): void;
}

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

/** Default frame capture: zero-copy VideoFrame first, ImageBitmap where WebCodecs is absent. */
export function defaultVideoFrameCapture(): FrameCapture | undefined {
  const scope = globalThis as {
    VideoFrame?: typeof VideoFrame;
    createImageBitmap?: typeof createImageBitmap;
  };
  const Frame = scope.VideoFrame;
  if (typeof Frame === 'function')
    return (video, timestamp) => Promise.resolve(new Frame(video, { timestamp }));
  const bitmap = scope.createImageBitmap;
  if (typeof bitmap === 'function') return (video) => bitmap(video);
  return undefined;
}

function defaultGestureTarget(): VideoFrameHostOptions['gestureTarget'] {
  const scope = globalThis as Partial<EventTarget>;
  return typeof scope.addEventListener === 'function'
    ? (globalThis as unknown as EventTarget)
    : undefined;
}

interface HostContext {
  readonly port: VideoFramePort;
  readonly capture: FrameCapture | undefined;
  readonly options: VideoFrameHostOptions;
  readonly blocked: Set<PageVideo>;
  armGesture(): void;
}

/** One Worker consumer on the page: its element, pacing loop and in-flight frame. */
class PageVideo {
  readonly video: HTMLVideoElement;
  private inFlight = false;
  private dirty = false;
  private pace: number | undefined;
  private paceKind: 'video' | 'animation' | undefined;
  private lastTime = -1;
  private disposed = false;
  private reported: VideoFrameBridgeErrorCode | null = null;

  constructor(
    readonly id: number,
    url: string,
    private playing: boolean,
    loop: boolean,
    private readonly ctx: HostContext,
  ) {
    const doc = ctx.options.document ?? (document as Pick<Document, 'createElement'>);
    const video = doc.createElement('video');
    video.muted = ctx.options.muted ?? true;
    video.playsInline = true;
    video.preload = 'auto';
    video.loop = loop;
    video.crossOrigin = ctx.options.crossOrigin ?? 'anonymous';
    video.addEventListener('loadeddata', this.onLoaded);
    video.addEventListener('error', this.onError);
    video.src = url;
    video.load();
    this.video = video;
    if (ctx.capture === undefined) this.report('video-frame-unsupported');
    this.apply();
  }

  setState(playing: boolean, loop: boolean): void {
    this.playing = playing;
    this.video.loop = loop;
    this.apply();
  }

  /** The Worker adopted the last frame; send the newest one if presentation moved on. */
  ack(): void {
    this.inFlight = false;
    if (!this.dirty) return;
    this.dirty = false;
    this.send();
  }

  apply(): void {
    if (this.disposed) return;
    if (!this.playing) {
      this.video.pause();
      this.stopPacing();
      return;
    }
    this.startPacing();
    if (this.video.paused) void this.video.play().then(this.onPlaying, this.onPlayRefused);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ctx.blocked.delete(this);
    this.stopPacing();
    this.video.removeEventListener('loadeddata', this.onLoaded);
    this.video.removeEventListener('error', this.onError);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }

  private readonly onLoaded = (): void => this.send();

  private readonly onError = (): void => {
    const reason = this.video.error?.message || `MediaError ${this.video.error?.code ?? '?'}`;
    this.report('video-load-failed', reason);
  };

  private readonly onPlaying = (): void => {
    this.ctx.blocked.delete(this);
    if (this.reported === 'video-autoplay-blocked') this.report(null);
  };

  private readonly onPlayRefused = (cause: unknown): void => {
    const name = (cause as { name?: unknown } | null)?.name;
    if (name === 'AbortError' || this.disposed) return;
    if (name !== 'NotAllowedError') {
      this.report('video-load-failed', String(cause));
      return;
    }
    this.ctx.blocked.add(this);
    this.ctx.armGesture();
    this.report('video-autoplay-blocked', String(cause));
  };

  private readonly tick = (): void => {
    this.pace = undefined;
    if (this.disposed || !this.playing) return;
    if (this.paceKind === 'video' || this.video.currentTime !== this.lastTime) this.send();
    this.schedule();
  };

  private startPacing(): void {
    if (this.pace === undefined) this.schedule();
  }

  private schedule(): void {
    if (hasVideoFrameCallback(this.video)) {
      this.paceKind = 'video';
      this.pace = this.video.requestVideoFrameCallback(this.tick);
      return;
    }
    const raf = this.ctx.options.requestAnimationFrame ?? globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') return;
    this.paceKind = 'animation';
    this.pace = raf(this.tick);
  }

  private stopPacing(): void {
    if (this.pace === undefined) return;
    if (this.paceKind === 'video') this.video.cancelVideoFrameCallback(this.pace);
    else (this.ctx.options.cancelAnimationFrame ?? globalThis.cancelAnimationFrame)?.(this.pace);
    this.pace = undefined;
  }

  /** Capture and transfer the presented frame, or mark dirty while one is in flight. */
  private send(): void {
    if (this.disposed || this.ctx.capture === undefined) return;
    if (this.video.readyState < 2) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    this.inFlight = true;
    this.lastTime = this.video.currentTime;
    const timestamp = Math.round(this.video.currentTime * 1e6);
    this.ctx.capture(this.video, timestamp).then(
      (frame) => this.post(frame, timestamp),
      (cause: unknown) => {
        this.inFlight = false;
        this.report('video-frame-capture-failed', String(cause));
      },
    );
  }

  private post(frame: VideoFrame | ImageBitmap, timestamp: number): void {
    if (this.disposed) {
      closeFrameSource(frame);
      return;
    }
    try {
      this.ctx.port.postMessage({ kind: 'video-frame', id: this.id, frame, timestamp }, [frame]);
      if (this.reported === 'video-frame-capture-failed') this.report(null);
    } catch (cause) {
      closeFrameSource(frame);
      this.inFlight = false;
      this.report('video-frame-capture-failed', String(cause));
    }
  }

  private report(code: VideoFrameBridgeErrorCode | null, reason?: string): void {
    if (code === this.reported) return;
    this.reported = code;
    const detail = reason === undefined ? { url: this.video.src } : { url: this.video.src, reason };
    const error: VideoFrameBridgeError | null =
      code === null ? null : videoFrameBridgeError(code, detail);
    this.ctx.port.postMessage({ kind: 'video-status', id: this.id, error });
  }
}

/**
 * Serve an Engine Worker's video demand from the page. The Worker end is
 * `installWorkerVideoSourceProvider`; App's `startEngineWorker` wires both
 * ends on a dedicated MessageChannel, so games normally never call this.
 * The Three equivalent is the page-owned `<video>` behind a `VideoTexture`.
 */
export function createVideoFrameHost(
  port: VideoFramePort,
  options: VideoFrameHostOptions = {},
): VideoFrameHost {
  const videos = new Map<number, PageVideo>();
  const blocked = new Set<PageVideo>();
  const gestureTarget = options.gestureTarget ?? defaultGestureTarget();
  let armed = false;
  let disposed = false;
  const resume = (): void => {
    disarm();
    for (const video of [...blocked]) video.apply();
  };
  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    for (const type of GESTURES) gestureTarget?.removeEventListener(type, resume, true);
  };
  const ctx: HostContext = {
    port,
    capture: options.capture ?? defaultVideoFrameCapture(),
    options,
    blocked,
    armGesture() {
      if (armed || gestureTarget === undefined) return;
      armed = true;
      for (const type of GESTURES) gestureTarget.addEventListener(type, resume, true);
    },
  };
  const handle = (request: VideoFrameRequest): void => {
    switch (request.kind) {
      case 'video-open':
        videos.get(request.id)?.dispose();
        videos.set(
          request.id,
          new PageVideo(request.id, request.url, request.playing, request.loop, ctx),
        );
        return;
      case 'video-state':
        videos.get(request.id)?.setState(request.playing, request.loop);
        return;
      case 'video-ack':
        videos.get(request.id)?.ack();
        return;
      case 'video-release':
        videos.get(request.id)?.dispose();
        videos.delete(request.id);
        return;
      case 'video-resume':
        resume();
        return;
    }
  };
  const onMessage = (event: MessageEvent): void => {
    if (!disposed && isVideoFrameRequest(event.data)) handle(event.data);
  };
  port.addEventListener('message', onMessage);
  port.start?.();
  return {
    resume,
    get size() {
      return videos.size;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disarm();
      for (const video of videos.values()) video.dispose();
      videos.clear();
      port.removeEventListener('message', onMessage);
      port.close();
    },
  };
}
