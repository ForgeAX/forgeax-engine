// VideoAsset is a URL descriptor; the Host provider owns media decoding and playback.

import {
  type AssetDecoderContribution,
  type AssetKind,
  err,
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

export function isBrowserResolvableVideoUrl(value: unknown): value is string {
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

export const videoContribution: AssetDecoderContribution<VideoAsset, 'video'> = {
  kind: { kind: 'video' } as AssetKind<VideoAsset, 'video'>,
  consumer: 'VideoSourceProvider',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload;
      return payload !== null &&
        typeof payload === 'object' &&
        (payload.kind === undefined || payload.kind === 'video') &&
        isBrowserResolvableVideoUrl(payload.url)
        ? ok({ kind: 'video', url: payload.url })
        : err({
            code: 'asset-package-invalid',
            expected: 'a browser-resolvable video URL descriptor',
            hint: 'publish an http(s) video URL and let the host create the video element',
            detail: { guid: envelope.guid, reason: 'video owner validation failed' },
          });
    },
  },
};
