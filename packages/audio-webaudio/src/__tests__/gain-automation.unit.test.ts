import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebAudioEngine } from '../web-audio-engine.js';

type TracedParam = {
  value: number;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  valueSets: ReturnType<typeof vi.fn>;
};

type TracedGain = {
  node: GainNode;
  param: TracedParam;
};

function makeGain(initialValue: number): TracedGain {
  let value = initialValue;
  const valueSets = vi.fn((next: number) => {
    value = next;
  });
  const param = {
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn((next: number) => {
      value = next;
    }),
    linearRampToValueAtTime: vi.fn((next: number) => {
      value = next;
    }),
    valueSets,
  } as TracedParam;
  Object.defineProperty(param, 'value', {
    configurable: true,
    get: () => value,
    set: valueSets,
  });

  return {
    param,
    node: {
      gain: param as unknown as AudioParam,
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as GainNode,
  };
}

function makeBuffer(): AudioBuffer {
  return {
    sampleRate: 48000,
    length: 48000,
    duration: 1,
    numberOfChannels: 1,
    getChannelData: vi.fn(() => new Float32Array(48000)),
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

function installAudioContext() {
  const gains = Array.from({ length: 16 }, () => makeGain(1));
  let gainIndex = 0;
  const source = {
    buffer: null,
    playbackRate: { value: 1, setValueAtTime: vi.fn() },
    loop: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null,
  } as unknown as AudioBufferSourceNode;
  const ctx = {
    state: 'running' as AudioContextState,
    currentTime: 12.5,
    destination: { connect: vi.fn(), disconnect: vi.fn() },
    listener: {},
    createGain: vi.fn(() => gains[gainIndex++]?.node ?? makeGain(1).node),
    createBufferSource: vi.fn(() => source),
    createPanner: vi.fn(),
    decodeAudioData: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext & { currentTime: number };
  const audioContextCtor = vi.fn(function AudioContextMock() {
    return ctx;
  });
  vi.stubGlobal('AudioContext', audioContextCtor);

  return { ctx, audioContextCtor, source, gains };
}

function expectTransition(param: TracedParam, now: number, start: number, target: number): void {
  expect(param.cancelScheduledValues).toHaveBeenLastCalledWith(now);
  expect(param.setValueAtTime).toHaveBeenLastCalledWith(start, now);
  expect(param.linearRampToValueAtTime).toHaveBeenLastCalledWith(target, now + 0.01);
}

describe('WebAudioEngine live gain automation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cancel-replaces bounded source and bus transitions and converges to latest targets', () => {
    const { ctx, audioContextCtor, source, gains } = installAudioContext();
    const engine = new WebAudioEngine();
    engine.play(1, makeBuffer(), { loop: true, volume: 0.5, spatialBlend: 0, bus: 'sfx' });

    const sourceGain = gains[15]?.param;
    const sfxGain = gains[9]?.param;
    const musicGain = gains[14]?.param;
    expect(sourceGain).toBeDefined();
    expect(sfxGain).toBeDefined();
    expect(musicGain).toBeDefined();
    if (!sourceGain || !sfxGain || !musicGain) return;

    sourceGain.valueSets.mockClear();
    sfxGain.valueSets.mockClear();
    musicGain.valueSets.mockClear();

    engine.setVolume(1, 0.75);
    expectTransition(sourceGain, 12.5, 0.5, 0.75);

    ctx.currentTime = 12.51;
    engine.setVolume(1, 0.25);
    expectTransition(sourceGain, 12.51, 0.75, 0.25);
    expect(sourceGain.cancelScheduledValues).toHaveBeenCalledTimes(2);
    expect(sourceGain.linearRampToValueAtTime).toHaveBeenCalledTimes(2);
    expect(sourceGain.valueSets).not.toHaveBeenCalled();

    engine.setBusVolume('sfx', 0.4);
    expectTransition(sfxGain, 12.51, 1, 0.4);
    engine.setBusVolume('music', 2);
    expectTransition(musicGain, 12.51, 1, 2);
    expect(sfxGain.valueSets).not.toHaveBeenCalled();
    expect(musicGain.valueSets).not.toHaveBeenCalled();

    const musicMute = gains[13]?.param;
    if (!musicMute) throw new Error('missing music mute gain');
    engine.setBusMute('music', true);
    expectTransition(musicMute, 12.51, 1, 0);
    engine.setBusMute('music', false);
    expectTransition(musicMute, 12.51, 0, 1);

    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
    expect(engine.getActiveSourceCount()).toBe(1);
    expect(source.start).toHaveBeenCalledTimes(1);
  });

  it('ignores non-finite or negative dynamic targets without changing the cache', () => {
    const { ctx, gains } = installAudioContext();
    const engine = new WebAudioEngine();
    engine.play(1, makeBuffer(), { loop: true, volume: 0.5, spatialBlend: 0, bus: 'sfx' });

    const sourceGain = gains[15]?.param;
    const musicGain = gains[14]?.param;
    expect(sourceGain).toBeDefined();
    expect(musicGain).toBeDefined();
    if (!sourceGain || !musicGain) return;

    engine.setBusVolume('music', 0.4);
    const sourceRamps = sourceGain.linearRampToValueAtTime.mock.calls.length;
    const musicRamps = musicGain.linearRampToValueAtTime.mock.calls.length;

    engine.setVolume(1, -1);
    engine.setVolume(1, Number.NaN);
    engine.setBusVolume('music', Number.POSITIVE_INFINITY);
    engine.setBusMute('music', true);
    engine.setBusMute('music', false);

    expect(sourceGain.linearRampToValueAtTime).toHaveBeenCalledTimes(sourceRamps);
    expect(musicGain.linearRampToValueAtTime).toHaveBeenCalledTimes(musicRamps);
    expect(musicGain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0.4, ctx.currentTime + 0.01);
    expect(gains[13]?.param.linearRampToValueAtTime).toHaveBeenLastCalledWith(
      1,
      ctx.currentTime + 0.01,
    );
  });
});
