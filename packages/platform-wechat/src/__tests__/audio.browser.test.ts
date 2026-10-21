import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { audioContribution } from '@forgeax/engine-audio';
import type { Platform, PlatformEvent } from '@forgeax/engine-platform';
import { type AudioClipAsset, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createWechatAudioBackend } from '../audio.js';

const pose = {
  positionX: 0,
  positionY: 0,
  positionZ: 0,
  forwardX: 0,
  forwardY: 0,
  forwardZ: -1,
  upX: 0,
  upY: 1,
  upZ: 0,
};

function tone(): AudioClipAsset {
  const bytes = new Uint8Array(44 + 16000);
  const view = new DataView(bytes.buffer);
  for (const [offset, word] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const)
    for (let index = 0; index < word.length; index++)
      view.setUint8(offset + index, word.charCodeAt(index));
  for (const [offset, value] of [
    [4, bytes.length - 8],
    [16, 16],
    [24, 8000],
    [28, 16000],
    [40, 16000],
  ] as const)
    view.setUint32(offset, value, true);
  for (const [offset, value] of [
    [20, 1],
    [22, 1],
    [32, 2],
    [34, 16],
  ] as const)
    view.setUint16(offset, value, true);
  for (let index = 0; index < 8000; index++)
    view.setInt16(
      44 + index * 2,
      Math.round(Math.sin((2 * Math.PI * 440 * index) / 8000) * 8192),
      true,
    );
  return { kind: 'audio' as const, sourceKey: 'native-audio-tone', mediaType: 'audio/wav', bytes };
}

it('reuses real decode, gain, panner and source nodes through native lifecycle and destroy', async () => {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  const decode = vi.spyOn(context, 'decodeAudioData');
  const gain = vi.spyOn(context, 'createGain');
  const panner = vi.spyOn(context, 'createPanner');
  const source = vi.spyOn(context, 'createBufferSource');
  const close = vi.spyOn(context, 'close');
  const acquire = vi.fn(() => context);
  const events = new Set<(event: PlatformEvent) => void>();
  const touch = new Set<() => void>();
  let visible = true;
  const errors: unknown[] = [];
  const backend = createWechatAudioBackend(
    {
      createWebAudioContext: acquire,
      onTouchStart: (listener) => {
        touch.add(listener);
      },
      offTouchStart: (listener) => {
        touch.delete(listener);
      },
    },
    {
      visible: () => visible,
      subscribe: (listener: (event: PlatformEvent) => void) => {
        events.add(listener);
        return ok(() => {
          events.delete(listener);
        });
      },
    } as Platform,
    { onError: (error) => errors.push(error) },
  );
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const clip = assets.create(tone()).unwrap();
  try {
    expect(acquire).not.toHaveBeenCalled();
    backend.setListenerPose(pose);
    backend.play(1, assets, clip, {
      loop: true,
      volume: 0.5,
      spatialBlend: 1,
      bus: 'sfx',
      sourcePose: { ...pose, positionX: 1 },
    });
    await expect.poll(() => backend.getActiveSourceCount()).toBe(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(gain.mock.results[0]?.value).toBeInstanceOf(GainNode);
    expect(panner.mock.results[0]?.value).toBeInstanceOf(PannerNode);
    const first = source.mock.results[0]?.value as AudioBufferSourceNode;
    expect(first.buffer?.sampleRate).toBe(48000);
    expect(first.buffer?.getChannelData(0).some((value) => Math.abs(value) > 0.2)).toBe(true);
    backend.setPaused(1, true);
    backend.seek(1, 0.25);
    backend.setPlaybackRate(1, 1.5);
    backend.setPaused(1, false);
    const resumed = source.mock.results.at(-1)?.value as AudioBufferSourceNode;
    expect(resumed).not.toBe(first);
    expect(resumed.playbackRate.value).toBe(1.5);
    visible = false;
    for (const listener of events) listener({ kind: 'visibility', visible });
    await expect.poll(() => context.state).toBe('suspended');
    visible = true;
    for (const listener of touch) listener();
    await expect.poll(() => context.state).toBe('running');
    backend.play(2, assets, clip, { loop: false, volume: 0, spatialBlend: 0, bus: 'sfx' });
    await expect.poll(() => backend.getActiveSourceCount()).toBe(2);
    expect(decode).toHaveBeenCalledTimes(1);
    backend.stop(1);
    expect(backend.getActiveSourceCount()).toBe(1);
    backend.destroy();
    await expect.poll(() => context.state).toBe('closed');
    expect(close).toHaveBeenCalledTimes(1);
    expect([events.size, touch.size]).toEqual([0, 0]);
    expect(backend.getState()).toMatchObject({
      activeSourceCount: 0,
      contextState: 'closed',
      cache: { pendingPlays: 0 },
    });
    expect(errors).toEqual([]);
  } finally {
    backend.destroy();
    assets.dispose();
    if (context.state !== 'closed') await context.close();
  }
});
