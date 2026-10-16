import { afterEach, expect, test, vi } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';

const options = { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' as const };

function platform(state: 'running' | 'suspended' = 'running') {
  const gains: {
    gain: {
      value: number;
      cancelScheduledValues(): void;
      setValueAtTime(value: number): void;
      linearRampToValueAtTime(value: number): void;
    };
  }[] = [];
  let resolveDecode!: (value: AudioBuffer) => void;
  const pending = new Promise<AudioBuffer>((resolve) => {
    resolveDecode = resolve;
  });
  const document = new EventTarget();
  const ctx = {
    state,
    currentTime: 0,
    destination: {},
    listener: {},
    createGain() {
      const node = {
        gain: {
          value: 1,
          cancelScheduledValues() {},
          setValueAtTime(value: number) {
            this.value = value;
          },
          linearRampToValueAtTime(value: number) {
            this.value = value;
          },
        },
        connect() {},
        disconnect() {},
      };
      gains.push(node);
      return node;
    },
    createBufferSource: () => ({
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
      buffer: null,
      playbackRate: { value: 1, setValueAtTime: vi.fn() },
      loop: false,
    }),
    decodeAudioData: () => pending,
    resume: async () => {
      throw new Error('gesture refused');
    },
    close: async () => {},
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function AudioContextFake() {
      return ctx;
    }),
  );
  return { gains, document, resolveDecode };
}

afterEach(() => vi.unstubAllGlobals());
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test('control: volume changes reach an already created source', async () => {
  const p = platform();
  const consumer = createHostAudioConsumer();
  try {
    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'clip',
      bytes: Uint8Array.of(1),
      options,
    });
    p.resolveDecode({} as AudioBuffer);
    await flush();
    consumer.consume({ kind: 'set-volume', entityId: 1, volume: 0.25 });
    expect(p.gains[15]?.gain.value).toBe(0.25);
  } finally {
    consumer.dispose();
  }
});

test('R2-A1a: mute before the first clip remains applied when the context is lazily created', async () => {
  const p = platform();
  const consumer = createHostAudioConsumer();
  try {
    consumer.consume({ kind: 'set-bus-mute', bus: 'sfx', muted: true });
    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'clip',
      bytes: Uint8Array.of(1),
      options,
    });
    p.resolveDecode({} as AudioBuffer);
    await flush();
    expect(p.gains[8]?.gain.value).toBe(0);
  } finally {
    consumer.dispose();
  }
});

test('R2-A1b: latest volume during decode applies to the source eventually created', async () => {
  const p = platform();
  const consumer = createHostAudioConsumer();
  try {
    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'clip',
      bytes: Uint8Array.of(1),
      options,
    });
    consumer.consume({ kind: 'set-volume', entityId: 1, volume: 0.25 });
    p.resolveDecode({} as AudioBuffer);
    await flush();
    expect(p.gains[15]?.gain.value).toBe(0.25);
  } finally {
    consumer.dispose();
  }
});

test('R2-A2: host audio state preserves the backend resume failure', async () => {
  const p = platform('suspended');
  const engine = new WebAudioEngine();
  const consumer = createHostAudioConsumer(engine);
  try {
    consumer.consume({
      kind: 'play',
      entityId: 1,
      sourceKey: 'clip',
      bytes: Uint8Array.of(1),
      options,
    });
    p.document.dispatchEvent(new Event('click'));
    await flush();
    expect(engine.getState().lastError?.code).toBe('context-suspended');
    expect(consumer.state().lastError?.code).toBe('context-suspended');
  } finally {
    consumer.dispose();
  }
});
