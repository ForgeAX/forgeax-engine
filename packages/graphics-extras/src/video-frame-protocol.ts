// Wire contract between the page (which owns the <video> elements) and an
// Engine Worker (which owns the World). The Worker announces demand and play
// state; the page answers with transferred frames and per-consumer status.
// One consumer is one (renderable entity, clip) pair, named by a Worker id.

/** Expected bridge failures. Every one is reported per consumer, never thrown. */
export type VideoFrameBridgeErrorCode =
  | 'video-autoplay-blocked'
  | 'video-load-failed'
  | 'video-frame-unsupported'
  | 'video-frame-capture-failed';

export interface VideoFrameBridgeError {
  readonly code: VideoFrameBridgeErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly url?: string; readonly reason?: string };
}

/** Worker to page. */
export type VideoFrameRequest =
  | {
      readonly kind: 'video-open';
      readonly id: number;
      readonly url: string;
      readonly playing: boolean;
      readonly loop: boolean;
    }
  | {
      readonly kind: 'video-state';
      readonly id: number;
      readonly playing: boolean;
      readonly loop: boolean;
    }
  | { readonly kind: 'video-release'; readonly id: number }
  /** The Worker adopted the in-flight frame; the page may send the next one. */
  | { readonly kind: 'video-ack'; readonly id: number }
  /** Retry every play() the browser refused; call from a user gesture when possible. */
  | { readonly kind: 'video-resume' };

/** Page to Worker. `frame` is transferred; the receiver closes it exactly once. */
export type VideoFrameNotice =
  | {
      readonly kind: 'video-frame';
      readonly id: number;
      readonly frame: VideoFrame | ImageBitmap;
      /** Media time in microseconds. */
      readonly timestamp: number;
    }
  | {
      readonly kind: 'video-status';
      readonly id: number;
      readonly error: VideoFrameBridgeError | null;
    };

/** The minimal MessagePort surface both ends use; tests inject an in-memory pair. */
export interface VideoFramePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  start?(): void;
  close(): void;
}

const ERROR_TEXT: Record<VideoFrameBridgeErrorCode, { expected: string; hint: string }> = {
  'video-autoplay-blocked': {
    expected: 'the page may start muted inline playback',
    hint: 'the browser refused play(); the page retries on the next pointer or key gesture, or call provider.resume() from one',
  },
  'video-load-failed': {
    expected: 'a reachable, decodable video URL that allows CORS reads',
    hint: 'check the clip URL, its container/codec support and its Access-Control-Allow-Origin header',
  },
  'video-frame-unsupported': {
    expected:
      'WebCodecs VideoFrame (or createImageBitmap) on the page and VideoFrame in the Engine Worker',
    hint: 'use a Chromium, Firefox 130+ or Safari 16.4+ browser, or run the Engine realm locally with installDomVideoSourceProvider',
  },
  'video-frame-capture-failed': {
    expected: 'the decoded frame can be wrapped for transfer',
    hint: 'a cross-origin clip without CORS cannot be read; serve it with Access-Control-Allow-Origin',
  },
};

export function videoFrameBridgeError(
  code: VideoFrameBridgeErrorCode,
  detail: VideoFrameBridgeError['detail'] = {},
): VideoFrameBridgeError {
  return { code, ...ERROR_TEXT[code], detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function hasPlayState(value: Record<string, unknown>): boolean {
  return typeof value.playing === 'boolean' && typeof value.loop === 'boolean';
}

/** Page-side admission of one Worker message. */
export function isVideoFrameRequest(value: unknown): value is VideoFrameRequest {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'video-open':
      return isId(value.id) && typeof value.url === 'string' && hasPlayState(value);
    case 'video-state':
      return isId(value.id) && hasPlayState(value);
    case 'video-release':
    case 'video-ack':
      return isId(value.id);
    case 'video-resume':
      return true;
    default:
      return false;
  }
}

function isFrameSource(value: unknown): value is VideoFrame | ImageBitmap {
  return isRecord(value) && typeof (value as { close?: unknown }).close === 'function';
}

/** Worker-side admission of one page message. */
export function isVideoFrameNotice(value: unknown): value is VideoFrameNotice {
  if (!isRecord(value) || !isId(value.id)) return false;
  if (value.kind === 'video-frame')
    return isFrameSource(value.frame) && typeof value.timestamp === 'number';
  if (value.kind === 'video-status')
    return value.error === null || (isRecord(value.error) && typeof value.error.code === 'string');
  return false;
}

/** Close a frame or bitmap that no owner will adopt; the caller is its only owner. */
export function closeFrameSource(source: VideoFrame | ImageBitmap): void {
  try {
    source.close();
  } catch {
    // An already detached source has nothing left to release.
  }
}
