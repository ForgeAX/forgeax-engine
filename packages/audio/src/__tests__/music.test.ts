import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { assert, expect, it, vi } from 'vitest';
import { audioContribution } from '../assets/audio-decoder';
import { type AudioIntent, createAudioIntentBackend } from '../audio-intent';
import { isMusicState, loadMusicScore, type MusicState } from '../music';

function musicAssets(sourceKey: string) {
  const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-000000002300';
  const packageUrl = 'https://music.invalid/score.pack.json';
  const { pack, publication } = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'score',
    sourceRevision: '1',
    packageUrl,
    pack: {
      assets: [
        {
          guid,
          kind: 'audio',
          payload: { kind: 'audio', sourceKey, bytes: [1], mediaType: 'audio/wav' },
          refs: [],
          artifacts: {},
        },
      ],
    },
  });
  const assets = new AssetRegistry({
    catalog: createCatalogSource({
      entries: [{ guid, kind: 'audio', sourcePath: 'score', packageUrl, publication }],
      fetch: async () => Response.json(pack),
    }),
  });
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  return assets;
}

it('resolves saved GUIDs into the existing owner and keeps handles for preparation', async () => {
  const assets = musicAssets('ordinary-guid-content');
  const saved = JSON.parse(
    '{"bpm":120,"beatsPerBar":4,"loopBeats":4,"stems":[{"clip":"aaaaaaaa-aaaa-4aaa-8aaa-000000002300","offsetSeconds":0.125}]}',
  );
  const result = await loadMusicScore(saved, assets);
  expect(result.ok && result.value.assets).toBe(assets);
  expect(result.ok && result.value.stems[0]?.offsetSeconds).toBe(0.125);
  assert(result.ok);
  const stem = result.value.stems[0];
  assert(stem);
  expect(assets.read(stem.clip).unwrap().sourceKey).toBe('ordinary-guid-content');
  assets.dispose();
});

it('refuses invalid music timing before asset IO', async () => {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const load = vi.spyOn(assets, 'load');
  const invalid = await loadMusicScore({ bpm: 0, beatsPerBar: 4, loopBeats: 4, stems: [] }, assets);
  expect(!invalid.ok && invalid.error.code).toBe('invalid-score');
  expect(load).not.toHaveBeenCalled();
  assets.dispose();
});

it('returns a structured failure when the asset owner closes between awaited stem loads', async () => {
  const assets = musicAssets('closing');
  const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-000000002300';
  const handle = (await assets.load(guid, 'audio')).unwrap();
  assets.release(handle).unwrap();
  const loading = loadMusicScore(
    { bpm: 120, beatsPerBar: 4, loopBeats: 4, stems: [{ clip: guid }, { clip: guid }] },
    assets,
  );
  assets.dispose();
  await expect(loading).resolves.toMatchObject({
    ok: false,
    error: { code: 'asset-owner-closed' },
  });
});

it('admits a bounded Worker receipt projection and rejects malformed evidence without throwing', () => {
  const state: MusicState = {
    epoch: 2,
    phase: 'ready',
    bpm: 120,
    beat: 0,
    sampleRate: 48000,
    pending: 0,
    nodes: 0,
    pendingHighWater: 128,
    nodeHighWater: 32,
    receipts: [{ requestId: 1, epoch: 2, status: 'ready' }],
  };
  expect(isMusicState(structuredClone(state))).toBe(true);
  for (const receipts of [
    [null],
    [{ ...state.receipts[0], failure: null }],
    [{ ...state.receipts[0], targetTime: Infinity }],
    Array(257).fill(state.receipts[0]),
  ])
    expect(isMusicState({ ...state, receipts })).toBe(false);
  expect(isMusicState({ ...state, pending: 129 })).toBe(false);
});

it('keeps music preparation bytes out of Worker intents while admitting ordered controls', () => {
  const emitted: AudioIntent[] = [];
  const backend = createAudioIntentBackend({
    emit: (intent) => {
      emitted.push(structuredClone(intent));
    },
  });
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  backend.music({
    kind: 'prepare',
    requestId: 1,
    score: {
      assets,
      bpm: 120,
      beatsPerBar: 4,
      loopBeats: 4,
      stems: [
        {
          clip: assets
            .create({
              kind: 'audio',
              sourceKey: 'host-only',
              mediaType: 'audio/wav',
              bytes: new Uint8Array([1, 2, 3]),
            })
            .unwrap(),
        },
      ],
    },
  });
  expect(emitted).toEqual([]);
  expect(backend.getState().music?.receipts[0]?.failure?.code).toBe('invalid-command');
  const command = {
    kind: 'mix',
    requestId: 2,
    epoch: 1,
    boundary: 'bar',
    late: 'reject',
    gains: [1],
  } as const;
  backend.music(command);
  expect(emitted).toEqual([{ kind: 'music', command }]);
});

it('keeps invalid Host-only preparation IDs inside a valid Worker failure projection', () => {
  for (const requestId of [NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
    const emitted: AudioIntent[] = [];
    const backend = createAudioIntentBackend({
      emit: (intent) => {
        emitted.push(intent);
      },
    });
    backend.music({
      kind: 'prepare',
      requestId,
      score: { assets: new AssetRegistry(), bpm: 120, beatsPerBar: 4, loopBeats: 4, stems: [] },
    });
    const state = backend.getState().music;
    expect(emitted).toEqual([]);
    expect(state?.receipts[0]?.failure?.code).toBe('invalid-command');
    expect(isMusicState(state)).toBe(true);
  }
});
