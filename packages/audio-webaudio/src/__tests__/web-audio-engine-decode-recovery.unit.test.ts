import type { AudioPlayOptions } from '@forgeax/engine-audio';
import type { AudioClipAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebAudioEngine } from '../index.js';

const PLAY_OPTIONS: AudioPlayOptions = {
  loop: false,
  volume: 1,
  spatialBlend: 0,
  bus: 'sfx',
};

const INVALID_CLIP: AudioClipAsset = {
  kind: 'audio',
  sourceKey: 'm66-direct-decode-recovery',
  mediaType: 'audio/wav',
  bytes: Uint8Array.of(0, 1, 2, 3),
};

const ORIGINAL_AUDIO_CONTEXT = globalThis.AudioContext;

function makeAudioBuffer(): AudioBuffer {
  return { duration: 0.1, length: 1, numberOfChannels: 1, sampleRate: 10 } as AudioBuffer;
}

describe('WebAudioEngine direct clip decode recovery', () => {
  afterEach(() => {
    globalThis.AudioContext = ORIGINAL_AUDIO_CONTEXT;
    vi.restoreAllMocks();
  });

  it('reports a rejected clip decode and recovers on the same entity', async () => {
    const node = {
      buffer: null,
      playbackRate: { value: 1, setValueAtTime: vi.fn() },
      loop: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    } as unknown as AudioBufferSourceNode;
    const createBufferSource = vi.fn(() => node);
    const decodeAudioData = vi.fn();
    const context = {
      state: 'running',
      destination: {},
      createGain: () => ({
        gain: { value: 1 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createBufferSource,
      createPanner: vi.fn(),
      decodeAudioData,
      close: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
    } as unknown as AudioContext;
    globalThis.AudioContext = vi.fn(function AudioContextMock() {
      return context;
    }) as unknown as typeof AudioContext;

    decodeAudioData.mockRejectedValueOnce(new Error('invalid test bytes'));
    const engine = new WebAudioEngine();
    engine.play(17, INVALID_CLIP, PLAY_OPTIONS);

    await vi.waitFor(() =>
      expect(engine.getState().lastError).toMatchObject({
        code: 'decode-failed',
        detail: { code: 'decode-failed', reason: 'invalid test bytes' },
      }),
    );
    expect(engine.getActiveSourceCount()).toBe(0);
    expect(createBufferSource).not.toHaveBeenCalled();

    const repairedClip: AudioClipAsset = {
      ...INVALID_CLIP,
      bytes: Uint8Array.of(82, 73, 70, 70),
    };
    decodeAudioData.mockResolvedValueOnce(makeAudioBuffer());
    engine.play(17, repairedClip, PLAY_OPTIONS);

    await vi.waitFor(() => expect(engine.getActiveSourceCount()).toBe(1));
    expect(decodeAudioData).toHaveBeenCalledTimes(2);
    expect(createBufferSource).toHaveBeenCalledTimes(1);
    expect(engine.getState().lastError).toBeNull();

    engine.stop(17);
    expect(engine.getActiveSourceCount()).toBe(0);
    engine.destroy();
    engine.destroy();
    expect(engine.getState()).toMatchObject({ contextState: 'closed', activeSourceCount: 0 });
  });
});
