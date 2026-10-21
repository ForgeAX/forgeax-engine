// Host-owned native audio: one Context, accepted bus graph, bounded sources and generation fencing.

import {
  type AcousticEnvironment,
  type AcousticRoutes,
  AUDIO_ERROR_HINTS,
  type AudioBus,
  AudioError,
  type AudioListenerPose,
  type AudioPlayOptions,
  type AudioSourcePose,
  type AudioState,
  acousticFailure,
  type BusName,
  DEFAULT_AUDIO_BUSES,
  validAudioStream,
  validateAcousticRoutes,
} from '@forgeax/engine-audio';
import { type AudioClipAsset, err, ok, type Result } from '@forgeax/engine-types';
import { BusGraph } from './bus-graph';
import type { MusicOutput } from './music-transport';
import { type AudioStreamState, PcmStreamPlayer, StreamBudget } from './pcm-stream-player';
import { SourceBusRoutes } from './source-bus-routes';

interface ActiveSource {
  routes?: SourceBusRoutes;
  sourceKey: string | undefined;
  bus: string;
  node: AudioBufferSourceNode | undefined;
  buffer: AudioBuffer | undefined;
  stream: PcmStreamPlayer | undefined;
  loop: boolean;
  playbackRate: number;
  volume: number;
  offset: number;
  startedAt: number;
  filters: readonly AudioNode[];
  analyser: AnalyserNode | undefined;
  sourceGain: GainNode;
  panner: PannerNode | undefined;
}

const GESTURE_EVENTS = ['click', 'keydown', 'touchstart'] as const;
const GAIN_TRANSITION_SECONDS = 0.01;

function clipPosition(position: number, loop: boolean, duration: number): number {
  return loop && duration > 0 ? position % duration : Math.min(position, duration);
}

export class WebAudioEngine {
  reportError(error: AudioError): void {
    if (!this.closed) this.lastError = error;
  }
  private ctx: BaseAudioContext | undefined;
  private readonly contextFactory: (() => BaseAudioContext) | undefined;
  private readonly ownsContext: boolean;
  private closed = false;
  private musicTap: GainNode | undefined;
  private readonly streamBudget = new StreamBudget();
  private readonly graph = new BusGraph(DEFAULT_AUDIO_BUSES);
  private readonly pendingClips = new Map<
    number,
    { sourceKey: string; options: AudioPlayOptions }
  >();
  private readonly sources = new Map<number, ActiveSource>();
  private gestureListening = false;
  private resumeInFlight: Promise<void> | undefined;
  private readonly gestureResumeHandler: () => void;
  private lastError: AudioError | null = null;
  private decodeErrorKey: string | undefined;

  constructor(options: { readonly context?: BaseAudioContext | (() => BaseAudioContext) } = {}) {
    this.ctx = typeof options.context === 'function' ? undefined : options.context;
    this.contextFactory = typeof options.context === 'function' ? options.context : undefined;
    this.ownsContext = options.context === undefined;
    // Lazy: AudioContext is NOT created here (D-3 / AC-01).
    // The gesture resume handler is a bound arrow so we can pass it
    // to addEventListener/removeEventListener with the same identity.
    this.gestureResumeHandler = () => {
      void this.tryResume();
    };
  }

  /**
   * Returns the Web Audio AudioListener for spatialization (D-2).
   * Triggers lazy ensureContext() on first access.
   * Returns undefined if the context could not be created or is closed.
   */
  get listener(): AudioListener | undefined {
    if (this.retireClosedContext()) return undefined;
    return this.ensureContext().listener;
  }

  setListenerPose(pose: AudioListenerPose): void {
    if (this.retireClosedContext()) return;
    const listener = this.ensureContext().listener;
    listener.positionX.value = pose.positionX;
    listener.positionY.value = pose.positionY;
    listener.positionZ.value = pose.positionZ;
    listener.forwardX.value = pose.forwardX;
    listener.forwardY.value = pose.forwardY;
    listener.forwardZ.value = pose.forwardZ;
    listener.upX.value = pose.upX;
    listener.upY.value = pose.upY;
    listener.upZ.value = pose.upZ;
  }

  // -----------------------------------------------------------------------
  // ensureContext -- lazy AudioContext + bus topology creation
  // -----------------------------------------------------------------------

  private ensureContext(): BaseAudioContext {
    const ctx = this.ctx ?? (this.contextFactory ? this.contextFactory() : new AudioContext());
    this.graph.attach(ctx);
    this.ctx = ctx;

    // Register the bounded gesture listener set if ctx is suspended (autoplay gate).
    this.registerGestureListener(ctx);

    return ctx;
  }

  // -----------------------------------------------------------------------
  // Gesture listener -- D-3 bounded resume retry on user gesture
  // -----------------------------------------------------------------------

  private registerGestureListener(ctx: BaseAudioContext): void {
    if (!this.ownsContext || ctx.state !== 'suspended') {
      return;
    }
    if (this.gestureListening) {
      return;
    }

    this.gestureListening = true;
    for (const event of GESTURE_EVENTS) {
      document.addEventListener(event, this.gestureResumeHandler, { once: true });
    }
  }

  private removeGestureListener(): void {
    if (!this.gestureListening) {
      return;
    }
    this.gestureListening = false;
    for (const event of GESTURE_EVENTS) {
      document.removeEventListener(event, this.gestureResumeHandler);
    }
  }

  private async tryResume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.ownsContext || this.closed || ctx.state !== 'suspended') return;
    if (this.resumeInFlight !== undefined) return this.resumeInFlight;

    const attempt = (async () => {
      try {
        await (ctx as AudioContext).resume();
      } catch {
        // Inspect the real context state below so refusal remains recoverable.
      } finally {
        if (!this.closed && this.ctx === ctx) {
          if (ctx.state === 'running') {
            this.lastError = null;
            this.removeGestureListener();
          } else if (ctx.state === 'suspended') {
            this.recordResumeFailure();
            this.rearmGestureListener(ctx);
          } else {
            this.removeGestureListener();
          }
        }
        this.resumeInFlight = undefined;
      }
    })();
    this.resumeInFlight = attempt;
    return attempt;
  }

  private recordResumeFailure(): void {
    this.lastError = new AudioError({
      code: 'context-suspended',
      expected: 'AudioContext.resume() to make the existing context running',
      hint: AUDIO_ERROR_HINTS['context-suspended'],
      detail: { code: 'context-suspended' },
    });
  }

  private recordDecodeFailure(sourceKey: string, cause: unknown): void {
    this.decodeErrorKey = sourceKey;
    this.lastError = new AudioError({
      code: 'decode-failed',
      expected: `browser-decodable audio bytes for sourceKey ${sourceKey}`,
      hint: AUDIO_ERROR_HINTS['decode-failed'],
      detail: {
        code: 'decode-failed',
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }

  private rearmGestureListener(ctx: BaseAudioContext): void {
    this.removeGestureListener();
    this.registerGestureListener(ctx);
  }

  // -----------------------------------------------------------------------
  // AudioBackend implementation
  // -----------------------------------------------------------------------

  /** Same Context and accepted music bus; native objects stay in this Host realm. */
  musicOutput(): MusicOutput | undefined {
    if (this.retireClosedContext()) return undefined;
    const context = this.ensureContext();
    const output = this.graph.input('music');
    if (!output) return undefined;
    if (!this.musicTap) {
      this.musicTap = context.createGain();
      this.musicTap.connect(output);
    }
    return { context, output: this.musicTap };
  }

  decode(bytes: Uint8Array): Promise<AudioBuffer> {
    if (this.retireClosedContext())
      return Promise.reject(
        new AudioError({
          code: 'decode-failed',
          expected: 'a live existing AudioContext',
          hint: 'create a fresh Host consumer after closing its Context',
          detail: { code: 'decode-failed', reason: 'audio context is closed' },
        }),
      );
    return this.ensureContext().decodeAudioData(bytes.slice().buffer as ArrayBuffer);
  }

  play(entityId: number, clip: AudioBuffer | AudioClipAsset, opts: AudioPlayOptions): void {
    if (this.retireClosedContext()) return;
    if (opts.acousticRoutes) {
      const checked = this.checkAcousticRoutes(opts.acousticRoutes);
      if (!checked.ok) {
        this.lastError = checked.error;
        return;
      }
    }
    if (
      opts.spatialBlend > 0 &&
      ((opts.sourcePose !== undefined && !this.validSourcePose(opts.sourcePose)) ||
        ![opts.coneInnerAngle ?? 360, opts.coneOuterAngle ?? 360].every(
          (angle) => Number.isFinite(angle) && angle >= 0 && angle <= 360,
        ) ||
        !Number.isFinite(opts.coneOuterGain ?? 0) ||
        (opts.coneOuterGain ?? 0) < 0 ||
        (opts.coneOuterGain ?? 0) > 1)
    ) {
      this.recordSpatialFailure();
      return;
    }
    const playbackRate = opts.playbackRate ?? 1;
    if (!Number.isFinite(playbackRate) || playbackRate <= 0) return;
    const fromPosition = opts.fromPosition ?? 0;
    if (!Number.isFinite(fromPosition) || fromPosition < 0) return;
    if ('kind' in clip && clip.bytes !== undefined) {
      this.stop(entityId);
      const pending = { sourceKey: clip.sourceKey, options: { ...opts } };
      this.pendingClips.set(entityId, pending);
      void this.decode(clip.bytes).then(
        (buffer) => {
          if (!this.closed && this.pendingClips.get(entityId) === pending) {
            if (this.decodeErrorKey === clip.sourceKey) {
              this.decodeErrorKey = undefined;
              this.lastError = null;
            }
            this.pendingClips.delete(entityId);
            this.play(entityId, buffer, pending.options);
          }
        },
        (cause) => {
          if (!this.closed && this.pendingClips.get(entityId) === pending) {
            this.pendingClips.delete(entityId);
            this.recordDecodeFailure(clip.sourceKey, cause);
          }
        },
      );
      return;
    }
    const streamClip = 'kind' in clip ? clip : undefined;
    if (
      streamClip &&
      (!validAudioStream(streamClip.stream) || !/^https?:\/\//.test(streamClip.stream.url))
    ) {
      this.lastError = new AudioError({
        code: 'stream-failed',
        expected: 'a bounded PCM16 manifest with an HTTP locator',
        hint: 'recook the source through the audio importer',
        detail: {
          code: 'stream-failed',
          reason: 'unsupported-format',
          message: 'invalid audio stream declaration',
        },
      });
      return;
    }
    const clipBuffer = 'kind' in clip ? undefined : clip;
    // If this entity is already playing, stop it first (replace).
    if (this.sources.has(entityId)) {
      this.stop(entityId);
    }

    const ctx = this.ensureContext();

    // Per-source GainNode for volume control
    const sourceGain = ctx.createGain();
    sourceGain.gain.value = opts.paused ? 0 : opts.volume;

    // PannerNode for 3D spatialization (D-2 equalpower default)
    let panner: PannerNode | undefined;
    if (opts.spatialBlend > 0) {
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.orientationX.value = 0;
      panner.orientationZ.value = -1;
      panner.coneInnerAngle = opts.coneInnerAngle ?? 360;
      panner.coneOuterAngle = opts.coneOuterAngle ?? 360;
      panner.coneOuterGain = opts.coneOuterGain ?? 0;
      if (opts.sourcePose !== undefined) this.writeSourcePose(panner, opts.sourcePose);
    }

    // Route to the appropriate bus (gain nodes guaranteed by ensureContext above)
    const busGain = this.graph.input(opts.bus);
    if (!busGain) {
      this.lastError = new AudioError({
        code: 'bus-not-found',
        expected: 'an accepted bus ID',
        hint: 'configure the bus before playback',
        detail: { code: 'bus-not-found', attemptedBus: opts.bus },
      });
      return;
    }

    if (panner) {
      sourceGain.connect(panner);
      panner.connect(busGain);
    } else {
      sourceGain.connect(busGain);
    }

    const source: ActiveSource = {
      sourceKey: streamClip?.sourceKey,
      bus: opts.bus,
      node: undefined,
      buffer: clipBuffer,
      stream: undefined,
      loop: opts.loop,
      playbackRate,
      volume: opts.volume,
      offset: clipPosition(
        fromPosition,
        opts.loop,
        clipBuffer !== undefined
          ? (clipBuffer.duration ?? 0)
          : streamClip?.stream
            ? streamClip.stream.frames / streamClip.stream.sampleRate
            : 0,
      ),
      startedAt: ctx.currentTime,
      filters: [],
      analyser: undefined,
      sourceGain,
      panner,
    };
    this.sources.set(entityId, source);
    if (opts.acousticRoutes) this.applyAcousticRoutes(source, opts.acousticRoutes, true);
    if (streamClip?.stream) {
      source.stream = new PcmStreamPlayer(
        streamClip as Extract<AudioClipAsset, { stream: unknown }>,
        ctx,
        this.streamBudget,
        {
          position: fromPosition,
          paused: opts.paused ?? false,
          rate: playbackRate,
          loop: opts.loop,
        },
        () => source.filters[0] ?? source.sourceGain,
        () => {},
      );
    } else if (clipBuffer && !source.loop && source.offset >= clipBuffer.duration)
      this.stop(entityId);
    else if (!opts.paused) this.startSource(entityId, source);
  }

  private startSource(entityId: number, source: ActiveSource): void {
    const ctx = this.ensureContext();
    if (!source.buffer) return;
    if (!source.loop && source.offset >= source.buffer.duration) {
      this.stop(entityId);
      return;
    }
    const node = ctx.createBufferSource();
    node.buffer = source.buffer;
    node.loop = source.loop;
    node.playbackRate.value = source.playbackRate;
    node.connect(source.filters[0] ?? source.sourceGain);
    source.node = node;
    source.startedAt = ctx.currentTime;
    if (!source.loop) {
      node.onended = () => {
        if (this.sources.get(entityId)?.node === node) this.stop(entityId);
      };
    }
    node.start(0, source.offset);
  }

  private advance(source: ActiveSource): void {
    if (!source.node || !this.ctx) return;
    const now = this.ctx.currentTime;
    source.offset += Math.max(0, now - source.startedAt) * source.playbackRate;
    if (source.loop && source.buffer && source.buffer.duration > 0)
      source.offset %= source.buffer.duration;
    source.startedAt = now;
  }

  private disconnectNode(source: ActiveSource): void {
    const node = source.node;
    if (!node) return;
    // Clear identity before stop; a queued ended callback cannot delete a resumed source.
    source.node = undefined;
    node.onended = null;
    try {
      node.stop();
    } catch {
      /* Already ended. */
    }
    node.disconnect();
  }

  stop(entityId: number): void {
    this.pendingClips.delete(entityId);
    const source = this.sources.get(entityId);
    if (!source) return;
    source.stream?.dispose();
    this.disconnectNode(source);
    source.routes?.dispose();
    source.sourceGain.disconnect();
    source.panner?.disconnect();
    for (const filter of source.filters) filter.disconnect();
    source.analyser?.disconnect();
    this.sources.delete(entityId);
  }

  setPlaybackRate(entityId: number, playbackRate: number): void {
    if (!Number.isFinite(playbackRate) || playbackRate <= 0) return;
    this.patchPending(entityId, { playbackRate });
    const source = this.sources.get(entityId);
    if (!source) return;
    source.stream?.setRate(playbackRate);
    this.advance(source);
    source.playbackRate = playbackRate;
    if (source.node)
      source.node.playbackRate.setValueAtTime(playbackRate, this.ctx?.currentTime ?? 0);
  }

  setPaused(entityId: number, paused: boolean): void {
    this.patchPending(entityId, { paused });
    const source = this.sources.get(entityId);
    if (!source) return;
    if (source.stream) {
      source.stream.setPaused(paused);
      this.scheduleGainTransition(source.sourceGain, paused ? 0 : source.volume);
      return;
    }
    if (paused) {
      if (!source.node) return;
      this.advance(source);
      this.disconnectNode(source);
      this.scheduleGainTransition(source.sourceGain, 0);
    } else if (!source.node) {
      this.scheduleGainTransition(source.sourceGain, source.volume);
      this.startSource(entityId, source);
    }
  }

  /** Progress in decoded clip seconds, independent of wall time while paused. */
  getPlaybackPosition(entityId: number): number | undefined {
    const source = this.sources.get(entityId);
    if (!source) return undefined;
    if (source.stream) return source.stream.state().position;
    this.advance(source);
    return source.offset;
  }

  /** Replaces only the one-shot source, retaining pause, rate and native graph. */
  seek(entityId: number, position: number): void {
    if (!Number.isFinite(position) || position < 0) return;
    this.patchPending(entityId, { fromPosition: position });
    const source = this.sources.get(entityId);
    if (!source) return;
    const playing = source.node !== undefined;
    this.disconnectNode(source);
    if (source.stream) {
      source.stream.seek(position);
      return;
    }
    if (!source.buffer) return;
    source.offset = clipPosition(position, source.loop, source.buffer.duration);
    if (!source.loop && source.offset >= source.buffer.duration) this.stop(entityId);
    else if (playing) this.startSource(entityId, source);
  }

  /** Host-only: transfers exclusive outgoing graph ownership of the returned nodes. */
  setFilters(
    entityId: number,
    build: (context: BaseAudioContext) => readonly AudioNode[],
  ): Result<void, AudioError> {
    const source = this.sources.get(entityId);
    if (!source || !this.ctx)
      return this.controlFailure('source is not retained; wait for decoding to complete');
    let filters: readonly AudioNode[];
    try {
      filters = [...build(this.ctx)];
      if (
        filters.length > 32 ||
        new Set(filters).size !== filters.length ||
        filters.some(
          (node) =>
            node.context !== this.ctx ||
            node.numberOfInputs < 1 ||
            node.numberOfOutputs < 1 ||
            node === source.sourceGain ||
            node === source.panner ||
            node === source.node ||
            node === source.analyser ||
            this.graph.owns(node) ||
            [...this.sources.values()].some(
              (other) =>
                other !== source &&
                (other.filters.includes(node) ||
                  node === other.node ||
                  node === other.sourceGain ||
                  node === other.panner ||
                  node === other.analyser),
            ),
        )
      )
        return this.controlFailure(
          'use at most 32 distinct input/output nodes from the supplied context',
        );
    } catch (cause) {
      return this.controlFailure(String(cause));
    }
    const previous = source.filters;
    source.node?.disconnect();
    for (const node of source.stream?.nodes ?? []) node.disconnect();
    for (const filter of previous) filter.disconnect();
    const connect = (chain: readonly AudioNode[]) => {
      for (let i = 0; i < chain.length; i++) chain[i]?.connect(chain[i + 1] ?? source.sourceGain);
      source.node?.connect(chain[0] ?? source.sourceGain);
      for (const node of source.stream?.nodes ?? []) node.connect(chain[0] ?? source.sourceGain);
    };
    try {
      connect(filters);
      source.filters = filters;
      return ok(undefined);
    } catch (cause) {
      for (const filter of filters) filter.disconnect();
      try {
        connect(previous);
      } catch (rollback) {
        this.stop(entityId);
        return this.controlFailure(
          `${String(cause)}; restoring the previous graph failed: ${String(rollback)}`,
        );
      }
      return this.controlFailure(String(cause));
    }
  }

  /** Opt-in post-filter/post-volume tap, before panning and bus gain. Reuses its node. */
  createAnalyser(entityId: number, fftSize = 2048): Result<AnalyserNode, AudioError> {
    const source = this.sources.get(entityId);
    if (!source || !this.ctx)
      return this.controlFailure('source is not retained; wait for decoding to complete');
    if (
      !Number.isInteger(fftSize) ||
      fftSize < 32 ||
      fftSize > 32768 ||
      (fftSize & (fftSize - 1)) !== 0
    )
      return this.controlFailure('fftSize must be a power of two from 32 through 32768');
    const analyser = source.analyser ?? this.ctx.createAnalyser();
    analyser.fftSize = fftSize;
    if (!source.analyser) source.sourceGain.connect(analyser);
    source.analyser = analyser;
    return ok(analyser);
  }

  /** Writes dB bins into caller storage; paused sources report silence, not stale native FFT data. */
  readFrequencyData(entityId: number, output: Float32Array<ArrayBuffer>): Result<void, AudioError> {
    const source = this.sources.get(entityId);
    if (!source?.analyser)
      return this.controlFailure('create an analyser for the retained source first');
    if (output.length !== source.analyser.frequencyBinCount)
      return this.controlFailure('output length must equal analyser.frequencyBinCount');
    if (source.node || source.stream?.active) source.analyser.getFloatFrequencyData(output);
    else output.fill(-Infinity);
    return ok(undefined);
  }

  removeAnalyser(entityId: number): void {
    const source = this.sources.get(entityId);
    if (!source?.analyser) return;
    source.sourceGain.disconnect(source.analyser);
    source.analyser.disconnect();
    source.analyser = undefined;
  }

  private controlFailure<T>(reason: string): Result<T, AudioError> {
    return err(
      new AudioError({
        code: 'control-failed',
        expected: 'a retained source and valid Host audio graph controls',
        hint: AUDIO_ERROR_HINTS['control-failed'],
        detail: { code: 'control-failed', reason },
      }),
    );
  }

  /** Updates the retained panner, including while the source is paused. */
  setSourcePose(entityId: number, pose: AudioSourcePose): void {
    this.patchPending(entityId, { sourcePose: pose });
    const panner = this.sources.get(entityId)?.panner;
    if (panner === undefined) return;
    if (!this.validSourcePose(pose)) {
      this.recordSpatialFailure();
      return;
    }
    this.writeSourcePose(panner, pose);
  }

  private validSourcePose(pose: AudioSourcePose): boolean {
    return (
      Number.isFinite(pose.positionX) &&
      Number.isFinite(pose.positionY) &&
      Number.isFinite(pose.positionZ) &&
      Number.isFinite(pose.forwardX) &&
      Number.isFinite(pose.forwardY) &&
      Number.isFinite(pose.forwardZ) &&
      Math.hypot(pose.forwardX, pose.forwardY, pose.forwardZ) > 0
    );
  }

  private recordSpatialFailure(): void {
    this.lastError = new AudioError({
      code: 'control-failed',
      expected:
        'finite source position, nonzero forward, cone angles in 0..360 and outer gain in 0..1',
      hint: AUDIO_ERROR_HINTS['control-failed'],
      detail: { code: 'control-failed', reason: 'invalid spatial source pose or cone' },
    });
  }

  private writeSourcePose(panner: PannerNode, pose: AudioSourcePose): void {
    panner.positionX.value = pose.positionX;
    panner.positionY.value = pose.positionY;
    panner.positionZ.value = pose.positionZ;
    panner.orientationX.value = pose.forwardX;
    panner.orientationY.value = pose.forwardY;
    panner.orientationZ.value = pose.forwardZ;
  }

  setVolume(entityId: number, volume: number): void {
    if (Number.isFinite(volume) && volume >= 0) this.patchPending(entityId, { volume });
    const source = this.sources.get(entityId);
    if (!source || !Number.isFinite(volume) || volume < 0) return;
    source.volume = volume;
    if (source.node || (source.stream && source.stream.state().status !== 'paused'))
      this.scheduleGainTransition(source.sourceGain, volume);
  }

  private reconnectBuses = (input: (id: string) => GainNode | undefined): void => {
    if (this.musicTap) {
      const music = input('music');
      if (!music) throw new Error('retained music bus missing from candidate');
      this.musicTap.disconnect();
      this.musicTap.connect(music);
    }
    for (const source of this.sources.values()) {
      if (source.routes) {
        source.routes.reconnect(input);
        continue;
      }
      const output = source.panner ?? source.sourceGain;
      // Preserve the optional analyser tap on sourceGain.
      output.disconnect();
      if (!source.panner && source.analyser) output.connect(source.analyser);
      const target = input(source.bus);
      if (!target) throw new Error('retained source bus missing from candidate');
      output.connect(target);
    }
  };

  configureBuses(buses: readonly AudioBus[]): Result<void, AudioError> {
    const result = this.graph.replace(buses, this.retainedBusIds(), this.reconnectBuses);
    if (!result.ok) this.lastError = result.error;
    return result;
  }

  setBusEffects(
    bus: string,
    build: (ctx: BaseAudioContext) => readonly AudioNode[],
    wet = 1,
  ): Result<void, AudioError> {
    const result = this.graph.effects(
      bus,
      (ctx) => {
        const nodes = build(ctx);
        if (
          nodes.some((node) =>
            [...this.sources.values()].some(
              (source) =>
                node === source.sourceGain ||
                node === source.panner ||
                node === source.node ||
                node === source.analyser ||
                source.filters.includes(node) ||
                source.stream?.nodes.includes(node as AudioBufferSourceNode),
            ),
          )
        )
          throw new Error('bus effects cannot borrow retained source nodes');
        return nodes;
      },
      wet,
      this.retainedBusIds(),
      this.reconnectBuses,
    );
    if (!result.ok) this.lastError = result.error;
    return result;
  }

  setBus(entityId: number, bus: string): void {
    if (!this.graph.has(bus)) {
      this.lastError = new AudioError({
        code: 'bus-not-found',
        expected: 'an accepted bus ID',
        hint: 'configure the target bus before rerouting',
        detail: { code: 'bus-not-found', attemptedBus: bus },
      });
      return;
    }
    this.patchPending(entityId, { bus });
    const source = this.sources.get(entityId);
    if (!source || bus === source.bus) return;
    if (source.routes) {
      const result = source.routes.setBase(bus);
      if (!result.ok) this.lastError = result.error;
      else source.bus = bus;
      return;
    }
    const next = this.graph.input(bus);
    if (!next) {
      this.lastError = new AudioError({
        code: 'bus-not-found',
        expected: 'an accepted bus ID',
        hint: 'configure the target bus before rerouting',
        detail: { code: 'bus-not-found', attemptedBus: bus },
      });
      return;
    }
    const output = source.panner ?? source.sourceGain;
    const previous = this.graph.input(source.bus);
    if (previous) output.disconnect(previous);
    output.connect(next);
    source.bus = bus;
  }

  private retainedBusIds(): string[] {
    return [...this.sources.values()]
      .flatMap((source) => source.routes?.busIds ?? [source.bus])
      .concat(this.musicTap ? ['music'] : []);
  }
  private checkAcousticRoutes(routes: AcousticRoutes): Result<void, AudioError> {
    const checked = validateAcousticRoutes(routes);
    if (!checked.ok) return checked;
    return routes.buses.every((r) => this.graph.has(r.bus))
      ? ok(undefined)
      : acousticFailure('region source bus is not configured');
  }
  private applyAcousticRoutes(
    source: ActiveSource,
    routes: AcousticRoutes,
    initial: boolean,
  ): Result<void, AudioError> {
    if (!this.ctx) return acousticFailure('audio context is unavailable');
    const output = source.panner ?? source.sourceGain;
    if (!source.routes) {
      const mixer = new SourceBusRoutes(this.ctx, output, source.bus, (id) => this.graph.input(id));
      const result = mixer.update(initial ? routes : { fallback: 1, buses: [] }, source.bus, true);
      if (!result.ok) {
        mixer.dispose();
        this.lastError = result.error;
        return result;
      }
      const base = this.graph.input(source.bus);
      if (base) output.disconnect(base);
      source.routes = mixer;
    }
    const result = source.routes.update(routes, source.bus, initial);
    if (!result.ok) this.lastError = result.error;
    return result;
  }
  setAcousticRoutes(entityId: number, routes: AcousticRoutes): Result<void, AudioError> {
    if (this.retireClosedContext()) return acousticFailure('audio context is closed');
    const result = this.checkAcousticRoutes(routes);
    if (!result.ok) {
      this.lastError = result.error;
      return result;
    }
    const source = this.sources.get(entityId);
    if (source) {
      const applied = this.applyAcousticRoutes(source, routes, false);
      if (!applied.ok) return applied;
    }
    this.patchPending(entityId, { acousticRoutes: structuredClone(routes) });
    return ok(undefined);
  }
  setAcousticEnvironment(environment: readonly AcousticEnvironment[]): void {
    if (this.retireClosedContext()) return;
    const result = this.graph.setEnvironment(environment);
    if (!result.ok) this.lastError = result.error;
  }
  setBusWet(bus: string, wet: number): void {
    if (this.retireClosedContext()) return;
    const result = this.graph.setWet(bus, wet);
    if (!result.ok) this.lastError = result.error;
  }
  setBusSendGain(bus: string, target: string, gain: number): void {
    if (this.retireClosedContext()) return;
    const result = this.graph.setSend(bus, target, gain);
    if (!result.ok) this.lastError = result.error;
  }

  setBusVolume(busName: BusName, volume: number): void {
    if (this.retireClosedContext()) return;
    const result = this.graph.volume(busName, volume);
    if (!result.ok) this.lastError = result.error;
  }

  setBusMute(busName: BusName, muted: boolean): void {
    if (this.retireClosedContext()) return;
    const result = this.graph.mute(busName, muted);
    if (!result.ok) this.lastError = result.error;
  }

  getState(): AudioState {
    if (this.retireClosedContext()) {
      return { contextState: 'closed', activeSourceCount: 0, lastError: null };
    }
    const contextState: 'running' | 'suspended' | 'closed' =
      this.ctx?.state === 'closed'
        ? 'closed'
        : this.ctx?.state === 'running'
          ? 'running'
          : 'suspended';
    return {
      contextState,
      activeSourceCount: this.getActiveSourceCount(),
      lastError:
        this.lastError ??
        [...this.sources.values()].find((source) => source.stream?.state().error)?.stream?.state()
          .error ??
        null,
      streaming: {
        encodedBytes: this.streamBudget.encodedBytes,
        pcmBytes: this.streamBudget.pcmBytes,
        pendingBytes: this.streamBudget.pendingBytes,
        pendingReads: this.streamBudget.pendingReads,
        underruns: [...this.sources.values()].reduce(
          (sum, source) => sum + (source.stream?.state().underruns ?? 0),
          0,
        ),
      },
    };
  }

  private patchPending(entity: number, patch: Partial<AudioPlayOptions>): void {
    const pending = this.pendingClips.get(entity);
    if (pending) pending.options = { ...pending.options, ...patch };
  }
  setStreamBudget(maxBytes: number, retained: () => number): void {
    this.streamBudget.maxBytes = maxBytes;
    this.streamBudget.retained = retained;
  }
  get streamingBytes(): number {
    return (
      this.streamBudget.encodedBytes + this.streamBudget.pcmBytes + this.streamBudget.pendingBytes
    );
  }
  getStreamState(entityId: number): AudioStreamState | undefined {
    return this.sources.get(entityId)?.stream?.state();
  }

  getActiveSourceCount(): number {
    if (this.retireClosedContext()) return 0;
    let count = 0;
    for (const source of this.sources.values()) if (source.node || source.stream?.active) count++;
    return count;
  }

  private retireClosedContext(): boolean {
    if (this.ctx?.state === 'closed') this.retire();
    return this.closed;
  }

  destroy(): void {
    this.retire();
  }

  private retire(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingClips.clear();

    // Stop all active sources
    for (const entityId of this.sources.keys()) {
      this.stop(entityId);
    }

    this.musicTap?.disconnect();
    this.musicTap = undefined;
    this.graph.dispose();

    // Remove gesture listener
    this.removeGestureListener();

    // Close AudioContext (irreversible per R-4)
    if (this.ctx) {
      if (this.ownsContext && this.ctx.state !== 'closed') void (this.ctx as AudioContext).close();
      this.ctx = undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private scheduleGainTransition(gain: GainNode, target: number): boolean {
    if (!this.ctx || !Number.isFinite(target) || target < 0) return false;

    const now = this.ctx.currentTime;
    const param = gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + GAIN_TRANSITION_SECONDS);
    return true;
  }
}
