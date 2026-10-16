import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { audioLoader } from '@forgeax/engine-audio-webaudio';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AudioClipAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const AUDIO_GUID = 'db30f00d-0000-4000-8000-000000000001';
const PACK_INDEX_URL = '/pack-index.json';
const PACKAGE_URL = '/assets/audio.pack.json';
const ARTIFACT_URL = '/assets/audio/source.bin';

function audioPack(byteLength = 16) {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: AUDIO_GUID,
        kind: 'audio',
        payload: { kind: 'audio', mediaType: 'audio/wav' },
        refs: [],
        artifacts: {
          source: {
            path: 'audio/source.bin',
            mediaType: 'audio/wav',
            assetCodec: { name: 'browser-audio' },
            contentEncoding: 'identity',
            byteLength,
          },
        },
      },
    ],
  };
}

describe('audio loadByGuid', () => {
  const originalFetch = globalThis.fetch;
  const originalAudioContext = globalThis.AudioContext;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.AudioContext = originalAudioContext;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads and catalogues an audio GUID through its Pack v2 artifact', async () => {
    const audioData = new ArrayBuffer(16);
    const audioContext = vi.fn();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ guid: AUDIO_GUID, packageUrl: PACKAGE_URL, kind: 'audio' }],
        });
      }
      if (url === PACKAGE_URL) {
        return Promise.resolve({ ok: true, json: async () => audioPack() });
      }
      if (url === ARTIFACT_URL) {
        return Promise.resolve({ ok: true, arrayBuffer: async () => audioData });
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    globalThis.AudioContext = audioContext as unknown as typeof AudioContext;

    const registry = new AssetRegistry(makeMockShaderRegistry(), undefined, [audioLoader]);
    registry.configurePackIndex(PACK_INDEX_URL);
    const parsed = AssetGuid.parse(AUDIO_GUID);
    if (!parsed.ok) throw new Error('test GUID must be valid');

    const first = await registry.loadByGuid<AudioClipAsset>(parsed.value);
    const second = await registry.loadByGuid<AudioClipAsset>(parsed.value);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok) throw first.error;
    if (!second.ok) throw second.error;
    expect(first.value).toEqual({
      kind: 'audio',
      sourceKey: AUDIO_GUID,
      mediaType: 'audio/wav',
      bytes: new Uint8Array(audioData),
    });
    expect(second.value).toBe(first.value);
    expect(registry.lookup(parsed.value)).toBe(first.value);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(audioContext).not.toHaveBeenCalled();
  });

  it('defers malformed-byte rejection to the Host audio consumer', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ guid: AUDIO_GUID, packageUrl: PACKAGE_URL, kind: 'audio' }],
        });
      }
      if (url === PACKAGE_URL) {
        return Promise.resolve({ ok: true, json: async () => audioPack(8) });
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    globalThis.AudioContext = vi.fn().mockImplementation(function AudioContextMock() {
      return {
        decodeAudioData: vi.fn().mockRejectedValue(new Error('bad audio')),
        close: vi.fn(),
      } as unknown as AudioContext;
    }) as unknown as typeof AudioContext;

    const registry = new AssetRegistry(makeMockShaderRegistry(), undefined, [audioLoader]);
    registry.configurePackIndex(PACK_INDEX_URL);
    const parsed = AssetGuid.parse(AUDIO_GUID);
    if (!parsed.ok) throw new Error('test GUID must be valid');

    const result = await registry.loadByGuid<AudioClipAsset>(parsed.value);

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.sourceKey).toBe(AUDIO_GUID);
    expect(result.value.bytes).toEqual(new Uint8Array(8));
  });
});
