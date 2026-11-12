import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type MemoryArray,
  type MemoryArrayConstructor,
  MemoryError,
  memoryByteLength,
  memoryLimit,
  type WorldMemoryOptions,
} from './memory-types';

const EMPTY_BUFFER = new ArrayBuffer(0);
interface Chunk {
  readonly buffer: ArrayBuffer;
  cursor: number;
  used: boolean;
}
export interface FrameArenaStats {
  readonly active: boolean;
  readonly usedBytes: number;
  readonly peakBytes: number;
  readonly committedBytes: number;
  readonly chunks: number;
  readonly backingAllocations: number;
  readonly requests: number;
  readonly trimmedBytes: number;
}
/** System-facing allocation capability. Only the World runner owns scope transitions. */
export interface FrameArena {
  readonly isActive: boolean;
  alloc<T extends MemoryArray>(
    ctor: MemoryArrayConstructor<T>,
    count: number,
  ): Result<T, MemoryError>;
}
export class WorldFrameArena implements FrameArena {
  private readonly chunks: Chunk[] = [];
  private readonly maxBytes: number;
  private readonly retainBytes: number;
  private readonly maxScopeBytes: number;
  private current = 0;
  private active = false;
  private usedBytes = 0;
  private peakBytes = 0;
  private committedBytes = 0;
  private allocations = 0;
  private requests = 0;
  private trimmedBytes = 0;
  constructor(options: WorldMemoryOptions['arena'] = {}) {
    this.maxBytes = memoryLimit(options.maxBytes, 64 * 1024 * 1024);
    this.retainBytes = Math.min(this.maxBytes, memoryLimit(options.retainBytes, 8 * 1024 * 1024));
    this.maxScopeBytes = memoryLimit(options.maxScopeBytes, this.maxBytes);
  }
  get isActive(): boolean {
    return this.active;
  }
  open(): void {
    this.active = true;
  }
  close(): void {
    this.active = false;
    this.usedBytes = 0;
    // Only the visited chunk prefix is reset, without per-frame iterators/lists.
    const end = this.current + 1;
    for (let i = 0; i < Math.min(end, this.chunks.length); i++)
      (this.chunks[i] as Chunk).cursor = 0;
    this.trim(this.retainBytes, true);
    for (let i = 0; i < Math.min(end, this.chunks.length); i++)
      (this.chunks[i] as Chunk).used = false;
    this.current = 0;
  }
  alloc<T extends MemoryArray>(
    ctor: MemoryArrayConstructor<T>,
    count: number,
  ): Result<T, MemoryError> {
    if (!this.active) return err(new MemoryError({ kind: 'scope', reason: 'closed' }));
    const sized = memoryByteLength(ctor, count);
    if (typeof sized !== 'number') return err(sized);
    const bytes = sized;
    if (bytes === 0) {
      this.requests++;
      return ok(new ctor(EMPTY_BUFFER, 0, 0));
    }
    if (this.usedBytes + bytes > this.maxScopeBytes)
      return err(
        new MemoryError({ kind: 'budget', requestedBytes: bytes, limitBytes: this.maxScopeBytes }),
      );
    try {
      for (let index = this.current; index < this.chunks.length; index++) {
        const chunk = this.chunks[index] as Chunk;
        const offset = Math.ceil(chunk.cursor / ctor.BYTES_PER_ELEMENT) * ctor.BYTES_PER_ELEMENT;
        if (offset + bytes > chunk.buffer.byteLength) continue;
        const view = new ctor(chunk.buffer, offset, count);
        chunk.cursor = offset + bytes;
        chunk.used = true;
        this.current = index;
        this.accept(bytes);
        return ok(view);
      }
      const previous = this.chunks.at(-1)?.buffer.byteLength ?? 32768;
      const capacity = Math.max(
        bytes,
        Math.min(1024 * 1024, previous * 2, this.maxBytes - this.committedBytes),
      );
      if (this.committedBytes + capacity > this.maxBytes)
        return err(
          new MemoryError({ kind: 'budget', requestedBytes: capacity, limitBytes: this.maxBytes }),
        );
      const buffer = new ArrayBuffer(capacity);
      const view = new ctor(buffer, 0, count);
      const chunk = { buffer, cursor: bytes, used: true };
      this.chunks.push(chunk);
      this.current = this.chunks.length - 1;
      this.committedBytes += capacity;
      this.allocations++;
      this.accept(bytes);
      return ok(view);
    } catch (cause) {
      return err(new MemoryError({ kind: 'allocation', requestedBytes: bytes, cause }));
    }
  }
  trim(retainBytes = 0, coldOnly = false): number {
    if (this.active) return 0;
    let freed = 0;
    for (let i = this.chunks.length - 1; i >= 0 && this.committedBytes > retainBytes; i--) {
      const chunk = this.chunks[i] as Chunk;
      if (coldOnly && chunk.used) continue;
      this.chunks.splice(i, 1);
      this.committedBytes -= chunk.buffer.byteLength;
      this.trimmedBytes += chunk.buffer.byteLength;
      freed += chunk.buffer.byteLength;
    }
    return freed;
  }
  stats(): FrameArenaStats {
    return {
      active: this.active,
      usedBytes: this.usedBytes,
      peakBytes: this.peakBytes,
      committedBytes: this.committedBytes,
      chunks: this.chunks.length,
      backingAllocations: this.allocations,
      requests: this.requests,
      trimmedBytes: this.trimmedBytes,
    };
  }
  private accept(bytes: number): void {
    this.requests++;
    this.usedBytes += bytes;
    this.peakBytes = Math.max(this.peakBytes, this.usedBytes);
  }
}
