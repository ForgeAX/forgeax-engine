import { type AudioClipAsset, err, type GuidString, ok, type Result } from '@forgeax/engine-types';

/** Saved author data. Clips use the ordinary asset catalogue, not a music registry. */
export interface MusicScore {
  readonly bpm: number;
  /** Quarter-note beats in a bar. */
  readonly beatsPerBar: number;
  readonly loopBeats: number;
  readonly stems: readonly { readonly clip: GuidString; readonly offsetSeconds?: number }[];
}

/** Host-only preparation. Encoded clips do not enter Worker music intents. */
export interface MusicPreparation extends Omit<MusicScore, 'stems'> {
  readonly stems: readonly { readonly clip: AudioClipAsset; readonly offsetSeconds?: number }[];
}

const MUSIC_FAILURE_CODES = [
  'invalid-score',
  'unsupported-stream',
  'decode-failed',
  'not-ready',
  'stale-epoch',
  'duplicate-request',
  'capacity',
  'missed-boundary',
  'conflicting-envelope',
  'context-closed',
  'invalid-command',
  'native-failed',
] as const;
export type MusicFailureCode = (typeof MUSIC_FAILURE_CODES)[number];
const MUSIC_PHASES = ['empty', 'preparing', 'ready', 'playing', 'paused', 'closed'] as const;
const MUSIC_RECEIPT_STATUSES = [
  'preparing',
  'ready',
  'scheduled',
  'applied',
  'cancelled',
  'rejected',
] as const;

export interface MusicFailure {
  readonly code: MusicFailureCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly reason: string };
}

export function musicFailure(code: MusicFailureCode, reason: string): MusicFailure {
  return {
    code,
    expected: 'a prepared bounded musical request in the current Host epoch',
    hint: 'read the music receipt and current epoch; prepare ordinary buffered clips before scheduling',
    detail: { reason },
  };
}

/** The Host assigns epochs. Request IDs increase monotonically for this consumer lifetime. */
export type MusicCommand = { readonly requestId: number } & (
  | { readonly kind: 'prepare'; readonly score: MusicPreparation }
  | {
      readonly kind: 'mix';
      readonly epoch: number;
      readonly gains: readonly number[];
      readonly boundary: 'beat' | 'bar';
      readonly atBeat?: number;
      readonly late: 'reject' | 'next-boundary';
      readonly fadeBeats?: number;
    }
  | { readonly kind: 'cancel'; readonly epoch: number; readonly cancelRequestId: number }
  | { readonly kind: 'pause' | 'resume'; readonly epoch: number }
  | { readonly kind: 'tempo'; readonly epoch: number; readonly bpm: number }
);

export interface MusicReceipt {
  readonly requestId: number;
  readonly epoch: number;
  readonly status: (typeof MUSIC_RECEIPT_STATUSES)[number];
  readonly targetTime?: number;
  readonly targetBeat?: number;
  readonly deferred?: boolean;
  readonly failure?: MusicFailure;
}

export interface MusicState {
  readonly epoch: number;
  readonly phase: (typeof MUSIC_PHASES)[number];
  readonly bpm: number;
  readonly beat: number;
  readonly sampleRate: number;
  readonly pending: number;
  readonly nodes: number;
  readonly pendingHighWater: number;
  readonly nodeHighWater: number;
  /** Latest 256 request receipts; applied certifies Context time, not speaker onset. */
  readonly receipts: readonly MusicReceipt[];
}

export function validMusicTiming(
  score: Pick<MusicScore, 'bpm' | 'beatsPerBar' | 'loopBeats'>,
): boolean {
  return (
    Number.isFinite(score.bpm) &&
    score.bpm >= 20 &&
    score.bpm <= 400 &&
    Number.isSafeInteger(score.beatsPerBar) &&
    score.beatsPerBar >= 1 &&
    score.beatsPerBar <= 16 &&
    Number.isSafeInteger(score.loopBeats) &&
    score.loopBeats >= 1 &&
    score.loopBeats <= 1024
  );
}

/** Resolve ordinary GUIDs through the caller's existing Assets.loadByGuid route. */
export async function loadMusicScore<E>(
  score: MusicScore,
  load: (guid: GuidString) => Promise<Result<AudioClipAsset, E>>,
): Promise<Result<MusicPreparation, E | MusicFailure>> {
  if (
    !validMusicTiming(score) ||
    score.stems.length < 1 ||
    score.stems.length > 16 ||
    score.stems.some(
      (stem) => !Number.isFinite(stem.offsetSeconds ?? 0) || (stem.offsetSeconds ?? 0) < 0,
    )
  )
    return err(musicFailure('invalid-score', 'tempo, meter, loop or stem bound is invalid'));
  const stems: MusicPreparation['stems'][number][] = [];
  for (const stem of score.stems) {
    const clip = await load(stem.clip);
    if (!clip.ok) return clip;
    if (clip.value.stream)
      return err(musicFailure('unsupported-stream', 'music requires prepared buffered clips'));
    stems.push({ ...stem, clip: clip.value });
  }
  return ok({ ...score, stems });
}

/** Result-report admission uses the same bounded vocabulary as the transport. */
export function isMusicState(value: unknown): value is MusicState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  if (!(MUSIC_PHASES as readonly string[]).includes(String(state.phase))) return false;
  for (const key of [
    'epoch',
    'sampleRate',
    'pending',
    'nodes',
    'pendingHighWater',
    'nodeHighWater',
  ])
    if (!Number.isSafeInteger(state[key]) || (state[key] as number) < 0) return false;
  if (
    typeof state.bpm !== 'number' ||
    !Number.isFinite(state.bpm) ||
    state.bpm < 0 ||
    typeof state.beat !== 'number' ||
    !Number.isFinite(state.beat) ||
    state.beat < 0 ||
    (state.pending as number) > 128 ||
    (state.nodes as number) > 32 ||
    !Array.isArray(state.receipts) ||
    state.receipts.length > 256
  )
    return false;
  return state.receipts.every((receipt: unknown) => {
    if (!receipt || typeof receipt !== 'object') return false;
    const row = receipt as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.requestId) ||
      (row.requestId as number) < 0 ||
      !Number.isSafeInteger(row.epoch) ||
      (row.epoch as number) < 0 ||
      !(MUSIC_RECEIPT_STATUSES as readonly unknown[]).includes(row.status)
    )
      return false;
    for (const key of ['targetTime', 'targetBeat'])
      if (
        row[key] !== undefined &&
        (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0)
      )
        return false;
    if (row.deferred !== undefined && typeof row.deferred !== 'boolean') return false;
    if (row.failure === undefined) return true;
    if (!row.failure || typeof row.failure !== 'object') return false;
    const failure = row.failure as Record<string, unknown>;
    if (
      !(MUSIC_FAILURE_CODES as readonly unknown[]).includes(failure.code) ||
      typeof failure.expected !== 'string' ||
      typeof failure.hint !== 'string' ||
      !failure.detail ||
      typeof failure.detail !== 'object'
    )
      return false;
    return typeof (failure.detail as Record<string, unknown>).reason === 'string';
  });
}
