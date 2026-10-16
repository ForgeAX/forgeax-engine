import { createAudioIntentBackend } from '@forgeax/engine-audio';
import { describe, expect, it, vi } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';

const PLAY_OPTIONS = {
  loop: false,
  volume: 1,
  spatialBlend: 0,
  bus: 'sfx' as const,
};

async function flushDecode(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('HostAudioConsumer', () => {
  it('retains the latest seek during decode and stop fences the pending position', async () => {
    const engine = new WebAudioEngine();
    const pending = deferred<AudioBuffer>();
    const decode = vi.spyOn(engine, 'decode').mockReturnValue(pending.promise);
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const seek = vi.spyOn(engine, 'seek').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);
    for (const entityId of [1, 2]) {
      consumer.consume({
        kind: 'play',
        entityId,
        sourceKey: 'seek',
        bytes: Uint8Array.of(1),
        options: { ...PLAY_OPTIONS, fromPosition: 1, paused: true },
      });
      consumer.consume({ kind: 'seek', entityId, position: 2 });
      consumer.consume({ kind: 'seek', entityId, position: 3 });
      for (const position of [-1, NaN, Infinity])
        consumer.consume({ kind: 'seek', entityId, position });
    }
    consumer.consume({ kind: 'stop', entityId: 2 });
    pending.resolve({} as AudioBuffer);
    await flushDecode();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledExactlyOnceWith(1, expect.anything(), {
      ...PLAY_OPTIONS,
      fromPosition: 3,
      paused: true,
    });
    expect(seek).toHaveBeenCalledTimes(4);
    consumer.dispose();
  });
  it('decodes the complete bytes payload without using mediaType as a decoder selector', async () => {
    const engine = new WebAudioEngine();
    const buffer = {} as AudioBuffer;
    const decode = vi.spyOn(engine, 'decode').mockResolvedValue(buffer);
    vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);

    consumer.consume({
      kind: 'play',
      entityId: 7,
      sourceKey: 'typed',
      bytes: Uint8Array.of(1, 2, 3, 4),
      options: PLAY_OPTIONS,
    });
    await flushDecode();

    expect(decode).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3, 4));
    expect(decode.mock.calls[0]).toHaveLength(1);
  });

  it('decodes each sourceKey once and plays repeated intents from the cache', async () => {
    const engine = new WebAudioEngine();
    const buffer = {} as AudioBuffer;
    const decode = vi.spyOn(engine, 'decode').mockResolvedValue(buffer);
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);

    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'laser',
      bytes: new Uint8Array([1]),
      options: PLAY_OPTIONS,
    });
    consumer.consume({
      kind: 'play',
      entityId: 2,
      sourceKey: 'laser',
      options: PLAY_OPTIONS,
    });
    await flushDecode();

    expect(decode).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('invalidates stale decode authority when same sourceKey bytes churn', async () => {
    const engine = new WebAudioEngine();
    const decodeA = deferred<AudioBuffer>();
    const decodeB = deferred<AudioBuffer>();
    const decodeC = deferred<AudioBuffer>();
    const decodes = [decodeA, decodeB, decodeC];
    const bufferA = {} as AudioBuffer;
    const bufferC = {} as AudioBuffer;
    const decode = vi.spyOn(engine, 'decode').mockImplementation(() => {
      const next = decodes.shift();
      if (next === undefined) throw new Error('unexpected decode');
      return next.promise;
    });
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);

    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'laser',
      bytes: Uint8Array.of(1, 2, 3),
      options: PLAY_OPTIONS,
    });
    consumer.consume({
      kind: 'play',
      entityId: 2,
      sourceKey: 'laser',
      bytes: Uint8Array.of(1, 2, 4),
      options: PLAY_OPTIONS,
    });

    expect(decode).toHaveBeenNthCalledWith(1, Uint8Array.of(1, 2, 3));
    expect(decode).toHaveBeenNthCalledWith(2, Uint8Array.of(1, 2, 4));

    decodeA.resolve(bufferA);
    await flushDecode();
    expect(play).not.toHaveBeenCalled();

    decodeB.reject(new Error('unsupported replacement bytes'));
    await flushDecode();
    expect(consumer.state().lastError?.code).toBe('decode-failed');

    consumer.consume({
      kind: 'play',
      entityId: 3,
      sourceKey: 'laser',
      bytes: Uint8Array.of(5, 6, 7),
      options: PLAY_OPTIONS,
    });
    expect(decode).toHaveBeenNthCalledWith(3, Uint8Array.of(5, 6, 7));

    decodeC.resolve(bufferC);
    await flushDecode();

    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(3, bufferC, PLAY_OPTIONS);
    expect(consumer.state().lastError).toBeNull();
  });

  it('does not start a source whose entity was stopped while decode was pending', async () => {
    const engine = new WebAudioEngine();
    let resolveDecode: ((buffer: AudioBuffer) => void) | undefined;
    vi.spyOn(engine, 'decode').mockReturnValue(
      new Promise((resolve) => {
        resolveDecode = resolve;
      }),
    );
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    vi.spyOn(engine, 'stop').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);

    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'slow',
      bytes: new Uint8Array([1]),
      options: PLAY_OPTIONS,
    });
    consumer.consume({ kind: 'stop', entityId: 1 });
    resolveDecode?.({} as AudioBuffer);
    await flushDecode();

    expect(play).not.toHaveBeenCalled();
  });

  it('reports structured decode failure without throwing into simulation', async () => {
    const engine = new WebAudioEngine();
    vi.spyOn(engine, 'decode').mockRejectedValue(new Error('unsupported codec'));
    const consumer = createHostAudioConsumer(engine);

    expect(() =>
      consumer.consume({
        kind: 'play',
        entityId: 1,
        sourceKey: 'broken',
        bytes: new Uint8Array([0]),
        options: PLAY_OPTIONS,
      }),
    ).not.toThrow();
    await flushDecode();

    const error = consumer.state().lastError;
    expect(error?.code).toBe('decode-failed');
    if (error?.code === 'decode-failed') {
      expect((error.detail as { reason: string }).reason).toContain('unsupported codec');
    }
  });

  it('keeps a missing Host publication as a recoverable capability error', () => {
    const consumer = createHostAudioConsumer(new WebAudioEngine());
    consumer.consume({
      kind: 'play',
      entityId: 8,
      sourceKey: 'not-published',
      options: PLAY_OPTIONS,
    });
    const error = consumer.state().lastError;
    expect(error?.code).toBe('decode-failed');
    expect(error?.hint).toContain('source bytes');
    expect(error?.detail).toMatchObject({ code: 'decode-failed' });
  });
});

describe('Host lifecycle budgets and error ownership', () => {
  it('retains a first publication when the pending-play budget rejects its play', async () => {
    const engine = new WebAudioEngine();
    const firstDecode = deferred<AudioBuffer>();
    const bufferA = {} as AudioBuffer;
    const bufferB = {} as AudioBuffer;
    const decode = vi
      .spyOn(engine, 'decode')
      .mockReturnValueOnce(firstDecode.promise)
      .mockResolvedValueOnce(bufferB);
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine, { maxPendingPlays: 1 });
    const backend = createAudioIntentBackend({
      emit: (intent) => consumer.consume(intent),
      state: () => consumer.state(),
    });
    const clipA = {
      kind: 'audio' as const,
      sourceKey: 'A',
      mediaType: 'audio/wav' as const,
      bytes: Uint8Array.of(1),
    };
    const clipB = {
      kind: 'audio' as const,
      sourceKey: 'B',
      mediaType: 'audio/wav' as const,
      bytes: Uint8Array.of(2),
    };

    backend.play(1, clipA, PLAY_OPTIONS);
    backend.play(2, clipB, PLAY_OPTIONS);
    firstDecode.resolve(bufferA);
    await flushDecode();
    backend.stop(1);
    backend.play(2, clipB, PLAY_OPTIONS);
    await flushDecode();

    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenLastCalledWith(Uint8Array.of(2));
    expect(play).toHaveBeenLastCalledWith(2, bufferB, PLAY_OPTIONS);
    backend.destroy();
  });

  it('does not clear another source failure when an unrelated decode succeeds', async () => {
    const engine = new WebAudioEngine();
    vi.spyOn(engine, 'decode')
      .mockRejectedValueOnce(new Error('broken A'))
      .mockResolvedValue({} as AudioBuffer);
    vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);
    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'A',
      bytes: Uint8Array.of(1),
      options: PLAY_OPTIONS,
    });
    await vi.waitFor(() => expect(consumer.state().lastError?.code).toBe('decode-failed'));
    const failure = consumer.state().lastError;
    consumer.consume({
      kind: 'play',
      entityId: 2,
      sourceKey: 'B',
      bytes: Uint8Array.of(2),
      options: PLAY_OPTIONS,
    });
    await flushDecode();
    expect(consumer.state().lastError).toBe(failure);
    consumer.consume({ kind: 'play', entityId: 3, sourceKey: 'A', options: PLAY_OPTIONS });
    await vi.waitFor(() => expect(consumer.state().lastError).toBeNull());
    consumer.dispose();
  });

  it('bounds retained publications and releases pending entity slots after churn', async () => {
    const engine = new WebAudioEngine();
    const decode = vi
      .spyOn(engine, 'decode')
      .mockResolvedValue({ length: 1, numberOfChannels: 1 } as AudioBuffer);
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine, {
      maxCachedBytes: 8,
      maxCachedSources: 1,
      maxPendingPlays: 1,
    });
    for (let entityId = 0; entityId < 100; entityId++) {
      consumer.consume({
        kind: 'play',
        entityId,
        sourceKey: 'clip',
        ...(entityId === 0 ? { bytes: Uint8Array.of(1) } : {}),
        options: PLAY_OPTIONS,
      });
      await flushDecode();
      expect(play).toHaveBeenCalledTimes(entityId + 1);
      consumer.consume({ kind: 'stop', entityId });
    }
    expect(decode).toHaveBeenCalledTimes(1);
    consumer.consume({
      kind: 'play',
      entityId: 101,
      sourceKey: 'other',
      bytes: Uint8Array.of(2),
      options: PLAY_OPTIONS,
    });
    expect(consumer.state().lastError?.detail).toMatchObject({
      reason: expect.stringContaining('budget'),
    });
    expect(decode).toHaveBeenCalledTimes(1);
    consumer.dispose();
  });

  it('refuses a decoded sample allocation beyond its retained-byte budget', async () => {
    const engine = new WebAudioEngine();
    vi.spyOn(engine, 'decode').mockResolvedValue({
      length: 100,
      numberOfChannels: 2,
    } as AudioBuffer);
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine, { maxCachedBytes: 32 });
    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'large',
      bytes: Uint8Array.of(1),
      options: PLAY_OPTIONS,
    });
    await vi.waitFor(() => expect(consumer.state().lastError?.code).toBe('decode-failed'));
    expect(play).not.toHaveBeenCalled();
    consumer.dispose();
  });
});
