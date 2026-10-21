import {
  type AudioBackend,
  type AudioClipIdentity,
  type AudioIntent,
  type AudioPlayOptions,
  type AudioPreparationReceipt,
  type AudioState,
  createAudioIntentBackend,
  type MusicPreparation,
  validAudioStream,
} from '@forgeax/engine-audio';
import { audioClipKey, borrowAudioClip } from '@forgeax/engine-audio/internal';
import { type AudioClipAsset, AudioError } from '@forgeax/engine-types';
import { MusicTransport } from './music-transport';
import { WebAudioEngine } from './web-audio-engine';

interface PendingPlay {
  options: AudioPlayOptions;
}

export interface HostAudioConsumer {
  /** Host asset bytes stay here; Worker music intents carry controls only. */
  prepareMusic(requestId: number, score: MusicPreparation): void;
  consume(intent: AudioIntent): AudioClipIdentity | undefined;
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

interface DecodeEntry {
  readonly kind: 'buffer';
  readonly revision: number;
  readonly bytes: Uint8Array;
  promise: Promise<AudioBuffer> | undefined;
  decodedBytes: number;
  holds: number;
  decoding: boolean;
  cached: boolean;
  charged: boolean;
}

interface StreamEntry {
  readonly kind: 'stream';
  readonly revision: number;
  readonly stream: NonNullable<AudioClipAsset['stream']>;
  readonly size: number;
  charged: boolean;
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
  const sources = new Map<string, DecodeEntry | StreamEntry>();
  let encodedBytes = 0;
  let decodedBytes = 0;
  let bytesHighWater = 0;
  const cachedBytes = () => encodedBytes + decodedBytes;
  const releasableBytes = (entry: DecodeEntry | StreamEntry | undefined) =>
    !entry
      ? 0
      : entry.kind === 'stream'
        ? entry.size
        : entry.decoding || entry.holds > 0
          ? 0
          : entry.bytes.byteLength + entry.decodedBytes;
  const release = (entry: DecodeEntry | StreamEntry) => {
    if (
      !entry.charged ||
      (entry.kind === 'buffer' && (entry.cached || entry.decoding || entry.holds > 0))
    )
      return;
    entry.charged = false;
    encodedBytes -= entry.kind === 'stream' ? entry.size : entry.bytes.byteLength;
    if (entry.kind === 'buffer') decodedBytes -= entry.decodedBytes;
  };
  const retire = (entry: DecodeEntry | StreamEntry | undefined) => {
    if (!entry) return;
    if (entry.kind === 'buffer') entry.cached = false;
    release(entry);
  };
  engine.setStreamBudget(maxCachedBytes, cachedBytes);
  const music = new MusicTransport(() => engine.musicOutput());
  const pendingPlays = new Map<number, PendingPlay>();
  let lastError: { sourceKey: string; revision?: number; error: AudioError } | undefined;
  let disposed = false;
  let preparation: AudioPreparationReceipt | undefined;
  // A pending play adopts every control intent that arrives before its decode settles.
  const patchPendingOptions = (entityId: number, patch: Partial<AudioPlayOptions>) => {
    const pending = pendingPlays.get(entityId);
    if (pending !== undefined) pending.options = { ...pending.options, ...patch };
  };
  const prepareBuffer = (
    asset: AudioClipIdentity,
    sourceKey: string,
    bytes?: Uint8Array,
  ): { entry: DecodeEntry; promise: Promise<AudioBuffer> } => {
    const key = audioClipKey(asset);
    let entry = sources.get(key);
    if (entry?.revision !== asset.revision) {
      if (bytes === undefined) throw new Error('audio asset version was not published');
      // Ordered preparation may still decode an older fixed request after a new
      // play. It completes that request without replacing the current cache.
      const cached = entry === undefined || asset.revision > entry.revision;
      if (
        (!entry && sources.size >= maxCachedSources) ||
        cachedBytes() -
          (cached ? releasableBytes(entry) : 0) +
          bytes.byteLength +
          engine.streamingBytes >
          maxCachedBytes
      )
        throw new Error('audio cache publication budget exceeded');
      if (cached) retire(entry);
      entry = {
        kind: 'buffer',
        revision: asset.revision,
        bytes: bytes.slice(),
        promise: undefined,
        decodedBytes: 0,
        holds: 0,
        decoding: false,
        cached,
        charged: true,
      };
      encodedBytes += bytes.byteLength;
      if (cached) sources.set(key, entry);
      bytesHighWater = Math.max(bytesHighWater, cachedBytes());
    }
    if (entry.kind !== 'buffer') throw new Error('asset version is not buffered audio');
    const current = entry;
    if (!current.promise) {
      current.decoding = true;
      let decoded: Promise<AudioBuffer>;
      try {
        decoded = engine.decode(current.bytes);
      } catch (cause) {
        current.decoding = false;
        release(current);
        throw cause;
      }
      current.promise = decoded
        .then((buffer) => {
          if (disposed) throw new Error('audio consumer retired during decode');
          const size = (buffer.length ?? 0) * (buffer.numberOfChannels ?? 0) * 4;
          if (cachedBytes() + size + engine.streamingBytes > maxCachedBytes)
            throw new Error('decoded audio exceeds maxCachedBytes');
          current.decodedBytes = size;
          decodedBytes += size;
          bytesHighWater = Math.max(bytesHighWater, cachedBytes());
          if (lastError?.sourceKey === key && (lastError.revision ?? 0) <= asset.revision)
            lastError = undefined;
          return buffer;
        })
        .finally(() => {
          current.decoding = false;
          release(current);
        });
      void current.promise.catch((cause) => {
        if (disposed) return;
        current.promise = undefined;
        lastError = {
          sourceKey: key,
          revision: asset.revision,
          error: decodeError(sourceKey, cause),
        };
      });
    }
    return { entry: current, promise: current.promise };
  };
  const consumer: HostAudioConsumer = {
    engine,
    prepareMusic(requestId, score): void {
      if (disposed) return;
      const epoch = music.beginPrepare({ kind: 'prepare', requestId, score });
      if (epoch === undefined) return;
      const prepared: ReturnType<typeof prepareBuffer>[] = [];
      let released = false;
      const releasePrepared = () => {
        if (released) return;
        released = true;
        for (const item of prepared) {
          item.entry.holds--;
          release(item.entry);
        }
        prepared.length = 0;
      };
      try {
        const clips = score.stems.map((stem) => borrowAudioClip(score.assets, stem.clip));
        if (clips.some(({ clip }) => clip.stream)) {
          music.failPrepare(
            requestId,
            epoch,
            'synchronized music requires buffered clips',
            'unsupported-stream',
          );
          return;
        }
        for (const { identity, clip } of clips) {
          const item = prepareBuffer(identity, clip.sourceKey, clip.bytes);
          item.entry.holds++;
          prepared.push(item);
        }
        let adopted = false;
        void Promise.all(prepared.map((item) => item.promise))
          .then((values) => {
            if (!disposed) adopted = music.finishPrepare(requestId, epoch, values, releasePrepared);
          })
          .catch((cause) => music.failPrepare(requestId, epoch, String(cause)))
          .finally(() => {
            if (!adopted) releasePrepared();
          });
      } catch (cause) {
        releasePrepared();
        music.failPrepare(requestId, epoch, String(cause));
      }
    },
    consume(intent): AudioClipIdentity | undefined {
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
            new Set(intent.clips.map((clip) => audioClipKey(clip.asset))).size !==
              intent.clips.length ||
            intent.clips.some(
              (clip) => typeof clip.sourceKey !== 'string' || clip.sourceKey.length < 1,
            )
          ) {
            reject('invalid bounded audio preparation');
            return;
          }
          // Bound each request to four native decoder jobs. Every entry uses the same
          // publication identity, cache budget and retry fences as real play.
          let next = 0;
          const run = async () => {
            while (!disposed && preparation === receipt && next < intent.clips.length) {
              const clip = intent.clips[next++];
              if (!clip) return;
              const result = prepareBuffer(clip.asset, clip.sourceKey, clip.bytes);
              await result.promise;
            }
          };
          void Promise.all(Array.from({ length: Math.min(4, intent.clips.length) }, run))
            .then(() => {
              if (disposed || preparation !== receipt) return;
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
              sourceKey: audioClipKey(intent.asset),
              revision: intent.asset.revision,
              error: decodeError(intent.sourceKey, cause),
            };
          };
          const key = audioClipKey(intent.asset);
          let entry = sources.get(key);
          if (intent.stream && entry?.revision !== intent.asset.revision) {
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
              return intent.asset;
            }
            const size = JSON.stringify(intent.stream).length * 2;
            const cached = entry === undefined || intent.asset.revision > entry.revision;
            if (
              (!entry && sources.size >= maxCachedSources) ||
              cachedBytes() - (cached ? releasableBytes(entry) : 0) + size + engine.streamingBytes >
                maxCachedBytes
            ) {
              fail('audio stream publication exceeds the shared Host source/byte budget');
              return intent.asset;
            }
            if (cached) retire(entry);
            entry = {
              kind: 'stream',
              revision: intent.asset.revision,
              stream: structuredClone(intent.stream),
              size,
              charged: true,
            };
            encodedBytes += size;
            if (cached) sources.set(key, entry);
            else release(entry);
            bytesHighWater = Math.max(bytesHighWater, cachedBytes());
          }
          if (
            intent.bytes === undefined &&
            entry?.kind === 'stream' &&
            entry.revision === intent.asset.revision
          ) {
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
          if (pendingPlays.size >= maxPendingPlays) {
            fail('maxPendingPlays reached; stop pending entities or increase the Host budget');
            return intent.asset;
          }
          let prepared: ReturnType<typeof prepareBuffer>;
          try {
            prepared = prepareBuffer(intent.asset, intent.sourceKey, intent.bytes);
          } catch (cause) {
            fail(cause);
            return intent.asset;
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
              if (!disposed && pendingPlays.get(intent.entityId) === pending) {
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
          encodedBytes,
          decodedBytes,
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
      for (const entry of sources.values()) retire(entry);
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
