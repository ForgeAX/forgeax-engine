import { describe, expect, it } from 'vitest';
import { audioLoader } from '../audio-loader';

describe('audio Pack v2 loader contract', () => {
  it('returns the persisted media type with the complete source bytes', async () => {
    const loadPack = audioLoader.loadPack;
    if (loadPack === undefined) throw new Error('audio loader must expose Pack v2 loading');
    const result = (await loadPack(
      {
        guid: 'audio-guid',
        kind: 'audio',
        payload: { kind: 'audio', mediaType: 'audio/ogg' },
        refs: [],
        artifacts: {
          source: {
            descriptor: { path: 'audio.ogg', mediaType: 'audio/ogg' },
            bytes: Uint8Array.of(1, 2),
          },
        },
      } as never,
      {} as never,
    )) as { readonly ok: boolean; readonly value?: Record<string, unknown> };

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ kind: 'audio', mediaType: 'audio/ogg' });
      expect(result.value?.bytes).toEqual(Uint8Array.of(1, 2));
    }
  });

  it('requires asset-local source input instead of a catalog URL row', async () => {
    const result = (await audioLoader.load(
      {
        guid: 'audio-guid',
        kind: 'audio',
        payload: { kind: 'audio' },
        refs: [],
        artifacts: {
          source: {
            descriptor: { path: 'audio.ogg', mediaType: 'audio/ogg' },
            bytes: Uint8Array.of(1, 2),
          },
        },
      } as never,
      {} as never,
      {} as never,
    )) as {
      readonly ok: boolean;
      readonly error?: unknown;
    };
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it('rejects an audio payload without its persisted media type', async () => {
    const loadPack = audioLoader.loadPack;
    if (loadPack === undefined) throw new Error('audio loader must expose Pack v2 loading');
    const result = (await loadPack(
      {
        guid: 'audio-guid',
        kind: 'audio',
        payload: { kind: 'audio' },
        refs: [],
        artifacts: {
          source: {
            descriptor: { path: 'audio.ogg', mediaType: 'audio/ogg' },
            bytes: Uint8Array.of(1, 2),
          },
        },
      } as never,
      {} as never,
    )) as { readonly ok: boolean };
    expect(result.ok).toBe(false);
  });

  it('rejects a payload whose media type disagrees with the source artifact', async () => {
    const loadPack = audioLoader.loadPack;
    if (loadPack === undefined) throw new Error('audio loader must expose Pack v2 loading');
    const result = (await loadPack(
      {
        guid: 'audio-guid',
        kind: 'audio',
        payload: { kind: 'audio', mediaType: 'audio/ogg' },
        refs: [],
        artifacts: {
          source: {
            descriptor: { path: 'audio.wav', mediaType: 'audio/wav' },
            bytes: Uint8Array.of(1, 2),
          },
        },
      } as never,
      {} as never,
    )) as { readonly ok: boolean; readonly error?: unknown };

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'asset-artifact-media-unsupported',
        detail: { artifactKey: 'source', observed: 'audio/ogg' },
      });
    }
  });
});
