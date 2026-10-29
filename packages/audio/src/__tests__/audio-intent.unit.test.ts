import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetHandle } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { audioContribution } from '../assets/audio-decoder';
import { createAudioIntentBackend, listenerPoseFromWorldMatrix } from '../index';

const PLAY_OPTIONS = {
  loop: false,
  volume: 0.75,
  spatialBlend: 0.5,
  bus: 'sfx' as const,
};

describe('AudioIntent producer', () => {
  it('does not invent Host state without feedback', () => {
    const backend = createAudioIntentBackend({ emit() {} });
    expect(backend.getState()).toMatchObject({
      contextState: 'unavailable',
      activeSourceCount: null,
    });
    expect(backend.getActiveSourceCount()).toBeNull();
  });
  it('publishes the admitted bus values independently of author objects', () => {
    const emit = vi.fn();
    const backend = createAudioIntentBackend({ emit });
    let volumeReads = 0;
    class Bus {
      get id() {
        return 'master';
      }
      get parent() {
        return null;
      }
      get volume() {
        return volumeReads++ === 0 ? 0.5 : Number.NaN;
      }
    }
    backend.configureBuses([new Bus()]);
    expect(JSON.parse(JSON.stringify(emit.mock.calls[0]?.[0]))).toEqual({
      kind: 'configure-buses',
      buses: [{ id: 'master', parent: null, volume: 0.5 }],
    });
    const send = { bus: 'master', gain: 0.5, tap: 'pre-fader' as const };
    const buses = [
      { id: 'master', parent: null },
      { id: 'voice', parent: 'master', sends: [send] },
    ];
    backend.configureBuses(buses);
    send.gain = 100;
    buses.pop();
    expect(emit.mock.calls[1]?.[0].buses).toEqual([
      { id: 'master', parent: null },
      { id: 'voice', parent: 'master', sends: [{ bus: 'master', gain: 0.5, tap: 'pre-fader' }] },
    ]);
    backend.destroy();
  });

  it('rejects oversized graphs and invalid asset handles before Worker transport', () => {
    const assets = new AssetRegistry();
    assets.installDecoder(audioContribution.kind, audioContribution.decoder);
    const emit = vi.fn();
    const backend = createAudioIntentBackend({ emit });
    backend.configureBuses(
      Array.from({ length: 65 }, (_, id) => ({ id: String(id), parent: null })),
    );
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'failure' }));
    backend.play(1, assets, 42 as AssetHandle<'audio'>, PLAY_OPTIONS);
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'failure',
        error: expect.objectContaining({ code: 'invalid-clip-handle' }),
      }),
    );
    expect(emit.mock.calls.every(([intent]) => intent.kind === 'failure')).toBe(true);
    assets.dispose();
  });
  it('publishes asset bytes once and reuses its version afterwards', () => {
    const assets = new AssetRegistry();
    assets.installDecoder(audioContribution.kind, audioContribution.decoder);
    const clip = assets
      .create({
        kind: 'audio',
        sourceKey: 'laser',
        mediaType: 'audio/ogg',
        bytes: Uint8Array.of(1, 2, 3),
      })
      .unwrap();
    const emit = vi.fn();
    const backend = createAudioIntentBackend({ emit });
    backend.play(1, assets, clip, PLAY_OPTIONS);
    backend.play(2, assets, clip, PLAY_OPTIONS);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      kind: 'play',
      entityId: 1,
      sourceKey: 'laser',
      bytes: Uint8Array.of(1, 2, 3),
    });
    expect(emit.mock.calls[1]?.[0]).toEqual({
      kind: 'play',
      entityId: 2,
      asset: emit.mock.calls[0]?.[0].asset,
      sourceKey: 'laser',
      options: PLAY_OPTIONS,
    });
    assets.dispose();
  });
  it('publishes updated bytes without caller-maintained versions and preserves queued old bytes', () => {
    const assets = new AssetRegistry();
    assets.installDecoder(audioContribution.kind, audioContribution.decoder);
    const clip = assets
      .create({
        kind: 'audio',
        sourceKey: 'laser',
        mediaType: 'audio/ogg',
        bytes: Uint8Array.of(1, 2, 3),
      })
      .unwrap();
    const emit = vi.fn();
    const backend = createAudioIntentBackend({ emit });
    backend.play(1, assets, clip, PLAY_OPTIONS);
    backend.play(2, assets, clip, PLAY_OPTIONS);
    assets.update(clip, { bytes: Uint8Array.of(1, 2, 4) }).unwrap();
    backend.play(3, assets, clip, PLAY_OPTIONS);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls[1]?.[0]).not.toHaveProperty('bytes');
    expect(emit.mock.calls[0]?.[0].bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(emit.mock.calls[2]?.[0]).toMatchObject({
      kind: 'play',
      entityId: 3,
      sourceKey: 'laser',
      bytes: Uint8Array.of(1, 2, 4),
    });
    expect(emit.mock.calls[2]?.[0].asset.revision).toBeGreaterThan(
      emit.mock.calls[0]?.[0].asset.revision,
    );
    assets.dispose();
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
