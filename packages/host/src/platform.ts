import type { Plugin } from '@forgeax/engine-plugin';
import { createHostWebSocketClient, type HostTransportClient } from './transport.js';

export type FrontendTheme = 'light' | 'dark';
export type FrontendThemeSource = {
  getSnapshot(): FrontendTheme;
  subscribe(listener: () => void): () => void;
};

/** One owned document; transport readiness is separate from Engine readiness. */
export type FrontendFrame = {
  readonly element: HTMLIFrameElement;
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
};

/** Browser realm capabilities. Domain state and operations stay with their native owners. */
export interface FrontendPlatform {
  readonly window: Window & typeof globalThis;
  readonly document: Document;
  readonly fetch: typeof globalThis.fetch;
  readonly connectHost: (url: string) => Promise<HostTransportClient>;
  readonly createFrame: (url: string) => FrontendFrame;
  /** Optional document placement supplied by a development or embedding host. */
  readonly navigate?: (
    url: string,
    options?: { signal?: AbortSignal; replace?: boolean },
  ) => Promise<void>;
  readonly writeClipboard: (text: string) => Promise<void>;
  /** Append a titled reference to the host conversation draft without submitting it. */
  readonly addConversationReference?: (reference: { title: string; text: string }) => Promise<void>;
  readonly theme?: FrontendThemeSource;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    frontendPlatform: FrontendPlatform;
  }
}

/** The creator owns the platform lifetime; this native Fiber borrows and projects its capability. */
export function createFrontendPlatformPlugin(platform: FrontendPlatform): Plugin.Object {
  return {
    name: 'forgeax.host.frontend-platform',
    provide: ['frontendPlatform'],
    apply(ctx) {
      ctx.provide('frontendPlatform', platform);
    },
  };
}

/** Shared browser fallback for environments without the async Clipboard API. */
export async function writeBrowserClipboard(
  text: string,
  document: Document = globalThis.document,
  navigator: Navigator = globalThis.navigator,
): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Try the user-activated legacy path. */
    }
  }
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('aria-hidden', 'true');
  Object.assign(field.style, { position: 'fixed', opacity: '0', pointerEvents: 'none' });
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand('copy'))
      throw new Error('Clipboard write is unavailable in this document');
  } finally {
    field.remove();
    active?.focus();
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
}

/** Browser document ownership, independent of panel placement. */
export function createBrowserFrame(document: Document, url: string): FrontendFrame {
  const element = document.createElement('iframe');
  element.allow = 'autoplay; fullscreen';
  element.src = url;
  return {
    element,
    ready: Promise.resolve(),
    async dispose() {
      element.remove();
    },
  };
}

/** Browser realm capabilities; document navigation is selected by its consuming host. */
export function createBrowserFrontendPlatform(
  window: Window & typeof globalThis = globalThis.window,
): FrontendPlatform {
  return {
    window,
    document: window.document,
    fetch: window.fetch.bind(window),
    connectHost: (url) => createHostWebSocketClient(new window.WebSocket(url)),
    createFrame: (url) => createBrowserFrame(window.document, url),
    writeClipboard: (text) => writeBrowserClipboard(text, window.document, window.navigator),
  };
}
