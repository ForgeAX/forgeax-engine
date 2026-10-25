import {
  type Buffer,
  err,
  ok,
  type Result,
  type RhiDevice,
  RhiError,
  type RhiQueue,
} from '@forgeax/engine-rhi';
import { StableRangeAllocator } from './stable-range-allocator';

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
  flush(queue: RhiQueue, buffer: Buffer, initial: boolean): Result<void, RhiError>;
  activate(): void;
  release(): void;
}

const COALESCE_GAP_WORDS = 64;

/** Renderer-owned CPU numbers and range identity, independent of any GPU incarnation. */
export class GpuInputArena {
  // Pose frames retire and re-create rows of a few recurring sizes.
  private readonly ranges = new StableRangeAllocator(1 << 19);
  private words = new Uint32Array(256);
  private floats = new Float32Array(this.words.buffer);
  private readonly pending = new Map<number, number>();
  private pendingOrder = new Uint32Array(0);
  private active: GpuInputUpload | undefined;
  private revision = 0;
  private failed = false;
  private disposed = false;
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
  private changed(address: number, words: number): void {
    this.revision++;
    if (this.active !== undefined) this.pending.set(address, words);
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
      return address;
    } catch (cause) {
      this.pending.delete(address);
      try {
        this.ranges.release(address, wordCount);
      } catch (cleanup) {
        this.failed = true;
        throw new AggregateError([cause, cleanup], 'Numeric allocation rollback failed', { cause });
      }
      throw cause;
    }
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
    if (changed) this.changed(address, wordCount);
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
    this.changed(address, wordCount);
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
      this.ranges.release(address, wordCount);
    } catch (cause) {
      this.failed = true;
      throw cause;
    }
  }
  /** One producer dirty population. Detached recovery candidates read cold snapshots. */
  connect(): GpuInputUpload {
    this.assertLive();
    let released = false,
      needsFull = true,
      readRevision = -1,
      uploadedBytes = 0;
    const upload: GpuInputUpload = {
      get uploadBytes() {
        return uploadedBytes;
      },
      activate: () => {
        this.assertLive();
        if (released) throw invalid('a live upload incarnation');
        if (this.active === upload) return;
        this.active = upload;
        this.pending.clear();
        needsFull = true;
      },
      flush: (queue, buffer, initial) => {
        if (released || this.disposed || this.failed)
          return err(invalid('a live numeric upload incarnation'));
        const revision = this.revision;
        const active = this.active === upload;
        if (initial || needsFull || (!active && readRevision !== revision)) {
          const uploaded = queue.writeBuffer(buffer, 0, this.words);
          if (!uploaded.ok) return uploaded;
          uploadedBytes += this.words.byteLength;
        } else if (active && this.pending.size > 0) {
          // Known changes are often adjacent rows. Uploading a short unchanged
          // gap from the authoritative CPU words is cheaper than another queue
          // write, so nearby ranges share one call in address order.
          const addresses = this.sortedPending();
          let start = addresses[0] as number;
          let end = start + (this.pending.get(start) as number);
          for (let index = 1; index <= addresses.length; index++) {
            const address = addresses[index];
            if (address !== undefined && address <= end + COALESCE_GAP_WORDS) {
              end = Math.max(end, address + (this.pending.get(address) as number));
              continue;
            }
            const uploaded = queue.writeBuffer(
              buffer,
              start * 4,
              this.words.buffer,
              start * 4,
              (end - start) * 4,
            );
            if (!uploaded.ok) return uploaded;
            uploadedBytes += (end - start) * 4;
            if (address === undefined) break;
            start = address;
            end = address + (this.pending.get(address) as number);
          }
        }
        if (active && revision === this.revision) this.pending.clear();
        needsFull = false;
        readRevision = revision;
        return ok(undefined);
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.active === upload) {
          this.active = undefined;
          this.pending.clear();
        }
      },
    };
    return upload;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.clear();
    this.active = undefined;
    this.ranges.reset(1);
    this.words = new Uint32Array(0);
    this.floats = new Float32Array(this.words.buffer);
  }
}
