import { type Buffer, err, ok, type Result, RhiError, type RhiQueue } from '@forgeax/engine-rhi';

export interface GpuInputPreparationStatus {
  readonly phase: 'copying' | 'current' | 'committed' | 'released' | 'failed';
  readonly copiedBytes: number;
  readonly extentBytes: number;
  readonly uploadBytes: number;
}

/** Numeric upload only. The Inputs owner must separately prepare every native consumer. */
export interface GpuInputPreparation {
  step(maxBytes: number): Result<GpuInputPreparationStatus, RhiError>;
  isCurrent(): boolean;
  commitPrepared(): Result<void, RhiError>;
  inspect(): GpuInputPreparationStatus;
  release(): void;
}

export interface InputPreparationHost {
  snapshot(): { readonly words: Uint32Array<ArrayBuffer>; readonly revision: number };
  current(): boolean;
  write(
    queue: RhiQueue,
    buffer: Buffer,
    words: Uint32Array<ArrayBuffer>,
    start: number,
    count: number,
  ): Result<void, RhiError>;
  publish(task: InputPreparation, revision: number, extent: number): Result<void, RhiError>;
  detach(task: InputPreparation): void;
}

function invalid(expected: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'finish or release the private upload; native buffers and consumers remain owned by Inputs',
  });
}

type DirtyRange = { readonly start: number; readonly end: number };

/** One private observer of the Arena's actual bytes; it owns no numeric allocation. */
export class InputPreparation {
  readonly api: GpuInputPreparation;
  private host: InputPreparationHost | undefined;
  private queue: RhiQueue | undefined;
  private buffer: Buffer | undefined;
  private readonly dirty = new Map<number, DirtyRange>();
  private copiedWords = 0;
  private readRevision = -1;
  private extentBytes: number;
  private uploadedBytes = 0;
  private busy = false;
  private closed: 'committed' | 'released' | undefined;
  private failure: RhiError | undefined;

  constructor(host: InputPreparationHost, queue: RhiQueue, buffer: Buffer) {
    this.host = host;
    this.queue = queue;
    this.buffer = buffer;
    this.extentBytes = host.snapshot().words.byteLength;
    this.api = Object.freeze({
      step: (bytes: number) => this.step(bytes),
      isCurrent: () => !this.busy && this.current(),
      commitPrepared: () => this.commitPrepared(),
      inspect: () => this.inspect(),
      release: () => this.close('released'),
    });
  }

  changed(address: number, count: number, index: number): void {
    if (this.closed !== undefined || this.failure !== undefined) return;
    try {
      const previous = this.dirty.get(address);
      // Replace the ticket: a completed write may only consume the exact old object.
      this.dirty.set(address, {
        start: Math.min(previous?.start ?? Infinity, address + index),
        end: Math.max(previous?.end ?? 0, address + count),
      });
    } catch (cause) {
      this.fault(cause);
    }
  }

  private current(): boolean {
    const host = this.host;
    if (this.closed !== undefined || this.failure !== undefined || host?.current() !== true)
      return false;
    const source = host.snapshot();
    return (
      this.copiedWords === source.words.length &&
      this.dirty.size === 0 &&
      this.readRevision === source.revision &&
      host.current()
    );
  }

  private inspect(): GpuInputPreparationStatus {
    return {
      phase:
        this.closed ??
        (this.failure !== undefined ? 'failed' : this.current() ? 'current' : 'copying'),
      copiedBytes: this.copiedWords * 4,
      extentBytes: this.host?.snapshot().words.byteLength ?? this.extentBytes,
      uploadBytes: this.uploadedBytes,
    };
  }

  private step(maxBytes: number): Result<GpuInputPreparationStatus, RhiError> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes % 4 !== 0)
      return err(invalid('an aligned upload quantum of at least four bytes'));
    if (this.busy) return err(invalid('a preparation outside its current write'));
    if (this.failure !== undefined) return err(this.failure);
    const host = this.host;
    if (host === undefined || !host.current())
      return err(invalid('the original live upload session'));
    this.busy = true;
    try {
      const source = host.snapshot();
      this.extentBytes = source.words.byteLength;
      const result =
        this.copiedWords < source.words.length
          ? this.copyCold(host, source.words, maxBytes / 4)
          : this.copyDirty(host, source.words, maxBytes / 4);
      if (!result.ok) return result;
      if (this.failure !== undefined) return err(this.failure);
      if (this.host !== host || !host.current())
        return err(invalid('unchanged upload ownership after writing'));
      const after = host.snapshot();
      this.extentBytes = after.words.byteLength;
      if (this.copiedWords === after.words.length && this.dirty.size === 0)
        this.readRevision = after.revision;
      return ok(this.inspect());
    } catch (cause) {
      return err(this.fault(cause));
    } finally {
      this.busy = false;
    }
  }

  private write(
    host: InputPreparationHost,
    words: Uint32Array<ArrayBuffer>,
    start: number,
    count: number,
  ): Result<void, RhiError> {
    const queue = this.queue,
      buffer = this.buffer;
    if (queue === undefined || buffer === undefined || this.host !== host)
      return err(invalid('a live private target'));
    const result = host.write(queue, buffer, words, start, count);
    if (result.ok) this.uploadedBytes += count * 4;
    return result;
  }

  private copyCold(
    host: InputPreparationHost,
    words: Uint32Array<ArrayBuffer>,
    budget: number,
  ): Result<void, RhiError> {
    const count = Math.min(budget, words.length - this.copiedWords);
    const result = this.write(host, words, this.copiedWords, count);
    if (result.ok && this.host === host && host.current()) this.copiedWords += count;
    return result;
  }

  private copyDirty(
    host: InputPreparationHost,
    words: Uint32Array<ArrayBuffer>,
    budget: number,
  ): Result<void, RhiError> {
    const next = this.dirty.entries().next();
    if (next.done) return ok(undefined);
    const [address, ticket] = next.value;
    const end = Math.min(ticket.end, ticket.start + budget);
    const result = this.write(host, words, ticket.start, end - ticket.start);
    if (!result.ok || this.host !== host || !host.current()) return result;
    const current = this.dirty.get(address);
    this.dirty.delete(address);
    // Rotate both an unfinished suffix and a reentrant replacement behind other work.
    if (current !== ticket) {
      if (current !== undefined) this.dirty.set(address, current);
    } else if (end < ticket.end) this.dirty.set(address, { start: end, end: ticket.end });
    return result;
  }

  private commitPrepared(): Result<void, RhiError> {
    if (this.busy || !this.current()) return err(invalid('a complete current private upload'));
    const host = this.host;
    if (host === undefined) return err(invalid('the issuing upload owner'));
    const source = host.snapshot();
    const result = host.publish(this, source.revision, source.words.byteLength);
    if (result.ok) this.close('committed');
    return result;
  }

  private fault(cause: unknown): RhiError {
    this.failure ??= Object.assign(
      new RhiError({
        code: 'internal-error',
        expected: 'a confirmed private numeric upload',
        hint: 'retire this candidate buffer in its Inputs owner; the active upload is unchanged',
      }),
      { cause },
    );
    return this.failure;
  }

  private close(phase: 'committed' | 'released'): void {
    if (this.closed !== undefined) return;
    this.closed = phase;
    const host = this.host;
    this.host = undefined;
    this.queue = undefined;
    this.buffer = undefined;
    this.dirty.clear();
    host?.detach(this);
  }
}
