// @forgeax/engine-graphics-extras - video loader (feat-20260623-world-space-video-asset M2 / w4).
//
// Descriptor-only loader for the 'video' asset kind. VideoAsset is a pure
// `{ url }` descriptor (no pixel decode, no import/cook pipeline — OOS-1);
// the runtime resolves it into an HTMLVideoElement via the host-provided
// `VideoSourceProvider` World Resource (plan-strategy D-1).
//
// The loader returns the payload as VideoAsset synchronously — no fetch or
// decode. Audio differs because its renderer-injected catalog-entry loader
// fetches and decodes a Web Audio payload before cataloguing it.
//
// Registered in wireDefaultLoaders alongside the other 10 default kinds
// (plan-strategy D-7: engine-own kind goes in the default set so AI users
// don't have to manually register it).

import {
  type AssetDecoderContribution,
  type AssetKind,
  err,
  type Loader,
  ok,
  type VideoAsset,
} from '@forgeax/engine-types';

const VIDEO_URL_RESOLUTION_BASE = 'https://forgeax.invalid/';
const VIDEO_URL_WHITESPACE = /\s/u;

function hasVideoUrlControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isBrowserResolvableVideoUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    hasVideoUrlControlCharacter(value) ||
    VIDEO_URL_WHITESPACE.test(value) ||
    value.startsWith('//')
  ) {
    return false;
  }
  try {
    const resolved = new URL(value, VIDEO_URL_RESOLUTION_BASE);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:';
  } catch {
    return false;
  }
}

export const videoLoader: Loader<VideoAsset> = {
  kind: 'video',
  load(payload: Record<string, unknown>): VideoAsset | undefined {
    if (!isBrowserResolvableVideoUrl(payload.url)) return undefined;
    return { kind: 'video', url: payload.url };
  },
};

export const videoContribution: AssetDecoderContribution<VideoAsset, 'video'> = {
  kind: { kind: 'video' } as AssetKind<VideoAsset, 'video'>,
  consumer: 'VideoSourceProvider',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload;
      return payload.kind === 'video' && isBrowserResolvableVideoUrl(payload.url)
        ? ok(payload)
        : err({
            code: 'asset-package-invalid',
            expected: 'a browser-resolvable video URL descriptor',
            hint: 'publish an http(s) video URL and let the host create the video element',
            detail: { guid: envelope.guid, reason: 'video owner validation failed' },
          });
    },
  },
};
