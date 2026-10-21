import type { VideoAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { videoContribution } from '../video-loader';
import { probeVideoHighPerfUpload, type VideoCapabilityDevice } from '../video-player-system';

function decode(url: unknown) {
  return videoContribution.decoder.decode({
    envelope: {
      guid: '11111111-1111-4111-8111-111111111111',
      kind: 'video',
      payload: { kind: 'video', url } as VideoAsset,
      refs: [],
      artifacts: {},
    },
    artifacts: {
      read: async () => {
        throw new Error('Video descriptors contain no media artifacts');
      },
    },
    signal: new AbortController().signal,
  });
}

describe('video descriptor loading and zero-copy probe', () => {
  it.each([
    '/cutscene.webm',
    'cutscene.webm',
    'http://cdn.example/video.mp4',
    'https://cdn.example/video.mp4',
  ])('preserves browser-resolvable URL %s', async (url) => {
    expect(await decode(url)).toMatchObject({ ok: true, value: { kind: 'video', url } });
  });

  it('returns a descriptor without fetching media', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('Video decode must not fetch')));
    vi.stubGlobal('fetch', fetch);
    try {
      expect((await decode('https://cdn.example/video.mp4')).ok).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    'not a url',
    'javascript:alert(1)',
    'data:video/webm;base64,AAAA',
    'file:///tmp/cutscene.webm',
    '//cdn.example/cutscene.webm',
    'cut\nscene.webm',
    '',
    '   ',
    undefined,
    null,
    42,
    {},
    [],
  ])('rejects invalid URL %j', async (url) => {
    expect(await decode(url)).toMatchObject({
      ok: false,
      error: { code: 'asset-package-invalid' },
    });
  });

  it('reads zero-copy availability from caps.externalTexture only', () => {
    const absent: VideoCapabilityDevice = { caps: { externalTexture: false } };
    const present: VideoCapabilityDevice = { caps: { externalTexture: true } };
    expect(probeVideoHighPerfUpload(undefined)).toBe(false);
    expect(probeVideoHighPerfUpload(absent)).toBe(false);
    expect(probeVideoHighPerfUpload(present)).toBe(true);
  });
});
