import { err, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { type AudioIntent, createAudioIntentBackend } from '../audio-intent';
import { isMusicState, loadMusicScore, type MusicState } from '../music';

it('resolves saved ordinary GUIDs without a second registry and preserves importer failure', async () => {
  const saved = JSON.parse(
    '{"bpm":120,"beatsPerBar":4,"loopBeats":4,"stems":[{"clip":"aaaaaaaa-aaaa-4aaa-8aaa-000000002300","offsetSeconds":0.125}]}',
  );
  const visited: string[] = [];
  const result = await loadMusicScore(saved, async (guid) => {
    visited.push(guid);
    return ok({
      kind: 'audio' as const,
      sourceKey: 'ordinary-guid-content',
      bytes: new Uint8Array([1]),
      mediaType: 'audio/wav',
    });
  });
  expect(visited).toEqual([saved.stems[0].clip]);
  expect(result.ok && result.value.stems[0]?.offsetSeconds).toBe(0.125);
  const failure = { code: 'asset-not-found', hint: 'repair the source GUID' };
  expect(await loadMusicScore(saved, async () => err(failure))).toEqual(err(failure));
});

it('refuses an invalid score before asset IO and refuses streaming as a structured result', async () => {
  let calls = 0;
  const score = { bpm: 0, beatsPerBar: 4, loopBeats: 4, stems: [{ clip: 'ordinary-guid' }] };
  const invalid = await loadMusicScore<never>(score, async () => {
    calls++;
    throw new Error('must not load');
  });
  expect(!invalid.ok && invalid.error.code).toBe('invalid-score');
  expect(calls).toBe(0);
  const stream = await loadMusicScore<never>({ ...score, bpm: 120 }, async () =>
    ok({
      kind: 'audio' as const,
      sourceKey: 'stream',
      mediaType: 'audio/wav' as const,
      stream: {} as never,
    }),
  );
  expect(!stream.ok && stream.error.code).toBe('unsupported-stream');
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
    emit: (intent) => emitted.push(structuredClone(intent)),
  });
  backend.music({
    kind: 'prepare',
    requestId: 1,
    score: {
      bpm: 120,
      beatsPerBar: 4,
      loopBeats: 4,
      stems: [
        {
          clip: {
            kind: 'audio',
            sourceKey: 'host-only',
            mediaType: 'audio/wav',
            bytes: new Uint8Array([1, 2, 3]),
          },
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
    const backend = createAudioIntentBackend({ emit: (intent) => emitted.push(intent) });
    backend.music({
      kind: 'prepare',
      requestId,
      score: { bpm: 120, beatsPerBar: 4, loopBeats: 4, stems: [] },
    });
    const state = backend.getState().music;
    expect(emitted).toEqual([]);
    expect(state?.receipts[0]?.failure?.code).toBe('invalid-command');
    expect(isMusicState(state)).toBe(true);
  }
});
