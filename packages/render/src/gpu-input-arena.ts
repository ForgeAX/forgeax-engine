import { mat4 } from '@forgeax/engine-math';
import {
  type Buffer,
  err,
  ok,
  type Result,
  type RhiDevice,
  RhiError,
  type RhiQueue,
} from '@forgeax/engine-rhi';
import { shouldShrinkCapacity } from './dynamic-capacity';
import { type GpuInputPreparation, InputPreparation } from './gpu-input-preparation';
import { StableRangeAllocator } from './stable-range-allocator';

export type { GpuInputPreparation, GpuInputPreparationStatus } from './gpu-input-preparation';

function invalid(expected: string): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'retain each numeric owner until its final task, and retire device uploads independently',
  });
}
function u32(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
    throw invalid('u32 numeric arena addresses and extents');
}

/** Device limits constrain uploads; storage-less consumers still use the CPU facts. */
export function gpuInputByteLimit(device?: RhiDevice): number {
  const storage = device?.caps.storageBuffer
    ? Number(device.limits.maxStorageBufferBindingSize)
    : NaN;
  const buffer = Number(device?.limits.maxBufferSize);
  return Math.min(
    0xffffffff * 4,
    Number.isFinite(storage) && storage > 0 ? storage : Infinity,
    Number.isFinite(buffer) && buffer > 0 ? buffer : Infinity,
  );
}

export interface GpuInputUpload {
  /** A fresh physical buffer requires the full current numeric backing. */
  readonly uploadBytes: number;
  /** Queue-accepted current numeric backing; GPU completion remains a separate fence. */
  isCurrent(queue: RhiQueue, buffer: Buffer): boolean;
  flush(queue: RhiQueue, buffer: Buffer, initial: boolean): Result<void, RhiError>;
  activate(): void;
  /** A fresh private target; committing proves numeric upload only, not native consumers. */
  prepare(
    queue: RhiQueue,
    buffer: Buffer,
    descriptors?: readonly GpuInputDescriptorReservation[],
    capacityBytes?: number,
  ): Result<GpuInputPreparation, RhiError>;
  release(): void;
}

/** Real arena address with task-owned bytes; not part of the accepted backing or upload. */
export interface GpuInputDescriptorReservation {
  readonly address: number;
  readonly wordCount: number;
  readWord(index: number): number;
  copyTo(target: Uint32Array, offset: number, start?: number, count?: number): void;
  isCurrent(): boolean;
  release(): void;
}

const COALESCE_GAP_WORDS = 64;
const INITIAL_WORDS = 256;
type DirtyRange = { start: number; end: number };
interface UploadConnection {
  released: boolean;
  busy: boolean;
  needsFull: boolean;
  readRevision: number;
  uploadedBytes: number;
  target: { readonly queue: RhiQueue; readonly buffer: Buffer } | undefined;
}
interface PreparingUpload {
  readonly task: InputPreparation;
  readonly connection: UploadConnection;
  readonly queue: RhiQueue;
  readonly buffer: Buffer;
  readonly session: object;
  readonly privateWords?: Uint32Array<ArrayBuffer>;
  readonly privateFloats?: Float32Array<ArrayBuffer>;
  readonly descriptors: readonly GpuInputDescriptorReservation[];
}

/** Renderer-owned CPU numbers and range identity, independent of any GPU incarnation. */
export class GpuInputArena {
  // Pose frames retire and re-create rows of a few recurring sizes.
  private readonly ranges = new StableRangeAllocator(1 << 19);
  private words = new Uint32Array(INITIAL_WORDS);
  private floats = new Float32Array(this.words.buffer);
  private readonly pending = new Map<number, DirtyRange>();
  private pendingOrder = new Uint32Array(0);
  private active: UploadConnection | undefined;
  private activeSession: object = {};
  private preparing: PreparingUpload | undefined;
  private readonly usedTargets = new WeakSet<Buffer>();
  private writing = 0;
  private revision = 0;
  private liveWords = 1;
  private reviewTail = false;
  private failed = false;
  private disposed = false;
  private readonly privateDescriptors = new WeakMap<
    GpuInputDescriptorReservation,
    { consume(): void }
  >();
  constructor(readonly byteLimit = 128 * 1024 * 1024) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1024 || byteLimit > 0xffffffff * 4)
      throw invalid('a bounded numeric arena budget of at least 1024 bytes');
    this.ranges.reset(1);
  }
  get byteLength(): number {
    return this.words.byteLength;
  }
  get live(): boolean {
    return !this.disposed && !this.failed;
  }
  assertLive(): void {
    if (!this.live) throw invalid('a live CPU numeric arena');
  }

  /** At frame acceptance, return only a proven unused tail. Native readers
   * keep their buffers, and private preparation keeps its original extent. */
  reclaimTail(): void {
    const capacity = this.words.length;
    if (
      !this.reviewTail ||
      this.writing !== 0 ||
      this.preparing !== undefined ||
      !this.live ||
      !shouldShrinkCapacity(this.liveWords, capacity)
    )
      return;
    this.reviewTail = false;
    const extent = this.ranges.releaseTail();
    if (!shouldShrinkCapacity(extent, capacity)) return;
    let words = INITIAL_WORDS;
    while (words < extent) words *= 2;
    const next = this.words.slice(0, words);
    const floats = new Float32Array(next.buffer);
    this.words = next;
    this.floats = floats;
    if (this.pendingOrder.length > words) this.pendingOrder = new Uint32Array(0);
  }

  private releaseRange(address: number, words: number): void {
    // A non-tail release cannot expose a new upper bound. Keep an existing
    // review pending until the population becomes small enough to consider it.
    const wasTail = address + words === this.ranges.reservedCapacity();
    this.ranges.release(address, words);
    this.liveWords -= words;
    this.reviewTail ||= wasTail;
  }
  /** Reusable address-ordered view of the pending population. */
  private sortedPending(): Uint32Array {
    if (this.pendingOrder.length < this.pending.size)
      this.pendingOrder = new Uint32Array(
        Math.max(this.pending.size, this.pendingOrder.length * 2),
      );
    let count = 0;
    for (const address of this.pending.keys()) this.pendingOrder[count++] = address;
    return this.pendingOrder.subarray(0, count).sort();
  }
  private changed(address: number, words: number, index = 0): void {
    this.revision++;
    if (this.active !== undefined) {
      // Keep allocation identity for retirement while uploading only its dirty suffix.
      const range = this.pending.get(address) ?? { start: address + index, end: address + words };
      range.start = Math.min(range.start, address + index);
      range.end = Math.max(range.end, address + words);
      this.pending.set(address, range);
    }
    // Even a cold, not-yet-active writer must observe every actual byte mutation.
    this.preparing?.task.changed(address, words, index);
  }
  allocateDescriptor(wordCount: number): number {
    this.assertLive();
    u32(wordCount);
    if (wordCount === 0) throw invalid('a nonempty numeric descriptor');
    const address = this.ranges.allocate(wordCount);
    try {
      const end = address + wordCount;
      u32(end);
      const maxWords = Math.floor(this.byteLimit / 4);
      if (end > maxWords) throw invalid('numeric storage within the arena budget');
      if (end > this.words.length) {
        let capacity = this.words.length;
        while (capacity < end) capacity = Math.min(capacity * 2, maxWords);
        const next = new Uint32Array(capacity);
        const floats = new Float32Array(next.buffer);
        next.set(this.words);
        this.words = next;
        this.floats = floats;
      }
      this.words.fill(0, address, end);
      this.changed(address, wordCount);
      this.liveWords += wordCount;
      return address;
    } catch (cause) {
      this.pending.delete(address);
      try {
        this.reviewTail ||= address + wordCount === this.ranges.reservedCapacity();
        this.ranges.release(address, wordCount);
      } catch (cleanup) {
        this.failed = true;
        throw new AggregateError([cause, cleanup], 'Numeric allocation rollback failed', { cause });
      }
      throw cause;
    }
  }

  reserveDescriptor(
    wordCount: number,
    initialize: (address: number, scratch: DataView) => void,
    capture?: (reservation: GpuInputDescriptorReservation) => void,
  ): GpuInputDescriptorReservation {
    this.assertLive();
    u32(wordCount);
    if (wordCount === 0 || wordCount > Math.floor(this.byteLimit / 4))
      throw invalid('a nonempty private descriptor within the arena budget');
    const range = this.ranges.reserve(wordCount);
    this.liveWords += wordCount;
    let owner: GpuInputArena | undefined = this;
    let words: Uint32Array | undefined;
    let failure: { cause: unknown } | undefined;
    const current = () =>
      failure === undefined && words !== undefined && owner?.live === true && range.isCurrent();
    const api: GpuInputDescriptorReservation = Object.freeze({
      address: range.start,
      wordCount,
      isCurrent: current,
      readWord: (index: number) => {
        if (!current() || !Number.isSafeInteger(index) || index < 0 || index >= wordCount)
          throw invalid('a current private descriptor word');
        return words?.[index] ?? 0;
      },
      copyTo: (target: Uint32Array, offset: number, start = 0, count = wordCount - start) => {
        if (
          !current() ||
          words === undefined ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(count) ||
          start < 0 ||
          count < 0 ||
          start + count > wordCount ||
          offset + count > target.length
        )
          throw invalid('a current private descriptor and a complete destination');
        target.set(words.subarray(start, start + count), offset);
      },
      release: () => {
        if (failure !== undefined) throw failure.cause;
        const held = owner;
        if (held === undefined) return;
        owner = undefined;
        try {
          const wasTail = range.start + wordCount === held.ranges.reservedCapacity();
          range.release();
          held.liveWords -= wordCount;
          held.reviewTail ||= wasTail;
          words = undefined;
          held.privateDescriptors.delete(api);
        } catch (cause) {
          owner = held;
          held.failed = true;
          failure = { cause };
          throw cause;
        }
      },
    });
    this.privateDescriptors.set(api, {
      consume: () => {
        if (!current()) throw invalid('the exact private numeric allocation before transfer');
        range.accept();
        owner = undefined;
        words = undefined;
        this.privateDescriptors.delete(api);
      },
    });
    try {
      capture?.(api);
      if (range.start + wordCount > Math.floor(this.byteLimit / 4))
        throw invalid('private descriptor addresses within the arena budget');
      if (owner !== this || !range.isCurrent())
        throw invalid('the original private descriptor reservation');
      const scratch = new Uint32Array(wordCount);
      initialize(range.start, new DataView(scratch.buffer));
      this.assertLive();
      if (owner !== this || !range.isCurrent())
        throw invalid('the original private descriptor reservation');
      // The initializer borrows scratch; retained caller views cannot mutate the owned value.
      words = scratch.slice();
      return api;
    } catch (cause) {
      try {
        api.release();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Private numeric reservation rollback failed', {
          cause,
        });
      }
      throw cause;
    }
  }

  ownsDescriptorReservation(value: GpuInputDescriptorReservation): boolean {
    return this.live && this.privateDescriptors.has(value) && value.isCurrent();
  }

  /** Capacity for the same arena's actual private addresses, without growing accepted bytes. */
  preparationByteLength(descriptors: readonly GpuInputDescriptorReservation[]): number {
    this.assertLive();
    let words = this.words.length;
    for (const descriptor of descriptors) {
      if (!this.ownsDescriptorReservation(descriptor))
        throw invalid('current private descriptors from this numeric arena');
      words = Math.max(words, descriptor.address + descriptor.wordCount);
    }
    if (words * 4 > this.byteLimit)
      throw invalid('private numeric backing within the arena budget');
    return words * 4;
  }
  /** Write a descriptor suffix while dirty tracking retains the complete
   * allocation identity and extent. index=0 writes the ordinary whole row.
   */
  writeDescriptor(address: number, source: DataView, wordCount: number, index = 0): void {
    this.assertLive();
    u32(address);
    u32(wordCount);
    u32(index);
    if (
      address === 0 ||
      wordCount === 0 ||
      index >= wordCount ||
      address + wordCount > this.words.length ||
      (wordCount - index) * 4 > source.byteLength
    )
      throw invalid('a complete numeric descriptor within owned storage');
    let changed = false;
    for (let i = index; i < wordCount; i++) {
      const value = source.getUint32((i - index) * 4, true);
      if (this.words[address + i] === value) continue;
      this.words[address + i] = value;
      changed = true;
    }
    if (changed) this.changed(address, wordCount, index);
  }
  writeDescriptorWord(address: number, wordCount: number, index: number, value: number): void {
    this.assertLive();
    u32(address);
    u32(wordCount);
    u32(index);
    u32(value);
    if (address === 0 || index >= wordCount || address + wordCount > this.words.length)
      throw invalid('one word within a complete owned numeric descriptor');
    if (this.words[address + index] === value) return;
    this.words[address + index] = value;
    this.changed(address, index + 1, index);
  }
  readWord(address: number): number {
    this.assertLive();
    u32(address);
    if (address >= this.words.length) throw invalid('a retained numeric word');
    return this.words[address] as number;
  }
  /** Copy from the current backing; never lend a view that growth could invalidate. */
  readFloatWord(address: number): number {
    this.assertLive();
    if (!Number.isSafeInteger(address) || address < 0 || address >= this.words.length)
      throw invalid('a live input arena float address');
    return this.floats[address] as number;
  }

  readFloatWords(address: number, out: Float32Array): void {
    this.assertLive();
    u32(address);
    if (address === 0 || out.length === 0 || address + out.length > this.words.length)
      throw invalid('a complete retained numeric float range');
    for (let lane = 0; lane < out.length; lane++) out[lane] = this.floats[address + lane] as number;
  }

  /** Write paired retained matrices to a task-owned packed range and check the rounded products. */
  readMatrixProducts(
    out: Float32Array,
    offset: number,
    left: number,
    right: number,
    count: number,
  ): boolean {
    this.assertLive();
    u32(left);
    u32(right);
    u32(offset);
    u32(count);
    const lanes = count * 16;
    if (
      left === 0 ||
      right === 0 ||
      count === 0 ||
      Math.max(left, right) + lanes > this.words.length ||
      offset + lanes > out.length
    )
      throw invalid('two complete retained matrix ranges and a complete packed output');
    const floats = this.floats;
    for (let lane = 0; lane < lanes; lane += 16)
      mat4.multiply(out, floats, floats, right + lane, left + lane, offset + lane);
    for (let lane = offset, end = offset + lanes; lane < end; lane++) {
      const value = out[lane] as number;
      // A rounded Float32 lands strictly between the infinities exactly when finite.
      if (!(value > -Infinity && value < Infinity)) return false;
    }
    return true;
  }
  fillDescriptor(address: number, count: number, value: number): void {
    this.assertLive();
    u32(address);
    u32(count);
    u32(value);
    if (address === 0 || count === 0 || address + count > this.words.length)
      throw invalid('a complete owned numeric fill range');
    this.words.fill(value, address, address + count);
    this.changed(address, count);
  }
  copyDescriptor(address: number, source: number, count: number): void {
    this.assertLive();
    u32(address);
    u32(source);
    u32(count);
    if (
      address === 0 ||
      source === 0 ||
      count === 0 ||
      address + count > this.words.length ||
      source + count > this.words.length
    )
      throw invalid('complete retained numeric copy ranges');
    this.words.copyWithin(address, source, source + count);
    this.changed(address, count);
  }
  releaseDescriptor(address: number, wordCount: number): void {
    if (this.disposed) return;
    u32(address);
    u32(wordCount);
    if (address === 0 || wordCount === 0 || address + wordCount > this.words.length)
      throw invalid('a numeric descriptor range within owned storage');
    this.pending.delete(address);
    try {
      this.releaseRange(address, wordCount);
    } catch (cause) {
      this.failed = true;
      throw cause;
    }
  }
  /** One active dirty population and one independently observed private preparation. */
  connect(): GpuInputUpload {
    this.assertLive();
    const connection: UploadConnection = {
      released: false,
      busy: false,
      needsFull: true,
      readRevision: -1,
      uploadedBytes: 0,
      target: undefined,
    };
    return {
      get uploadBytes() {
        return connection.uploadedBytes;
      },
      isCurrent: (queue, buffer) =>
        this.connectionWritable(connection, buffer) &&
        !connection.needsFull &&
        connection.readRevision === this.revision &&
        connection.target?.buffer === buffer &&
        connection.target.queue === queue,
      activate: () => this.activateConnection(connection),
      flush: (queue, buffer, initial) => this.flushConnection(connection, queue, buffer, initial),
      prepare: (queue, buffer, descriptors, capacityBytes) =>
        this.prepareConnection(connection, queue, buffer, descriptors, capacityBytes),
      release: () => this.releaseConnection(connection),
    };
  }

  private activateConnection(connection: UploadConnection): void {
    this.assertLive();
    if (connection.released) throw invalid('a live upload incarnation');
    if (this.active === connection) return;
    this.preparing?.task.api.release();
    this.active = connection;
    this.activeSession = {};
    this.pending.clear();
    connection.needsFull = true;
  }

  private releaseConnection(connection: UploadConnection): void {
    if (connection.released) return;
    connection.released = true;
    connection.target = undefined;
    if (this.preparing?.connection === connection) this.preparing.task.api.release();
    if (this.active === connection) {
      this.preparing?.task.api.release();
      this.active = undefined;
      this.activeSession = {};
      this.pending.clear();
    }
  }

  private writeUpload(
    connection: UploadConnection,
    queue: RhiQueue,
    buffer: Buffer,
    words: Uint32Array<ArrayBuffer>,
    start: number,
    count: number,
    full = false,
  ): Result<void, RhiError> {
    this.usedTargets.add(buffer);
    this.writing++;
    try {
      const result = full
        ? queue.writeBuffer(buffer, 0, words)
        : queue.writeBuffer(buffer, start * 4, words.buffer, start * 4, count * 4);
      if (result.ok) connection.uploadedBytes += count * 4;
      return result;
    } finally {
      this.writing--;
    }
  }

  private flushPending(
    connection: UploadConnection,
    queue: RhiQueue,
    buffer: Buffer,
  ): Result<void, RhiError> {
    const addresses = this.sortedPending();
    let start = -1,
      end = -1;
    for (const address of addresses) {
      const next = this.pending.get(address);
      if (next === undefined) continue;
      if (start < 0) {
        start = next.start;
        end = next.end;
        continue;
      }
      if (next.start <= end + COALESCE_GAP_WORDS) {
        end = Math.max(end, next.end);
        continue;
      }
      const result = this.writeUpload(connection, queue, buffer, this.words, start, end - start);
      if (!result.ok) return result;
      start = next.start;
      end = next.end;
    }
    return start < 0
      ? ok(undefined)
      : this.writeUpload(connection, queue, buffer, this.words, start, end - start);
  }

  private connectionWritable(connection: UploadConnection, buffer: Buffer): boolean {
    return (
      this.live &&
      !connection.released &&
      !connection.busy &&
      this.writing === 0 &&
      this.preparing?.connection !== connection &&
      this.preparing?.buffer !== buffer
    );
  }

  private flushConnection(
    connection: UploadConnection,
    queue: RhiQueue,
    buffer: Buffer,
    initial: boolean,
  ): Result<void, RhiError> {
    if (!this.connectionWritable(connection, buffer))
      return err(invalid('a live upload outside private preparation and native writes'));
    connection.busy = true;
    try {
      const revision = this.revision,
        session = this.activeSession;
      const active = this.active === connection;
      const full =
        initial ||
        connection.needsFull ||
        connection.target?.buffer !== buffer ||
        connection.target.queue !== queue ||
        (!active && connection.readRevision !== revision);
      const result = full
        ? this.writeUpload(connection, queue, buffer, this.words, 0, this.words.length, true)
        : active
          ? this.flushPending(connection, queue, buffer)
          : ok(undefined);
      if (!result.ok) return result;
      if (
        !this.live ||
        connection.released ||
        this.activeSession !== session ||
        (this.active === connection) !== active
      )
        return err(invalid('unchanged upload lifetime and active session after writing'));
      if (
        active &&
        this.active === connection &&
        this.activeSession === session &&
        revision === this.revision
      )
        this.pending.clear();
      connection.needsFull = false;
      connection.readRevision = revision;
      connection.target = { queue, buffer };
      return ok(undefined);
    } finally {
      connection.busy = false;
    }
  }

  private preparationCurrent(role: PreparingUpload): boolean {
    return (
      this.live &&
      this.writing === 0 &&
      this.preparing === role &&
      !role.connection.released &&
      !role.connection.busy &&
      this.activeSession === role.session &&
      this.active !== role.connection &&
      (role.privateWords === undefined || this.words.length <= role.privateWords.length) &&
      role.descriptors.every((descriptor) => this.ownsDescriptorReservation(descriptor))
    );
  }

  private publishPrepared(
    role: PreparingUpload,
    revision: number,
    extent: number,
  ): Result<void, RhiError> {
    if (
      !this.preparationCurrent(role) ||
      this.revision !== revision ||
      (role.privateWords ?? this.words).byteLength !== extent
    )
      return err(invalid('the exact current prepared upload and original active session'));
    if (role.privateWords !== undefined) {
      const floats = role.privateFloats;
      if (floats === undefined) return err(invalid('the prebuilt private numeric views'));
      try {
        for (const descriptor of role.descriptors) {
          const claim = this.privateDescriptors.get(descriptor);
          if (claim === undefined) throw invalid('the issuing private numeric allocation');
          claim.consume();
        }
        this.words = role.privateWords;
        this.floats = floats;
        this.revision++;
      } catch (cause) {
        this.failed = true;
        throw cause;
      }
    }
    role.connection.target = { queue: role.queue, buffer: role.buffer };
    role.connection.needsFull = false;
    role.connection.readRevision = this.revision;
    this.active = role.connection;
    this.activeSession = {};
    this.pending.clear();
    this.preparing = undefined;
    return ok(undefined);
  }

  private prepareConnection(
    connection: UploadConnection,
    queue: RhiQueue,
    buffer: Buffer,
    descriptors: readonly GpuInputDescriptorReservation[] = [],
    capacityBytes?: number,
  ): Result<GpuInputPreparation, RhiError> {
    if (
      !this.live ||
      connection.released ||
      connection.busy ||
      this.active === connection ||
      connection.target !== undefined ||
      this.preparing !== undefined ||
      this.usedTargets.has(buffer)
    )
      return err(invalid('one detached upload incarnation with a fresh private native target'));
    const owned = [...new Set(descriptors)].sort((a, b) => a.address - b.address);
    const required = owned.length === 0 ? this.byteLength : this.preparationByteLength(owned);
    const allocated = capacityBytes ?? required;
    if (
      !Number.isSafeInteger(allocated) ||
      allocated % 4 !== 0 ||
      allocated < required ||
      (owned.length !== 0 && allocated > this.byteLimit)
    )
      return err(invalid('one prepared numeric backing within the granted native capacity'));
    const privateWords = owned.length === 0 ? undefined : new Uint32Array(allocated / 4);
    const task: InputPreparation = new InputPreparation(
      {
        snapshot: () => ({ words: privateWords ?? this.words, revision: this.revision }),
        current: () => this.preparing?.task === task && this.preparationCurrent(this.preparing),
        write: (targetQueue, targetBuffer, words, start, count) => {
          if (privateWords !== undefined) this.copyPrivateWords(privateWords, owned, start, count);
          return this.writeUpload(connection, targetQueue, targetBuffer, words, start, count);
        },
        publish: (_task, revision, extent) =>
          this.preparing?.task === task
            ? this.publishPrepared(this.preparing, revision, extent)
            : err(invalid('the issuing preparation')),
        detach: (closed) => {
          if (this.preparing?.task === closed) this.preparing = undefined;
        },
      },
      queue,
      buffer,
    );
    this.usedTargets.add(buffer);
    this.preparing = {
      task,
      connection,
      queue,
      buffer,
      session: this.activeSession,
      descriptors: owned,
      ...(privateWords === undefined
        ? {}
        : {
            privateWords,
            privateFloats: new Float32Array(privateWords.buffer),
          }),
    };
    return ok(task.api);
  }

  private copyPrivateWords(
    target: Uint32Array,
    descriptors: readonly GpuInputDescriptorReservation[],
    start: number,
    count: number,
  ): void {
    const end = start + count;
    target.fill(0, start, end);
    target.set(this.words.subarray(start, Math.min(end, this.words.length)), start);
    for (const descriptor of descriptors) {
      if (descriptor.address >= end) break;
      const first = Math.max(start, descriptor.address);
      const last = Math.min(end, descriptor.address + descriptor.wordCount);
      if (first < last) descriptor.copyTo(target, first, first - descriptor.address, last - first);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.preparing?.task.api.release();
    if (this.active !== undefined) this.releaseConnection(this.active);
    this.activeSession = {};
    this.pending.clear();
    this.active = undefined;
    this.ranges.reset(1);
    this.words = new Uint32Array(0);
    this.floats = new Float32Array(this.words.buffer);
  }
}
