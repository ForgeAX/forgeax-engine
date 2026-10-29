import { type AudioClipAsset, AudioError } from '@forgeax/engine-types';
import {
  type AcousticEnvironment,
  type AcousticRoutes,
  validateAcousticEnvironment,
  validateAcousticRoutes,
} from './acoustic-controls';
import type {
  AudioBackend,
  AudioListenerPose,
  AudioPlayOptions,
  AudioPreparationReceipt,
  AudioSourcePose,
  AudioState,
  BusName,
} from './audio-backend';
import { type AudioBus, prepareAudioBuses } from './audio-buses';
import { validAudioStream } from './audio-stream';
import { type AudioClipIdentity, audioClipKey, borrowAudioClip } from './clip-publication';
import { type MusicCommand, musicFailure } from './music';

export type AudioIntent =
  | { readonly kind: 'cancel-clip-preparation'; readonly requestId: string }
  | {
      readonly kind: 'prepare-clips';
      readonly requestId: string;
      readonly clips: readonly {
        readonly asset: AudioClipIdentity;
        readonly sourceKey: string;
        readonly bytes: Uint8Array;
      }[];
    }
  | { readonly kind: 'music'; readonly command: Exclude<MusicCommand, { kind: 'prepare' }> }
  | {
      readonly kind: 'set-acoustic-routes';
      readonly entityId: number;
      readonly routes: AcousticRoutes;
    }
  | {
      readonly kind: 'set-acoustic-environment';
      readonly environment: readonly AcousticEnvironment[];
    }
  | { readonly kind: 'set-bus-wet'; readonly bus: string; readonly wet: number }
  | {
      readonly kind: 'set-bus-send-gain';
      readonly bus: string;
      readonly target: string;
      readonly gain: number;
    }
  | {
      readonly kind: 'play';
      readonly entityId: number;
      readonly asset: AudioClipIdentity;
      readonly sourceKey: string;
      readonly bytes?: Uint8Array;
      readonly stream?: AudioClipAsset['stream'];
      readonly options: AudioPlayOptions;
    }
  | {
      readonly kind: 'failure';
      readonly error: Pick<AudioError, 'code' | 'expected' | 'hint' | 'detail'>;
    }
  | { readonly kind: 'configure-buses'; readonly buses: readonly AudioBus[] }
  | { readonly kind: 'set-bus'; readonly entityId: number; readonly bus: BusName }
  | { readonly kind: 'stop'; readonly entityId: number }
  | { readonly kind: 'seek'; readonly entityId: number; readonly position: number }
  | { readonly kind: 'set-playback-rate'; readonly entityId: number; readonly playbackRate: number }
  | { readonly kind: 'set-paused'; readonly entityId: number; readonly paused: boolean }
  | { readonly kind: 'set-volume'; readonly entityId: number; readonly volume: number }
  | { readonly kind: 'set-bus-volume'; readonly bus: BusName; readonly volume: number }
  | { readonly kind: 'set-bus-mute'; readonly bus: BusName; readonly muted: boolean }
  | { readonly kind: 'set-source-pose'; readonly entityId: number; readonly pose: AudioSourcePose }
  | { readonly kind: 'set-listener-pose'; readonly pose: AudioListenerPose }
  | { readonly kind: 'destroy' };

export interface AudioIntentBackendOptions {
  /** Local delivery returns a rejected publication; remote delivery feeds it back explicitly. */
  readonly emit: (intent: AudioIntent) => void | AudioClipIdentity;
  readonly maxPublishedBytes?: number;
  readonly maxPublishedSources?: number;
  readonly state?: () => AudioState | undefined;
}

const DISCONNECTED_AUDIO_STATE: AudioState = {
  contextState: 'unavailable',
  activeSourceCount: null,
  lastError: null,
};

export interface AudioIntentBackend extends AudioBackend {
  rejectPublication(asset: AudioClipIdentity): void;
}

export function createAudioIntentBackend(options: AudioIntentBackendOptions): AudioIntentBackend {
  const publishedSources = new Map<string, { revision: number; size: number }>();
  const maxBytes = options.maxPublishedBytes ?? 64 * 1024 * 1024;
  const maxSources = options.maxPublishedSources ?? 256;
  for (const limit of [maxBytes, maxSources]) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('audio publication limits must be positive safe integers');
  }
  let publishedBytes = 0;
  let lastError: AudioError | null = null;
  let rejectedPreparation: AudioPreparationReceipt | undefined;
  let rejectedMusic: import('./music').MusicReceipt | undefined;
  let destroyed = false;
  const rejectPublication = (asset: AudioClipIdentity): void => {
    const key = audioClipKey(asset);
    const publication = publishedSources.get(key);
    if (publication?.revision !== asset.revision) return;
    publishedSources.delete(key);
    publishedBytes -= publication.size;
  };
  const emit = (intent: AudioIntent): void => {
    if (!destroyed || intent.kind === 'destroy') {
      try {
        const rejected = options.emit(intent);
        if (rejected) rejectPublication(rejected);
      } catch (cause) {
        if (!(cause instanceof AudioError)) throw cause;
        lastError = cause;
        if (intent.kind === 'play') rejectPublication(intent.asset);
        if (intent.kind === 'prepare-clips')
          rejectedPreparation = {
            requestId: intent.requestId,
            status: 'rejected',
            sourceCount: 0,
            failure: {
              code: cause.code,
              expected: cause.expected,
              hint: cause.hint,
              ...(cause.detail ? { detail: cause.detail } : {}),
            },
          };
        // A rejected edge is not delivered. Let the caller retain its previous
        // state and retry; preparations already expose an explicit receipt.
        if (intent.kind !== 'prepare-clips' && intent.kind !== 'failure') throw cause;
      }
    }
  };
  const fail = (error: AudioError): void => {
    lastError = error;
    emit({
      kind: 'failure',
      error: {
        code: error.code,
        expected: error.expected,
        hint: error.hint,
        ...(error.detail ? { detail: error.detail } : {}),
      },
    });
  };
  const backend: AudioIntentBackend = {
    rejectPublication,
    prepareClips(requestId, assets, handles) {
      const noop = () => {};
      if (destroyed) return noop;
      let clips: ReturnType<typeof borrowAudioClip>[];
      try {
        clips = handles.map((handle) => borrowAudioClip(assets, handle));
      } catch (cause) {
        fail(cause as AudioError);
        return noop;
      }
      const buffered = clips.flatMap(({ identity, clip }) =>
        clip.bytes ? [{ asset: identity, sourceKey: clip.sourceKey, bytes: clip.bytes }] : [],
      );
      if (
        typeof requestId !== 'string' ||
        requestId.length < 1 ||
        requestId.length > 128 ||
        clips.length > maxSources ||
        new Set(handles).size !== clips.length ||
        buffered.length !== clips.length ||
        clips.some(
          ({ clip }) =>
            typeof clip.sourceKey !== 'string' ||
            clip.sourceKey.length < 1 ||
            clip.stream !== undefined,
        ) ||
        buffered.reduce((size, clip) => size + clip.bytes.byteLength, 0) > maxBytes
      ) {
        const error = new AudioError({
          code: 'control-failed',
          expected: 'fresh request ID and bounded distinct buffered clips',
          hint: 'prepare ordinary buffered clips within the configured source and byte budgets',
          detail: { code: 'control-failed', reason: 'invalid audio preparation' },
        });
        fail(error);
        rejectedPreparation = {
          requestId,
          status: 'rejected',
          sourceCount: 0,
          failure: {
            code: error.code,
            expected: error.expected,
            hint: error.hint,
            ...(error.detail ? { detail: error.detail } : {}),
          },
        };
        return noop;
      }
      rejectedPreparation = undefined;
      // Preparation does not claim ordinary play publication ownership. A
      // rejected/cancelled batch must never hide missing bytes on a later play.
      emit({
        kind: 'prepare-clips',
        requestId,
        clips: buffered.map((clip) => ({ ...clip, bytes: clip.bytes.slice() })),
      });
      let cancelled = false;
      return () => {
        if (!cancelled) {
          emit({ kind: 'cancel-clip-preparation', requestId });
          cancelled = true;
        }
      };
    },
    music(command) {
      if (command.kind === 'prepare') {
        rejectedMusic = {
          requestId:
            Number.isSafeInteger(command.requestId) && command.requestId > 0
              ? command.requestId
              : 0,
          epoch: options.state?.()?.music?.epoch ?? 0,
          status: 'rejected',
          failure: musicFailure(
            'invalid-command',
            'prepare ordinary music clips in the Host consumer; Worker music intents contain controls only',
          ),
        };
        return;
      }
      rejectedMusic = undefined;
      emit({ kind: 'music', command });
    },
    reportError: fail,
    setBusWet: (bus, wet) => emit({ kind: 'set-bus-wet', bus, wet }),
    setBusSendGain: (bus, target, gain) => emit({ kind: 'set-bus-send-gain', bus, target, gain }),
    setAcousticRoutes(entityId, routes) {
      const checked = validateAcousticRoutes(routes);
      if (!checked.ok) fail(checked.error);
      else emit({ kind: 'set-acoustic-routes', entityId, routes });
    },
    setAcousticEnvironment(environment) {
      const checked = validateAcousticEnvironment(environment);
      if (!checked.ok) fail(checked.error);
      else emit({ kind: 'set-acoustic-environment', environment });
    },
    play(entityId, assets, handle, playOptions): void {
      if (destroyed) return;
      let borrowed: ReturnType<typeof borrowAudioClip>;
      try {
        borrowed = borrowAudioClip(assets, handle);
      } catch (cause) {
        fail(cause as AudioError);
        return;
      }
      const { identity, clip } = borrowed;
      const key = audioClipKey(identity);
      const previous = publishedSources.get(key);
      const same = previous?.revision === identity.revision;
      // Validation and copying belong to publication, never to every play of an asset.
      if (!same) {
        if (clip.stream && !validAudioStream(clip.stream)) {
          fail(
            new AudioError({
              code: 'stream-failed',
              expected: 'a bounded PCM16 stream manifest',
              hint: 'load the verified stream through the audio asset owner',
              detail: {
                code: 'stream-failed',
                reason: 'unsupported-format',
                message: 'invalid stream publication',
              },
            }),
          );
          return;
        }
        const size = clip.stream ? JSON.stringify(clip.stream).length * 2 : clip.bytes.byteLength;
        if (
          (!previous && publishedSources.size >= maxSources) ||
          publishedBytes - (previous?.size ?? 0) + size > maxBytes
        ) {
          fail(
            new AudioError({
              code: 'control-failed',
              expected: 'a bounded audio publication set',
              hint: 'reuse asset handles or reduce source bytes; streaming assets publish only their bounded index',
              detail: {
                code: 'control-failed',
                reason: 'audio Worker publication budget exceeded',
              },
            }),
          );
          return;
        }
        publishedBytes += size - (previous?.size ?? 0);
        publishedSources.set(key, { revision: identity.revision, size });
      }
      emit({
        kind: 'play',
        entityId,
        asset: identity,
        sourceKey: clip.sourceKey,
        ...(!same
          ? clip.stream
            ? { stream: structuredClone(clip.stream) }
            : { bytes: clip.bytes.slice() }
          : {}),
        options: playOptions,
      });
    },
    configureBuses(buses) {
      const checked = prepareAudioBuses(buses);
      if (!checked.ok) fail(checked.error);
      else emit({ kind: 'configure-buses', buses: checked.value });
    },
    setBus: (entityId, bus) => emit({ kind: 'set-bus', entityId, bus }),
    stop: (entityId) => emit({ kind: 'stop', entityId }),
    seek: (entityId, position) => emit({ kind: 'seek', entityId, position }),
    setVolume: (entityId, volume) => emit({ kind: 'set-volume', entityId, volume }),
    setPlaybackRate: (entityId, playbackRate) =>
      emit({ kind: 'set-playback-rate', entityId, playbackRate }),
    setPaused: (entityId, paused) => emit({ kind: 'set-paused', entityId, paused }),
    setBusVolume: (bus, volume) => {
      const intent = { kind: 'set-bus-volume', bus, volume } as const;
      emit(intent);
    },
    setBusMute: (bus, muted) => {
      const intent = { kind: 'set-bus-mute', bus, muted } as const;
      emit(intent);
    },
    setSourcePose: (entityId, pose) => emit({ kind: 'set-source-pose', entityId, pose }),
    setListenerPose: (pose) => {
      const intent = { kind: 'set-listener-pose', pose } as const;
      emit(intent);
    },
    getState: () => {
      const state = options.state?.() ?? DISCONNECTED_AUDIO_STATE;
      return {
        ...state,
        ...(lastError ? { lastError } : {}),
        ...(rejectedPreparation ? { preparation: rejectedPreparation } : {}),
        ...(rejectedMusic
          ? {
              music: {
                epoch: state.music?.epoch ?? 0,
                phase: state.music?.phase ?? 'empty',
                bpm: state.music?.bpm ?? 0,
                beat: state.music?.beat ?? 0,
                sampleRate: state.music?.sampleRate ?? 0,
                pending: state.music?.pending ?? 0,
                nodes: state.music?.nodes ?? 0,
                pendingHighWater: state.music?.pendingHighWater ?? 0,
                nodeHighWater: state.music?.nodeHighWater ?? 0,
                receipts: [
                  ...(state.music?.receipts ?? [])
                    .filter((item) => item.requestId !== rejectedMusic?.requestId)
                    .slice(-255),
                  rejectedMusic,
                ],
              },
            }
          : {}),
      };
    },
    getActiveSourceCount: () => (options.state?.() ?? DISCONNECTED_AUDIO_STATE).activeSourceCount,
    destroy(): void {
      if (destroyed) return;
      const intent = { kind: 'destroy' } as const;
      emit(intent);
      destroyed = true;
      publishedSources.clear();
    },
  };
  return backend;
}
