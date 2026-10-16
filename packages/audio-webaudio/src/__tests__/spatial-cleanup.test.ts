import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebAudioEngine } from '../web-audio-engine';

function makeGainNode() {
  return {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as GainNode;
}

function makePannerNode() {
  return {
    panningModel: 'equalpower' as PanningModelType,
    orientationX: { value: 1 },
    orientationZ: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as PannerNode;
}

function makeBufferSourceNode() {
  return {
    buffer: null,
    playbackRate: { value: 1, setValueAtTime: vi.fn() },
    loop: false,
    onended: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as AudioBufferSourceNode;
}

describe('WebAudioEngine spatial cleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('disconnects the spatial graph exactly once during idempotent destroy', () => {
    const sourceGain = makeGainNode();
    const panner = makePannerNode();
    const source = makeBufferSourceNode();
    const close = vi.fn().mockResolvedValue(undefined);
    const allGains: ReturnType<typeof makeGainNode>[] = [];
    const context = {
      state: 'running' as AudioContextState,
      destination: {},
      listener: {},
      createGain: vi.fn(() => {
        if (allGains.length === 15) {
          allGains.push(sourceGain);
          return sourceGain;
        }
        const node = makeGainNode();
        allGains.push(node);
        return node;
      }),
      createPanner: vi.fn().mockReturnValue(panner),
      createBufferSource: vi.fn().mockReturnValue(source),
      close,
    } as unknown as AudioContext;
    const AudioContextMock = vi.fn(function AudioContextMock() {
      return context;
    });
    vi.stubGlobal('AudioContext', AudioContextMock);

    const engine = new WebAudioEngine();
    engine.play(1, {} as AudioBuffer, {
      loop: true,
      volume: 1,
      spatialBlend: 1,
      bus: 'sfx',
    });

    engine.destroy();
    engine.destroy();

    expect(source.stop).toHaveBeenCalledOnce();
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(sourceGain.disconnect).toHaveBeenCalledOnce();
    expect(panner.disconnect).toHaveBeenCalledOnce();
    for (const gain of allGains) expect(gain.disconnect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(engine.getState()).toMatchObject({ contextState: 'closed', activeSourceCount: 0 });
  });
});
