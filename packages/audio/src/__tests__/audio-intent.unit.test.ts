import { describe, expect, it, vi } from 'vitest';
import { createAudioIntentBackend, listenerPoseFromWorldMatrix } from '../index';

const PLAY_OPTIONS = {
  loop: false,
  volume: 0.75,
  spatialBlend: 0.5,
  bus: 'sfx' as const,
};

describe('AudioIntent producer', () => {
  it('rejects oversized graph and stream publications before serialization or Worker transport', () => {
    const emit = vi.fn();
    const backend = createAudioIntentBackend({ emit });
    backend.configureBuses(
      Array.from({ length: 65 }, (_, id) => ({ id: String(id), parent: null })),
    );
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'failure' }));
    const serialize = vi.fn(() => {
      throw new Error('must not serialize rejected metadata');
    });
    backend.play(
      1,
      {
        kind: 'audio',
        sourceKey: 'oversized-index',
        mediaType: 'audio/wav',
        stream: {
          format: 'wav-pcm16/1',
          sampleRate: 48000,
          channels: 1,
          frames: 48000,
          dataOffset: 44,
          chunkFrames: 48000,
          hashes: new Array(16385).fill('a'.repeat(64)),
          url: 'https://example.test/audio.wav',
          toJSON: serialize,
        },
      } as Parameters<typeof backend.play>[1],
      PLAY_OPTIONS,
    );
    expect(serialize).not.toHaveBeenCalled();
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'failure',
        error: expect.objectContaining({ code: 'stream-failed' }),
      }),
    );
    expect(emit.mock.calls.every(([intent]) => intent.kind === 'failure')).toBe(true);
  });
  it('publishes source bytes once and reuses sourceKey afterwards', () => {
    const emit = vi.fn();
    const backend = createAudioIntentBackend({ emit });
    const clip = {
      kind: 'audio' as const,
      sourceKey: 'laser',
      mediaType: 'audio/ogg' as const,
      bytes: new Uint8Array([1, 2, 3]),
    };

    backend.play(1, clip, PLAY_OPTIONS);
    backend.play(2, clip, PLAY_OPTIONS);

    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      kind: 'play',
      entityId: 1,
      sourceKey: 'laser',
      bytes: clip.bytes,
    });
    expect(emit.mock.calls[1]?.[0]).toEqual({
      kind: 'play',
      entityId: 2,
      sourceKey: 'laser',
      options: PLAY_OPTIONS,
    });
  });

  it('republishes bytes when a stable sourceKey receives changed content', () => {
    const emit = vi.fn();
    const backend = createAudioIntentBackend({ emit });
    const clipA = {
      kind: 'audio' as const,
      sourceKey: 'laser',
      mediaType: 'audio/ogg' as const,
      bytes: new Uint8Array([1, 2, 3]),
    };
    const clipB = { ...clipA, bytes: new Uint8Array([1, 2, 4]) };

    backend.play(1, clipA, PLAY_OPTIONS);
    backend.play(2, clipA, PLAY_OPTIONS);
    backend.play(3, clipB, PLAY_OPTIONS);

    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls[1]?.[0]).not.toHaveProperty('bytes');
    expect(emit.mock.calls[2]?.[0]).toMatchObject({
      kind: 'play',
      entityId: 3,
      sourceKey: 'laser',
      bytes: clipB.bytes,
    });
  });

  it('projects a scaled world matrix into normalized host listener pose', () => {
    const world = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
    expect(listenerPoseFromWorldMatrix(world)).toEqual({
      positionX: 5,
      positionY: 6,
      positionZ: 7,
      forwardX: -0,
      forwardY: -0,
      forwardZ: -1,
      upX: 0,
      upY: 1,
      upZ: 0,
    });
  });
});
