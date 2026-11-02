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

/**
 * Decodes a VideoAsset envelope. A runtime descriptor carries `{ url }`; an
 * imported clip (see `videoImporter`) carries its container as one streamed
 * `source` artifact, and the decoder resolves that artifact's published URL
 * without reading the body. Either way the result is `{ kind: 'video', url }`.
 */
export const videoContribution: AssetDecoderContribution<VideoAsset, 'video'> = {
  kind: { kind: 'video' } as AssetKind<VideoAsset, 'video'>,
  consumer: 'VideoSourceProvider',
  decoder: {
    async decode({ envelope, artifacts }) {
      const payload = envelope.payload as unknown;
      const invalid = (reason: string) =>
        err({
          code: 'asset-package-invalid' as const,
          expected: 'a browser-resolvable video URL descriptor or one streamed video artifact',
          hint: 'publish an http(s) video URL, or import an .mp4/.webm source so the Pack streams it',
          detail: { guid: envelope.guid, reason },
        });
      if (payload === null || typeof payload !== 'object')
        return invalid('video owner validation failed');
      const row = payload as { readonly kind?: unknown; readonly url?: unknown };
      if (row.kind !== undefined && row.kind !== 'video')
        return invalid('video owner validation failed');
      const source = envelope.artifacts.source;
      if (row.url === undefined && source !== undefined) {
        if (source.delivery !== 'stream' || !source.mediaType.startsWith('video/'))
          return invalid('the video source artifact must be a streamed video/* body');
        const url = artifacts.locate?.(source);
        return isBrowserResolvableVideoUrl(url)
          ? ok({ kind: 'video', url })
          : invalid('the host artifact reader cannot locate the streamed video source');
      }
      return isBrowserResolvableVideoUrl(row.url)
        ? ok({ kind: 'video', url: row.url })
        : invalid('video owner validation failed');
    },
  },
};
