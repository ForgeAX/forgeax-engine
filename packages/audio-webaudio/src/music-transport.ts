import {
  MUSIC_LIMITS,
  type MusicCommand,
  type MusicFailureCode,
  type MusicPreparation,
  type MusicReceipt,
  type MusicState,
  musicFailure,
  validMusicBpm,
  validMusicScore,
} from '@forgeax/engine-audio';

interface Stem {
  readonly buffer: AudioBuffer;
  readonly offsetSeconds: number;
}
interface Voice {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}
interface Mix {
  readonly requestId: number;
  readonly time: number;
  readonly end: number;
  readonly gains: readonly number[];
}
export interface MusicOutput {
  readonly context: BaseAudioContext;
  readonly output: AudioNode;
}
const LEAD = 0.02;

/** Native automation owns execution; polling only observes and retires bounded metadata. */
export class MusicTransport {
  private epoch = 0;
  private phase: MusicState['phase'] = 'empty';
  private score:
    | (Pick<MusicPreparation, 'bpm' | 'beatsPerBar' | 'loopBeats'> & {
        readonly stems: readonly { readonly offsetSeconds: number }[];
      })
    | undefined;
  private stems: readonly Stem[] = [];
  private releaseBuffers: (() => void) | undefined;

  private clearStems(): void {
    this.stems = [];
    this.releaseBuffers?.();
    this.releaseBuffers = undefined;
  }
  private voices: Voice[] = [];
  private events: Mix[] = [];
  private receipts: MusicReceipt[] = [];
  private lastRequest = 0;
  private bpm = 0;
  private anchorTime = 0;
  private anchorBeat = 0;
  private gains: readonly number[] = [];
  private pendingHighWater = 0;
  private nodeHighWater = 0;

  constructor(private readonly output: () => MusicOutput | undefined) {}

  private receipt(receipt: MusicReceipt): void {
    const previous = this.receipts.findIndex((item) => item.requestId === receipt.requestId);
    if (previous >= 0) this.receipts[previous] = receipt;
    else {
      this.receipts.push(receipt);
      if (this.receipts.length > MUSIC_LIMITS.receipts) this.receipts.shift();
    }
  }
  reject(requestId: number, code: MusicFailureCode, reason: string): void {
    this.receipt({
      requestId: Number.isSafeInteger(requestId) && requestId > 0 ? requestId : 0,
      epoch: this.epoch,
      status: 'rejected',
      failure: musicFailure(code, reason),
    });
  }
  private admit(command: MusicCommand): boolean {
    this.poll();
    if (!Number.isSafeInteger(command.requestId) || command.requestId < 1) {
      this.reject(
        command.requestId,
        'invalid-command',
        'request ID must be a positive safe integer',
      );
      return false;
    }
    if (command.requestId <= this.lastRequest) {
      // Preserve the original receipt; retry cannot overwrite a scheduled cancellation handle.
      if (!this.receipts.some((item) => item.requestId === command.requestId))
        this.reject(command.requestId, 'duplicate-request', 'request ID was already consumed');
      return false;
    }
    this.lastRequest = command.requestId;
    if (this.phase === 'closed' || !this.output() || this.output()?.context.state === 'closed') {
      this.reject(command.requestId, 'context-closed', 'existing Host Context is closed');
      return false;
    }
    if (command.kind !== 'prepare' && command.epoch !== this.epoch) {
      this.reject(command.requestId, 'stale-epoch', 'request belongs to a retired transport epoch');
      return false;
    }
    return true;
  }

  /** Returns a generation token; stale asynchronous decode never adopts its result. */
  beginPrepare(command: Extract<MusicCommand, { kind: 'prepare' }>): number | undefined {
    try {
      return this.prepare(command);
    } catch (cause) {
      this.retire();
      this.epoch++;
      this.phase = 'empty';
      this.clearStems();
      this.reject(command.requestId, 'native-failed', String(cause));
      return undefined;
    }
  }
  private prepare(command: Extract<MusicCommand, { kind: 'prepare' }>): number | undefined {
    if (!this.admit(command)) return undefined;
    const score = command.score;
    if (!validMusicScore(score)) {
      this.reject(
        command.requestId,
        'invalid-score',
        'invalid tempo, meter, loop or stem count/offset',
      );
      return undefined;
    }
    this.retire();
    this.epoch++;
    this.phase = 'preparing';
    this.clearStems();
    this.gains = [];
    this.anchorBeat = 0;
    // The transport retains fixed native buffers and timing; assets stay with their owner.
    this.score = {
      bpm: score.bpm,
      beatsPerBar: score.beatsPerBar,
      loopBeats: score.loopBeats,
      stems: score.stems.map((stem) => ({
        offsetSeconds: stem.offsetSeconds ?? 0,
      })),
    };
    this.bpm = score.bpm;
    this.receipt({ requestId: command.requestId, epoch: this.epoch, status: 'preparing' });
    return this.epoch;
  }
  finishPrepare(
    requestId: number,
    epoch: number,
    buffers: readonly AudioBuffer[],
    releaseBuffers: () => void,
  ): boolean {
    if (epoch !== this.epoch || this.phase !== 'preparing' || !this.score) return false;
    const context = this.output()?.context;
    if (!context || context.state === 'closed') {
      this.failPrepare(requestId, epoch, 'Context closed while decoding');
      return false;
    }
    const loopFrames = Math.round(((this.score.loopBeats * 60) / this.bpm) * context.sampleRate);
    if (
      buffers.length !== this.score.stems.length ||
      buffers.some(
        (buffer, index) =>
          buffer.sampleRate !== context.sampleRate ||
          Math.round((this.score?.stems[index]?.offsetSeconds ?? 0) * context.sampleRate) +
            loopFrames >
            buffer.length,
      )
    ) {
      this.phase = 'empty';
      this.reject(
        requestId,
        'invalid-score',
        `resampled buffer must enclose the declared offset and loop interval; nativeRate=${context.sampleRate}Hz, loopFrames=${loopFrames}, decoded=[${buffers.map((buffer) => `${buffer.sampleRate}Hz/${buffer.length}frames`).join(', ')}]`,
      );
      return false;
    }
    this.stems = buffers.map((buffer, index) => ({
      buffer,
      offsetSeconds:
        Math.round((this.score?.stems[index]?.offsetSeconds ?? 0) * context.sampleRate) /
        context.sampleRate,
    }));
    this.gains = buffers.map(() => 0);
    this.anchorBeat = 0;
    this.anchorTime = this.round(context.currentTime + LEAD);
    this.releaseBuffers = releaseBuffers;
    this.phase = 'ready';
    this.receipt({ requestId, epoch, status: 'ready', targetTime: this.anchorTime, targetBeat: 0 });
    return true;
  }
  failPrepare(
    requestId: number,
    epoch: number,
    reason: string,
    code: MusicFailureCode = 'decode-failed',
  ): void {
    if (epoch !== this.epoch || this.phase !== 'preparing') return;
    this.clearStems();
    this.phase = 'empty';
    this.reject(requestId, code, reason);
  }
  private round(time: number): number {
    const rate = this.output()?.context.sampleRate ?? 48000;
    const sample = Math.round(time * rate);
    const rounded = sample / rate;
    // A quotient can multiply back just above its sample (32.02 * 48000).
    // Native automation then lands on the following frame. Stay below that
    // floating-point edge while retaining the same admitted integer sample.
    return rounded * rate > sample ? rounded - Number.EPSILON * rounded : rounded;
  }
  private beat(now: number): number {
    if (this.phase === 'paused' || this.phase === 'empty' || this.phase === 'preparing')
      return this.anchorBeat;
    return this.anchorBeat + (Math.max(0, now - this.anchorTime) * this.bpm) / 60;
  }
  private gainsAt(now: number): readonly number[] {
    let gains = this.gains;
    for (const event of this.events) {
      if (now < event.time) break;
      const fraction =
        event.end === event.time ? 1 : Math.min(1, (now - event.time) / (event.end - event.time));
      gains = gains.map((gain, index) => gain + ((event.gains[index] ?? 0) - gain) * fraction);
      if (fraction < 1) break;
    }
    return gains;
  }
  private poll(): void {
    if (this.phase === 'empty' || this.phase === 'closed') return;
    const context = this.output()?.context;
    if (!context || context.state === 'closed') {
      this.dispose();
      return;
    }
    const now = context.currentTime;
    for (const receipt of this.receipts)
      if (
        receipt.status === 'scheduled' &&
        receipt.targetTime !== undefined &&
        receipt.targetTime <= now
      )
        this.receipt({ ...receipt, status: 'applied' });
    while (this.events[0] && this.events[0].end <= now) {
      const event = this.events.shift();
      if (event) this.gains = event.gains;
    }
  }
  private stopVoices(): void {
    for (const voice of this.voices) {
      voice.source.onended = null;
      try {
        voice.source.stop();
      } catch {
        /* An already ended source has no work left. */
      }
      voice.source.disconnect();
      voice.gain.disconnect();
    }
    this.voices = [];
  }
  private retire(): void {
    for (const receipt of this.receipts) {
      if (
        receipt.epoch === this.epoch &&
        (receipt.status === 'scheduled' || receipt.status === 'preparing')
      )
        this.receipt({ ...receipt, status: 'cancelled' });
    }
    this.events = [];
    this.stopVoices();
  }
  private start(time: number, beat: number): void {
    const native = this.output();
    const score = this.score;
    if (!native || !score) return;
    const loopSeconds =
      Math.round(((score.loopBeats * 60) / score.bpm) * native.context.sampleRate) /
      native.context.sampleRate;
    for (const [index, stem] of this.stems.entries()) {
      const source = native.context.createBufferSource();
      const gain = native.context.createGain();
      this.voices.push({ source, gain });
      this.nodeHighWater = Math.max(this.nodeHighWater, this.voices.length * 2);
      gain.gain.value = this.gains[index] ?? 0;
      source.buffer = stem.buffer;
      source.loop = true;
      source.loopStart = stem.offsetSeconds;
      source.loopEnd = stem.offsetSeconds + loopSeconds;
      source.playbackRate.value = loopSeconds / ((score.loopBeats * 60) / this.bpm);
      source.connect(gain);
      gain.connect(native.output);
      source.start(
        time,
        stem.offsetSeconds +
          ((((beat % score.loopBeats) + score.loopBeats) % score.loopBeats) * loopSeconds) /
            score.loopBeats,
      );
    }
    this.nodeHighWater = Math.max(this.nodeHighWater, this.voices.length * 2);
  }
  private automate(now: number, current: readonly number[]): void {
    for (const [index, voice] of this.voices.entries()) {
      const param = voice.gain.gain;
      param.cancelScheduledValues(now);
      param.setValueAtTime(current[index] ?? 0, now);
      let gain = current[index] ?? 0;
      for (const event of this.events) {
        if (event.end <= now) continue;
        if (event.time >= now) param.setValueAtTime(gain, event.time);
        if (event.end > event.time)
          param.linearRampToValueAtTime(event.gains[index] ?? 0, event.end);
        else param.setValueAtTime(event.gains[index] ?? 0, event.time);
        gain = event.gains[index] ?? 0;
      }
    }
  }
  command(command: Exclude<MusicCommand, { kind: 'prepare' }>): void {
    try {
      if (this.admit(command)) this.apply(command);
    } catch (cause) {
      this.retire();
      this.epoch++;
      this.phase = 'empty';
      this.clearStems();
      this.reject(command.requestId, 'native-failed', String(cause));
    }
  }
  private apply(command: Exclude<MusicCommand, { kind: 'prepare' }>): void {
    if (
      !this.score ||
      this.stems.length === 0 ||
      this.phase === 'preparing' ||
      this.phase === 'empty'
    ) {
      this.reject(command.requestId, 'not-ready', 'prepare must finish before transport control');
      return;
    }
    const now = this.output()?.context.currentTime ?? 0;
    if (command.kind === 'mix') {
      const fade = command.fadeBeats ?? 0;
      if (
        this.phase === 'paused' ||
        command.gains.length !== this.stems.length ||
        command.gains.some((gain) => !Number.isFinite(gain) || gain < 0 || gain > 1) ||
        !Number.isFinite(fade) ||
        fade < 0 ||
        fade > 16 ||
        (command.atBeat !== undefined && (!Number.isFinite(command.atBeat) || command.atBeat < 0))
      ) {
        this.reject(
          command.requestId,
          'invalid-command',
          'invalid complete weight vector, fade or paused transport',
        );
        return;
      }
      if (this.events.length >= MUSIC_LIMITS.pending) {
        this.reject(command.requestId, 'capacity', '128 future commands already admitted');
        return;
      }
      const unit = command.boundary === 'bar' ? this.score.beatsPerBar : 1;
      let beat =
        command.atBeat === undefined
          ? (Math.floor(this.beat(now) / unit) + 1) * unit
          : Math.ceil(command.atBeat / unit) * unit;
      let time = this.round(this.anchorTime + ((beat - this.anchorBeat) * 60) / this.bpm);
      let deferred = false;
      if (time < now + LEAD - 0.5 / (this.output()?.context.sampleRate ?? 48000)) {
        if (command.late === 'reject') {
          this.reject(
            command.requestId,
            'missed-boundary',
            'target has less than 20 ms native scheduling margin',
          );
          return;
        }
        beat =
          Math.ceil((this.anchorBeat + ((now + LEAD - this.anchorTime) * this.bpm) / 60) / unit) *
          unit;
        time = this.round(this.anchorTime + ((beat - this.anchorBeat) * 60) / this.bpm);
        deferred = true;
      }
      const end = this.round(time + (fade * 60) / this.bpm);
      const rate = this.output()?.context.sampleRate ?? 48000;
      if (
        !Number.isSafeInteger(Math.round(time * rate)) ||
        !Number.isSafeInteger(Math.round(end * rate))
      ) {
        this.reject(
          command.requestId,
          'invalid-command',
          'native target must have a finite safe sample index',
        );
        return;
      }
      if (
        this.events.some((event) => event.time === time || (time < event.end && end > event.time))
      ) {
        this.reject(
          command.requestId,
          'conflicting-envelope',
          'overlapping envelope or duplicate target; cancel earlier command first',
        );
        return;
      }
      const current = this.gainsAt(now);
      const previous = this.events.at(-1);
      const append = this.voices.length > 0 && (!previous || previous.end <= time);
      this.events.push({ requestId: command.requestId, time, end, gains: [...command.gains] });
      this.events.sort((left, right) => left.time - right.time);
      if (this.voices.length === 0) {
        const start = this.round(Math.max(this.anchorTime, now + LEAD));
        this.start(start, this.beat(start));
        this.phase = 'playing';
      }
      if (append) {
        const before = previous?.gains ?? current;
        for (const [index, voice] of this.voices.entries()) {
          voice.gain.gain.setValueAtTime(before[index] ?? 0, time);
          if (end > time) voice.gain.gain.linearRampToValueAtTime(command.gains[index] ?? 0, end);
          else voice.gain.gain.setValueAtTime(command.gains[index] ?? 0, time);
        }
      } else this.automate(now, current);
      this.pendingHighWater = Math.max(this.pendingHighWater, this.events.length);
      this.receipt({
        requestId: command.requestId,
        epoch: this.epoch,
        status: 'scheduled',
        targetTime: time,
        targetBeat: beat,
        deferred,
      });
      return;
    }
    if (command.kind === 'cancel') {
      const index = this.events.findIndex((event) => event.requestId === command.cancelRequestId);
      const event = this.events[index];
      if (!event || event.time < now + LEAD) {
        this.reject(
          command.requestId,
          'missed-boundary',
          'cancellation requires an unstarted event and 20 ms margin',
        );
        return;
      }
      const current = this.gainsAt(now);
      const last = index === this.events.length - 1;
      const previous = this.events[index - 1];
      this.events.splice(index, 1);
      if (last) {
        for (const [stem, voice] of this.voices.entries()) {
          voice.gain.gain.cancelScheduledValues(event.time);
          if (previous?.end === event.time && previous.end > previous.time)
            voice.gain.gain.linearRampToValueAtTime(previous.gains[stem] ?? 0, previous.end);
        }
      } else this.automate(now, current);
      const receipt = this.receipts.find((item) => item.requestId === event.requestId);
      if (receipt) this.receipt({ ...receipt, status: 'cancelled' });
      this.receipt({ requestId: command.requestId, epoch: this.epoch, status: 'applied' });
      return;
    }
    if (command.kind === 'tempo' && !validMusicBpm(command.bpm)) {
      this.reject(command.requestId, 'invalid-command', 'BPM must be in [20,400]');
      return;
    }
    if (
      (command.kind === 'pause' && this.phase === 'paused') ||
      (command.kind === 'resume' && this.phase !== 'paused')
    ) {
      this.reject(command.requestId, 'invalid-command', 'pause/resume requires its matching phase');
      return;
    }
    const beat = this.beat(now);
    const gains = this.gainsAt(now);
    const paused = this.phase === 'paused';
    this.retire();
    this.epoch++;
    this.anchorBeat = beat;
    this.gains = gains;
    if (command.kind === 'tempo') this.bpm = command.bpm;
    this.anchorTime = this.round(now + LEAD);
    if (command.kind === 'pause' || (paused && command.kind === 'tempo')) this.phase = 'paused';
    else {
      this.start(this.anchorTime, beat);
      this.phase = 'playing';
    }
    this.receipt({
      requestId: command.requestId,
      epoch: this.epoch,
      status: this.phase === 'paused' ? 'applied' : 'scheduled',
      ...(this.phase === 'paused' ? {} : { targetTime: this.anchorTime, targetBeat: beat }),
    });
  }
  state(): MusicState {
    this.poll();
    const context =
      this.phase === 'empty' || this.phase === 'closed' ? undefined : this.output()?.context;
    return {
      epoch: this.epoch,
      phase: this.phase,
      bpm: this.bpm,
      beat: this.beat(context?.currentTime ?? 0),
      sampleRate: context?.sampleRate ?? 0,
      pending: this.events.length,
      nodes: this.voices.length * 2,
      pendingHighWater: this.pendingHighWater,
      nodeHighWater: this.nodeHighWater,
      receipts: this.receipts.map((receipt) => ({ ...receipt })),
    };
  }
  dispose(): void {
    if (this.phase === 'closed') return;
    this.retire();
    this.epoch++;
    this.phase = 'closed';
    this.clearStems();
    this.score = undefined;
    this.gains = [];
  }
}
