import {
  type AudioBackend,
  type AudioIntent,
  type AudioPlayOptions,
  type AudioPreparationReceipt,
  type AudioState,
  createAudioIntentBackend,
  type MusicPreparation,
  validAudioStream,
} from '@forgeax/engine-audio';
import { type AudioClipAsset, AudioError } from '@forgeax/engine-types';
import { MusicTransport } from './music-transport';
import { WebAudioEngine } from './web-audio-engine';

interface PendingPlay {
  options: AudioPlayOptions;
}

export interface HostAudioConsumer {
  /** Host asset bytes stay here; Worker music intents carry controls only. */
  prepareMusic(requestId: number, score: MusicPreparation): void;
  consume(intent: AudioIntent): void;
  state(): AudioState;
  dispose(): void;
  readonly engine: WebAudioEngine;
}

function decodeError(sourceKey: string, cause: unknown): AudioError {
  return new AudioError({
    code: 'decode-failed',
    expected: `browser-decodable audio bytes for sourceKey ${sourceKey}`,
    hint: 'verify the audio media type and source bytes',
    detail: {
      code: 'decode-failed',
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

interface DecodeEntry {
  readonly kind: 'buffer';
  readonly bytes: Uint8Array;
  promise: Promise<AudioBuffer> | undefined;
  decodedBytes: number;
}

export interface HostAudioConsumerOptions {
  /** Encoded bytes plus decoded float samples retained by this consumer. */
  readonly maxCachedBytes?: number;
  readonly maxCachedSources?: number;
  readonly maxPendingPlays?: number;
}

export function createHostAudioConsumer(
  engine = new WebAudioEngine(),
  options: HostAudioConsumerOptions = {},
): HostAudioConsumer {
  const maxCachedBytes = options.maxCachedBytes ?? 64 * 1024 * 1024;
  const maxCachedSources = options.maxCachedSources ?? 256;
  const maxPendingPlays = options.maxPendingPlays ?? 1024;
  for (const limit of [maxCachedBytes, maxCachedSources, maxPendingPlays]) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('audio cache limits must be positive safe integers');
  }
  const sources = new Map<
    string,
    | DecodeEntry
    | {
        readonly kind: 'stream';
        readonly stream: NonNullable<AudioClipAsset['stream']>;
        readonly size: number;
      }
  >();
  let bytesHighWater = 0;
  const cachedBytes = () =>
    [...sources.values()].reduce(
      (bytes, source) =>
        bytes +
        (source.kind === 'stream' ? source.size : source.bytes.byteLength + source.decodedBytes),
      0,
    );
  engine.setStreamBudget(maxCachedBytes, cachedBytes);
  const music = new MusicTransport(() => engine.musicOutput());
  const pendingPlays = new Map<number, PendingPlay>();
  let lastError: { sourceKey: string; error: AudioError } | undefined;
  let disposed = false;
  let preparation: AudioPreparationReceipt | undefined;
  // A pending play adopts every control intent that arrives before its decode settles.
  const patchPendingOptions = (entityId: number, patch: Partial<AudioPlayOptions>) => {
    const pending = pendingPlays.get(entityId);
    if (pending !== undefined) pending.options = { ...pending.options, ...patch };
  };
  const prepareBuffer = (
    sourceKey: string,
    bytes?: Uint8Array,
  ): { entry: DecodeEntry; promise: Promise<AudioBuffer> } => {
    let entry = sources.get(sourceKey);
    if (bytes !== undefined && (entry?.kind !== 'buffer' || !sameBytes(entry.bytes, bytes))) {
      const oldSize = entry
        ? entry.kind === 'stream'
          ? entry.size
          : entry.bytes.byteLength + entry.decodedBytes
        : 0;
      if (
        (!entry && sources.size >= maxCachedSources) ||
        cachedBytes() - oldSize + bytes.byteLength + engine.streamingBytes > maxCachedBytes
      )
        throw new Error('audio cache publication budget exceeded');
      engine.invalidateAudioPublication(sourceKey);
      music.invalidate(sourceKey);
      entry = { kind: 'buffer', bytes: bytes.slice(), promise: undefined, decodedBytes: 0 };
      sources.set(sourceKey, entry);
      bytesHighWater = Math.max(bytesHighWater, cachedBytes());
    }
    if (!entry || entry.kind !== 'buffer') throw new Error('buffered sourceKey was not published');
    const current = entry;
    if (!current.promise) {
      current.promise = engine.decode(current.bytes).then((buffer) => {
        if (disposed || sources.get(sourceKey) !== current)
          throw new Error('source publication retired during decode');
        const size = (buffer.length ?? 0) * (buffer.numberOfChannels ?? 0) * 4;
        if (cachedBytes() + size + engine.streamingBytes > maxCachedBytes)
          throw new Error('decoded audio exceeds maxCachedBytes');
        current.decodedBytes = size;
        bytesHighWater = Math.max(bytesHighWater, cachedBytes());
        if (lastError?.sourceKey === sourceKey) lastError = undefined;
        return buffer;
      });
      void current.promise.catch((cause) => {
        if (sources.get(sourceKey) !== current || disposed) return;
        current.promise = undefined;
        lastError = { sourceKey, error: decodeError(sourceKey, cause) };
      });
    }
    return { entry: current, promise: current.promise };
  };
  const consumer: HostAudioConsumer = {
    engine,
    prepareMusic(requestId, score): void {
      const epoch = music.beginPrepare({ kind: 'prepare', requestId, score });
      if (epoch === undefined) return;
      try {
        const prepared = score.stems.map((stem) =>
          prepareBuffer(stem.clip.sourceKey, stem.clip.bytes),
        );
        void Promise.all(prepared.map((item) => item.promise))
          .then((values) => {
            if (
              prepared.some(
                (item, index) =>
                  sources.get(score.stems[index]?.clip.sourceKey ?? '') !== item.entry,
              )
            )
              music.failPrepare(requestId, epoch, 'source publication changed before adoption');
            else music.finishPrepare(requestId, epoch, values);
          })
          .catch((cause) => music.failPrepare(requestId, epoch, String(cause)));
      } catch (cause) {
        music.failPrepare(requestId, epoch, String(cause));
      }
    },
    consume(intent): void {
      if (disposed && intent.kind !== 'destroy') {
        if (intent.kind === 'music') music.command(intent.command);
        return;
      }
      switch (intent.kind) {
        case 'cancel-clip-preparation':
          if (preparation?.requestId === intent.requestId) preparation = undefined;
          return;
        case 'prepare-clips': {
          const receipt: AudioPreparationReceipt = {
            requestId: intent.requestId,
            status: 'pending',
            sourceCount: intent.clips.length,
          };
          preparation = receipt;
          const reject = (cause: unknown) => {
            if (disposed || preparation !== receipt) return;
            const error = decodeError('preparation', cause);
            lastError = { sourceKey: 'preparation', error };
            preparation = {
              ...receipt,
              status: 'rejected',
              failure: {
                code: error.code,
                expected: error.expected,
                hint: error.hint,
                ...(error.detail ? { detail: error.detail } : {}),
              },
            };
          };
          if (
            typeof intent.requestId !== 'string' ||
            intent.requestId.length < 1 ||
            intent.requestId.length > 128 ||
            intent.clips.length > maxCachedSources ||
            new Set(intent.clips.map((clip) => clip.sourceKey)).size !== intent.clips.length ||
            intent.clips.some(
              (clip) => typeof clip.sourceKey !== 'string' || clip.sourceKey.length < 1,
            )
          ) {
            reject('invalid bounded audio preparation');
            return;
          }
          // Bound each request to four native decoder jobs. Every entry uses the same
          // publication identity, cache budget and retry fences as real play.
          const prepared: { sourceKey: string; entry: DecodeEntry }[] = [];
          let next = 0;
          const run = async () => {
            while (!disposed && preparation === receipt && next < intent.clips.length) {
              const clip = intent.clips[next++];
              if (!clip) return;
              const result = prepareBuffer(clip.sourceKey, clip.bytes);
              prepared.push({ sourceKey: clip.sourceKey, entry: result.entry });
              await result.promise;
            }
          };
          void Promise.all(Array.from({ length: Math.min(4, intent.clips.length) }, run))
            .then(() => {
              if (disposed || preparation !== receipt) return;
              if (prepared.some((item) => sources.get(item.sourceKey) !== item.entry)) {
                reject('source publication changed before preparation completed');
                return;
              }
              preparation = { ...receipt, status: 'ready' };
            })
            .catch(reject);
          return;
        }
        case 'music': {
          music.command(intent.command);
          return;
        }
        case 'set-acoustic-routes':
          if (engine.setAcousticRoutes(intent.entityId, intent.routes).ok)
            patchPendingOptions(intent.entityId, {
              acousticRoutes: structuredClone(intent.routes),
            });
          return;
        case 'set-acoustic-environment':
          engine.setAcousticEnvironment(intent.environment);
          return;
        case 'set-bus-wet':
          engine.setBusWet(intent.bus, intent.wet);
          return;
        case 'set-bus-send-gain':
          engine.setBusSendGain(intent.bus, intent.target, intent.gain);
          return;
        case 'play': {
          pendingPlays.delete(intent.entityId);
          engine.stop(intent.entityId);
          const fail = (cause: unknown) => {
            lastError = {
              sourceKey: intent.sourceKey,
              error: decodeError(intent.sourceKey, cause),
            };
          };
          let entry = sources.get(intent.sourceKey);
          if (intent.stream) {
            if (!validAudioStream(intent.stream)) {
              lastError = {
                sourceKey: intent.sourceKey,
                error: new AudioError({
                  code: 'stream-failed',
                  expected: 'a bounded PCM16 stream manifest',
                  hint: 'load the verified stream through the audio asset owner',
                  detail: {
                    code: 'stream-failed',
                    reason: 'unsupported-format',
                    message: 'invalid stream publication',
                  },
                }),
              };
              return;
            }
            const size = JSON.stringify(intent.stream).length * 2;
            const oldSize = entry
              ? entry.kind === 'stream'
                ? entry.size
                : entry.bytes.byteLength + entry.decodedBytes
              : 0;
            if (
              (!entry && sources.size >= maxCachedSources) ||
              cachedBytes() - oldSize + size + engine.streamingBytes > maxCachedBytes
            ) {
              fail('audio stream publication exceeds the shared Host source/byte budget');
              return;
            }
            if (
              entry?.kind !== 'stream' ||
              JSON.stringify(entry.stream) !== JSON.stringify(intent.stream)
            ) {
              engine.invalidateAudioPublication(intent.sourceKey);
              entry = { kind: 'stream', stream: structuredClone(intent.stream), size };
              sources.set(intent.sourceKey, entry);
              bytesHighWater = Math.max(bytesHighWater, cachedBytes());
            }
          }
          if (intent.bytes === undefined && entry?.kind === 'stream') {
            engine.play(
              intent.entityId,
              {
                kind: 'audio',
                sourceKey: intent.sourceKey,
                mediaType: 'audio/wav',
                stream: entry.stream,
              },
              intent.options,
            );
            return;
          }
          let prepared: ReturnType<typeof prepareBuffer>;
          try {
            prepared = prepareBuffer(intent.sourceKey, intent.bytes);
          } catch (cause) {
            fail(cause);
            return;
          }
          const current = prepared.entry;
          if (!pendingPlays.has(intent.entityId) && pendingPlays.size >= maxPendingPlays) {
            fail('maxPendingPlays reached; stop pending entities or increase the Host budget');
            return;
          }
          const pending: PendingPlay = {
            options: {
              ...intent.options,
              ...(intent.options.sourcePose === undefined
                ? {}
                : { sourcePose: { ...intent.options.sourcePose } }),
            },
          };
          pendingPlays.set(intent.entityId, pending);
          void prepared.promise
            .then((buffer) => {
              if (
                !disposed &&
                sources.get(intent.sourceKey) === current &&
                pendingPlays.get(intent.entityId) === pending
              ) {
                engine.play(intent.entityId, buffer, pending.options);
              }
            })
            .catch(() => {})
            .finally(() => {
              if (pendingPlays.get(intent.entityId) === pending)
                pendingPlays.delete(intent.entityId);
            });
          return;
        }
        case 'stop':
          pendingPlays.delete(intent.entityId);
          engine.stop(intent.entityId);
          return;
        case 'set-volume':
          if (!Number.isFinite(intent.volume) || intent.volume < 0) return;
          patchPendingOptions(intent.entityId, { volume: intent.volume });
          engine.setVolume(intent.entityId, intent.volume);
          return;
        case 'set-playback-rate':
          if (!Number.isFinite(intent.playbackRate) || intent.playbackRate <= 0) return;
          patchPendingOptions(intent.entityId, { playbackRate: intent.playbackRate });
          engine.setPlaybackRate(intent.entityId, intent.playbackRate);
          return;
        case 'set-paused':
          patchPendingOptions(intent.entityId, { paused: intent.paused });
          engine.setPaused(intent.entityId, intent.paused);
          return;
        case 'seek':
          if (!Number.isFinite(intent.position) || intent.position < 0) return;
          patchPendingOptions(intent.entityId, { fromPosition: intent.position });
          engine.seek(intent.entityId, intent.position);
          return;
        case 'failure':
          lastError = { sourceKey: 'publication', error: new AudioError(intent.error) };
          return;
        case 'configure-buses':
          engine.configureBuses(intent.buses);
          return;
        case 'set-bus':
          patchPendingOptions(intent.entityId, { bus: intent.bus });
          engine.setBus(intent.entityId, intent.bus);
          return;
        case 'set-bus-volume':
          engine.setBusVolume(intent.bus, intent.volume);
          return;
        case 'set-bus-mute':
          engine.setBusMute(intent.bus, intent.muted);
          return;
        case 'set-source-pose':
          patchPendingOptions(intent.entityId, { sourcePose: { ...intent.pose } });
          engine.setSourcePose(intent.entityId, intent.pose);
          return;
        case 'set-listener-pose':
          engine.setListenerPose(intent.pose);
          return;
        case 'destroy':
          consumer.dispose();
          return;
      }
    },
    state(): AudioState {
      let state = engine.getState();
      if (state.contextState === 'closed' && !disposed) {
        consumer.dispose();
        state = engine.getState();
      }
      const musical = music.state();
      bytesHighWater = Math.max(bytesHighWater, cachedBytes());
      return {
        ...state,
        ...(preparation ? { preparation } : {}),
        music: musical,
        cache: {
          sources: sources.size,
          encodedBytes: [...sources.values()].reduce(
            (sum, entry) => sum + (entry.kind === 'buffer' ? entry.bytes.byteLength : entry.size),
            0,
          ),
          decodedBytes: [...sources.values()].reduce(
            (sum, entry) => sum + (entry.kind === 'buffer' ? entry.decodedBytes : 0),
            0,
          ),
          bytesHighWater,
          pendingPlays: pendingPlays.size,
        },
        activeSourceCount: state.activeSourceCount + musical.nodes / 2,
        lastError: state.lastError ?? lastError?.error ?? null,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      music.dispose();
      pendingPlays.clear();
      preparation = undefined;
      sources.clear();
      lastError = undefined;
      engine.destroy();
    },
  };
  return consumer;
}

export function createWebAudioBackend(engine = new WebAudioEngine()): AudioBackend {
  const consumer = createHostAudioConsumer(engine);
  const backend = createAudioIntentBackend({
    emit: (intent) => consumer.consume(intent),
    state: () => consumer.state(),
  });
  const control = backend.music;
  backend.music = (command) => {
    if (command.kind === 'prepare') consumer.prepareMusic(command.requestId, command.score);
    else control(command);
  };
  return backend;
}
