// Video descriptor loading and the zero-copy capability probe.

import { describe, expect, it, vi } from 'vitest';
import { videoLoader } from '../video-loader';
import { probeVideoHighPerfUpload, type VideoCapabilityDevice } from '../video-player-system';

describe('video descriptor loading and zero-copy probe', () => {
  it('rejects a malformed durable URL descriptor without fetching', () => {
    expect(
      videoLoader.load({ kind: 'video', url: 'not a url' }, undefined, {} as never),
    ).toBeUndefined();
  });

  it.each([
    ['/cutscene.webm', '/cutscene.webm'],
    ['cutscene.webm', 'cutscene.webm'],
    ['http://cdn.example/video.mp4', 'http://cdn.example/video.mp4'],
    ['https://cdn.example/video.mp4', 'https://cdn.example/video.mp4'],
  ] as const)('accepts browser-resolvable URL %s without normalizing it', (input, output) => {
    expect(videoLoader.load({ kind: 'video', url: input }, undefined, {} as never)).toEqual({
      kind: 'video',
      url: output,
    });
  });

  it('returns a valid URL descriptor without invoking network fetch', () => {
    const fetch = vi.fn(() => Promise.reject(new Error('video Cook must not fetch')));
    vi.stubGlobal('fetch', fetch);
    try {
      expect(
        videoLoader.load(
          { kind: 'video', url: 'https://cdn.example/video.mp4' },
          undefined,
          {} as never,
        ),
      ).toEqual({ kind: 'video', url: 'https://cdn.example/video.mp4' });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    'javascript:alert(1)',
    'data:video/webm;base64,AAAA',
    'file:///tmp/cutscene.webm',
    '//cdn.example/cutscene.webm',
    'cut\nscene.webm',
    '',
    '   ',
  ])('rejects unsafe or empty URL %j', (url) => {
    expect(videoLoader.load({ kind: 'video', url }, undefined, {} as never)).toBeUndefined();
  });

  it.each([undefined, null, 42, {}, []])('rejects non-string URL %j', (url) => {
    expect(videoLoader.load({ kind: 'video', url }, undefined, {} as never)).toBeUndefined();
  });

  it('keeps descriptor loading independent from the optional GPU capability', () => {
    expect(probeVideoHighPerfUpload(undefined)).toBe(false);
    expect(
      videoLoader.load(
        { kind: 'video', url: 'https://cdn.example/cutscene.webm' },
        undefined,
        {} as never,
      ),
    ).toEqual({ kind: 'video', url: 'https://cdn.example/cutscene.webm' });
  });

  it('returns false when no device is wired', () => {
    expect(probeVideoHighPerfUpload(undefined)).toBe(false);
  });

  it('reads zero-copy availability from caps.externalTexture only', () => {
    const absent: VideoCapabilityDevice = { caps: { externalTexture: false } };
    const present: VideoCapabilityDevice = { caps: { externalTexture: true } };
    expect(probeVideoHighPerfUpload(absent)).toBe(false);
    expect(probeVideoHighPerfUpload(present)).toBe(true);
  });
});
