import { AudioError, validAudioStream } from '@forgeax/engine-audio';
import type { AudioClipAsset, AudioStreamManifest } from '@forgeax/engine-types';

export interface AudioStreamState {
  readonly status: 'buffering' | 'playing' | 'paused' | 'ended' | 'failed';
  readonly position: number;
  readonly pendingSeek: boolean;
  readonly underruns: number;
  readonly encodedBytes: number;
  readonly pcmBytes: number;
  readonly pendingBytes: number;
  readonly pendingReads: number;
  readonly error: AudioError | null;
}

type StreamFailure =
  | 'unsupported-format'
  | 'range-unsupported'
  | 'range-oversized'
  | 'integrity-failed'
  | 'network-failed'
  | 'budget-exceeded';
class StreamReadError extends Error {
  constructor(
    readonly reason: StreamFailure,
    message: string,
  ) {
    super(message);
  }
}

export class StreamBudget {
  encodedBytes = 0;
  pcmBytes = 0;
  pendingBytes = 0;
  pendingReads = 0;
  constructor(
    public maxBytes = 64 * 1024 * 1024,
    public retained = () => 0,
  ) {}
  reserve(bytes: number): boolean {
    if (
      this.pendingReads >= 8 ||
      this.retained() + this.encodedBytes + this.pcmBytes + this.pendingBytes + bytes >
        this.maxBytes
    )
      return false;
    this.pendingBytes += bytes;
    this.pendingReads++;
    return true;
  }
}
interface Segment {
  readonly node: AudioBufferSourceNode;
  readonly buffer: AudioBuffer;
  readonly frame: number;
  readonly at: number;
  readonly until: number;
  readonly bytes: number;
}

/** Three native windows + at most one pending read per play. No file-sized allocation. */
export class PcmStreamPlayer {
  private readonly manifest: AudioStreamManifest & { readonly url: string };
  private readonly segments: Segment[] = [];
  private readonly context: BaseAudioContext;
  private timer: ReturnType<typeof setInterval> | undefined;
  private controller: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private reading = false;
  private nextFrame: number;
  private nextAt = 0;
  private position: number;
  private pendingSeek = true;
  private status: AudioStreamState['status'] = 'buffering';
  private error: AudioError | null = null;
  private underruns = 0;
  private started = false;
  private readonly metadataBytes: number;
  private paused: boolean;
  private rate: number;
  private encodedBytes = 0;
  private pcmBytes = 0;
  private pendingBytes = 0;
  constructor(
    clip: Extract<AudioClipAsset, { stream: unknown }>,
    context: BaseAudioContext,
    private readonly budget: StreamBudget,
    options: { position: number; paused: boolean; rate: number; loop: boolean },
    private readonly input: () => AudioNode,
    private readonly ended: () => void,
  ) {
    this.manifest = clip.stream;
    this.context = context;
    this.metadataBytes = JSON.stringify(clip.stream).length * 2;
    if (
      budget.retained() +
        budget.encodedBytes +
        budget.pcmBytes +
        budget.pendingBytes +
        this.metadataBytes >
      budget.maxBytes
    ) {
      this.metadataBytes = 0;
      this.paused = true;
      this.rate = options.rate;
      this.loop = options.loop;
      this.position = options.position;
      this.nextFrame = 0;
      this.fail('budget-exceeded', 'stream metadata exceeds the shared byte budget');
      return;
    }
    budget.pendingBytes += this.metadataBytes;
    this.paused = options.paused;
    this.rate = options.rate;
    this.loop = options.loop;
    this.position = this.normalize(options.position);
    this.nextFrame = Math.round(this.position * clip.stream.sampleRate);
    if (!validAudioStream(clip.stream)) {
      this.fail('unsupported-format', 'invalid PCM16 stream manifest');
      return;
    }
    this.status = this.paused ? 'paused' : 'buffering';
    this.startTimer();
    this.pump();
  }
  private readonly loop: boolean;
  get nodes(): readonly AudioBufferSourceNode[] {
    return this.segments.map((segment) => segment.node);
  }
  get active(): boolean {
    return (
      !this.paused &&
      this.segments.some(
        (s) => s.at <= this.context.currentTime && s.until > this.context.currentTime,
      )
    );
  }
  state(): AudioStreamState {
    this.updatePosition();
    return {
      status: this.status,
      position: this.position,
      pendingSeek: this.pendingSeek,
      underruns: this.underruns,
      encodedBytes: this.encodedBytes,
      pcmBytes: this.pcmBytes,
      pendingBytes: this.pendingBytes,
      pendingReads: this.reading ? 1 : 0,
      error: this.error,
    };
  }
  seek(position: number): void {
    if (this.disposed || this.metadataBytes === 0 || !Number.isFinite(position) || position < 0)
      return;
    this.reset();
    this.position = this.normalize(position);
    this.nextFrame = Math.round(this.position * this.manifest.sampleRate);
    this.pendingSeek = true;
    this.status = this.paused ? 'paused' : 'buffering';
    this.error = null;
    this.startTimer();
    this.pump();
  }
  setPaused(paused: boolean): void {
    if (paused === this.paused || this.disposed || this.metadataBytes === 0) return;
    this.updatePosition();
    this.reset();
    this.paused = paused;
    this.nextFrame = Math.round(this.position * this.manifest.sampleRate);
    this.status = paused ? 'paused' : 'buffering';
    this.startTimer();
    this.pump();
  }
  setRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0 || this.disposed || this.metadataBytes === 0) return;
    this.updatePosition();
    this.reset();
    this.rate = rate;
    this.nextFrame = Math.round(this.position * this.manifest.sampleRate);
    this.status = this.paused ? 'paused' : 'buffering';
    this.startTimer();
    this.pump();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.budget.pendingBytes -= this.metadataBytes;
    this.reset();
    if (this.timer) clearInterval(this.timer);
  }
  private normalize(seconds: number): number {
    const duration = this.manifest.frames / this.manifest.sampleRate;
    return this.loop ? seconds % duration : Math.min(seconds, duration);
  }
  private updatePosition(): void {
    if (this.paused) return;
    const now = this.context.currentTime;
    for (const segment of this.segments) {
      if (now < segment.at) break;
      this.position = this.normalize(
        segment.frame / this.manifest.sampleRate +
          Math.max(0, Math.min(now, segment.until) - segment.at) * this.rate,
      );
    }
    if (this.active) this.status = 'playing';
  }
  private reset(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    for (const segment of this.segments) {
      segment.node.onended = null;
      try {
        segment.node.stop();
      } catch {
        /* Already ended. */
      }
      segment.node.disconnect();
      segment.node.buffer = null;
      this.budget.pcmBytes -= segment.bytes;
      this.pcmBytes -= segment.bytes;
    }
    this.segments.length = 0;
    this.nextAt = 0;
    this.started = false;
    // reading stays true until the aborted task settles, bounding rapid seek work.
  }
  private fail(reason: StreamFailure, message: string): void {
    this.updatePosition();
    this.reset();
    this.stopTimer();
    this.status = 'failed';
    this.error = new AudioError({
      code: 'stream-failed',
      expected: 'bounded verified PCM windows and a running Host',
      hint:
        this.metadataBytes === 0
          ? 'repair the Host budget and replay to admit the stream index before controls'
          : 'inspect the stream failure, repair the Range host/source/budget, then seek or replay explicitly',
      detail: { code: 'stream-failed', reason, message },
    });
  }
  private startTimer(): void {
    if (!this.timer && !this.error && !this.disposed)
      this.timer = setInterval(() => this.pump(), 25);
  }
  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private pump(): void {
    if (this.disposed || this.error) return;
    this.updatePosition();
    const now = this.context.currentTime;
    while (this.segments[0] && this.segments[0].until <= now) {
      const segment = this.segments.shift();
      if (!segment) break;
      segment.node.onended = null;
      segment.node.disconnect();
      segment.node.buffer = null;
      this.budget.pcmBytes -= segment.bytes;
      this.pcmBytes -= segment.bytes;
    }
    if (this.paused) {
      this.pendingSeek = false;
      this.stopTimer();
      return;
    }
    if (this.nextFrame >= this.manifest.frames) {
      if (this.loop) this.nextFrame = 0;
      else if (!this.segments.length && !this.reading) {
        this.stopTimer();
        this.status = 'ended';
        this.pendingSeek = false;
        this.ended();
        return;
      } else return;
    }
    if (this.segments.length >= 3 || this.reading) return;
    const frame = this.nextFrame,
      index = Math.floor(frame / this.manifest.chunkFrames);
    const chunkStart = index * this.manifest.chunkFrames;
    const frames = Math.min(this.manifest.chunkFrames, this.manifest.frames - chunkStart);
    const encoded = frames * this.manifest.channels * 2,
      pcm = frames * this.manifest.channels * 4;
    // Body, bounded reader copy, native PCM and one digest temporary.
    const reservation = encoded * 3 + pcm;
    if (!this.budget.reserve(reservation)) {
      // Concurrency pressure waits; a byte budget failure is terminal, not infinite retry.
      if (this.budget.pendingReads >= 8) return;
      this.fail('budget-exceeded', 'PCM window reservation exceeds the shared Host byte budget');
      return;
    }
    this.pendingBytes = reservation;
    this.reading = true;
    const generation = this.generation,
      controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => {
      if (!this.disposed && generation === this.generation) {
        this.fail('network-failed', 'PCM window read exceeded 10 seconds');
        controller.abort();
      }
    }, 10000);
    const valid = () =>
      !this.disposed && generation === this.generation && !controller.signal.aborted;
    void (async () => {
      let accountedPcm = 0;
      try {
        const start = this.manifest.dataOffset + chunkStart * this.manifest.channels * 2;
        const response = await fetch(this.manifest.url, {
          signal: controller.signal,
          cache: 'no-store',
          headers: { Range: `bytes=${start}-${start + encoded - 1}` },
        });
        if (!valid()) return;
        if (
          response.status !== 206 ||
          response.headers.get('Content-Range')?.split('/')[0] !==
            `bytes ${start}-${start + encoded - 1}` ||
          (response.headers.get('Content-Encoding') ?? 'identity') !== 'identity'
        ) {
          await response.body?.cancel();
          throw new StreamReadError(
            'range-unsupported',
            'expected exact uncompressed 206 Content-Range',
          );
        }
        const reader = response.body?.getReader();
        if (!reader) throw new StreamReadError('network-failed', 'response body missing');
        const bytes = new Uint8Array(encoded);
        let offset = 0;
        try {
          for (;;) {
            const read = await reader.read();
            if (read.done) break;
            if (!valid()) return;
            if (offset + read.value.byteLength > encoded)
              throw new StreamReadError('range-oversized', 'response exceeds requested window');
            bytes.set(read.value, offset);
            offset += read.value.byteLength;
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        if (!valid()) return;
        if (offset !== encoded) throw new StreamReadError('network-failed', 'truncated PCM window');
        this.encodedBytes += encoded;
        this.budget.encodedBytes += encoded;
        // The reservation already includes the retained encoded window.
        this.budget.pendingBytes -= encoded;
        this.pendingBytes -= encoded;
        const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
        if (!valid()) return;
        const hex = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        if (hex !== this.manifest.hashes[index])
          throw new StreamReadError('integrity-failed', 'PCM window digest differs from Cook');
        const buffer = this.context.createBuffer(
          this.manifest.channels,
          frames,
          this.manifest.sampleRate,
        );
        accountedPcm = pcm;
        this.budget.pcmBytes += pcm;
        this.pcmBytes += pcm;
        this.budget.pendingBytes -= pcm;
        this.pendingBytes -= pcm;
        const view = new DataView(bytes.buffer);
        for (let channel = 0; channel < this.manifest.channels; channel++) {
          const samples = buffer.getChannelData(channel);
          for (let f = 0; f < frames; f++)
            samples[f] = view.getInt16((f * this.manifest.channels + channel) * 2, true) / 32768;
        }
        if (!valid()) return;
        const now = this.context.currentTime;
        if (this.started && this.nextAt < now) {
          this.underruns++;
          this.status = 'buffering';
        }
        const at = Math.max(this.nextAt, now + (this.started ? 0 : 0.01));
        const duration = (chunkStart + frames - frame) / this.manifest.sampleRate;
        const node = this.context.createBufferSource();
        node.buffer = buffer;
        node.playbackRate.value = this.rate;
        node.connect(this.input());
        node.start(at, (frame - chunkStart) / this.manifest.sampleRate, duration);
        this.segments.push({
          node,
          buffer,
          frame,
          at,
          until: at + duration / this.rate,
          bytes: pcm,
        });
        accountedPcm = 0;
        this.nextAt = at + duration / this.rate;
        this.nextFrame = chunkStart + frames;
        this.pendingSeek = false;
        this.started = true;
      } catch (cause) {
        if (valid()) {
          this.fail(
            cause instanceof StreamReadError ? cause.reason : 'network-failed',
            String(cause),
          );
        }
      } finally {
        clearTimeout(timeout);
        if (accountedPcm) {
          this.budget.pcmBytes -= accountedPcm;
          this.pcmBytes -= accountedPcm;
        }
        this.budget.encodedBytes -= this.encodedBytes;
        this.encodedBytes = 0;
        this.budget.pendingBytes -= this.pendingBytes;
        this.pendingBytes = 0;
        this.budget.pendingReads--;
        this.reading = false;
        if (this.controller === controller) this.controller = undefined;
        this.pump();
      }
    })();
  }
}
