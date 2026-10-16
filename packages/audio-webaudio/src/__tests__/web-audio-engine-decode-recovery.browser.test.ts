import type { AudioPlayOptions } from '@forgeax/engine-audio';
import type { AudioClipAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebAudioEngine } from '../index.js';

const PLAY_OPTIONS: AudioPlayOptions = {
  loop: false,
  volume: 0,
  spatialBlend: 0,
  bus: 'sfx',
};

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function makeSilentWav(): Uint8Array {
  const sampleRate = 8000;
  const sampleCount = 800;
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  return bytes;
}

async function waitForDecodeFailure(engine: WebAudioEngine): Promise<void> {
  const started = Date.now();
  while (engine.getState().lastError?.code !== 'decode-failed') {
    if (Date.now() - started > 5000) {
      throw new Error('Timed out waiting for direct WebAudioEngine decode-failed state');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForSourceCount(
  engine: WebAudioEngine,
  target: number,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (engine.getActiveSourceCount() !== target) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Timed out waiting for activeSourceCount=\${target}; got \${engine.getActiveSourceCount()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('M66 browser - direct clip decode failure recovery', () => {
  let engine: WebAudioEngine | undefined;

  afterEach(() => {
    engine?.destroy();
    engine?.destroy();
    engine = undefined;
  });

  it('keeps the real context clean and retries repaired bytes on the same engine', async () => {
    engine = new WebAudioEngine();
    void engine.listener;
    document.dispatchEvent(new Event('click'));

    const started = Date.now();
    while (engine.getState().contextState !== 'running') {
      if (Date.now() - started > 5000) {
        throw new Error('Timed out waiting for the real AudioContext to run');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    let unhandledRejections = 0;
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      unhandledRejections += 1;
      event.preventDefault();
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    try {
      const brokenClip: AudioClipAsset = {
        kind: 'audio',
        sourceKey: 'm66-browser-direct-decode-recovery',
        mediaType: 'audio/wav',
        bytes: Uint8Array.of(0, 1, 2, 3),
      };
      engine.play(23, brokenClip, PLAY_OPTIONS);

      await waitForDecodeFailure(engine);
      expect(engine.getState().lastError).toMatchObject({
        code: 'decode-failed',
        detail: { code: 'decode-failed' },
      });
      expect(engine.getActiveSourceCount()).toBe(0);

      const repairedClip: AudioClipAsset = {
        ...brokenClip,
        bytes: makeSilentWav(),
      };
      // Observe admission synchronously: a 100 ms native one-shot can finish
      // before a throttled browser timer samples it.
      const play = engine.play.bind(engine);
      const admittedCounts: number[] = [];
      vi.spyOn(engine, 'play').mockImplementation((entityId, clip, options) => {
        play(entityId, clip, options);
        if (!('kind' in clip)) admittedCounts.push(engine?.getActiveSourceCount() ?? -1);
      });
      engine.play(23, repairedClip, PLAY_OPTIONS);

      await expect.poll(() => admittedCounts, { timeout: 5000 }).toEqual([1]);
      expect(engine.getState().lastError).toBeNull();
      await waitForSourceCount(engine, 0, 5000);
      expect(unhandledRejections).toBe(0);
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    }
  });
});
