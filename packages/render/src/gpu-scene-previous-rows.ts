import { dynamicCapacity, shouldShrinkCapacity } from './dynamic-capacity';
import type { StableRangeAllocator } from './stable-range-allocator';

type AddressRun = { first: number; count: number };

/** Submission-scoped previous transforms. Consecutive physical addresses share one run. */
export class GpuScenePreviousRows {
  private readonly runs: AddressRun[] = [];
  private capacity = 0;
  private used = 0;
  private run = 0;
  private next = 0;
  private after = 0;
  private smallSubmissions = 0;
  private repack = -1;

  constructor(private readonly allocator: StableRangeAllocator) {}

  take(): number {
    this.used++;
    if (this.next < this.after) return this.next++;
    const reserved = this.runs[this.run];
    if (reserved !== undefined) {
      this.run++;
      this.next = reserved.first + 1;
      this.after = reserved.first + reserved.count;
      return reserved.first;
    }
    const row = this.allocator.allocate(1);
    const tail = this.runs[this.run - 1];
    if (tail !== undefined && tail.count < 1024 && row === tail.first + tail.count) tail.count++;
    else {
      this.runs.push({ first: row, count: 1 });
      this.run++;
    }
    this.capacity++;
    return row;
  }

  /** Large source retirements can open space below the frame's scratch addresses. */
  sourceReleased(): void {
    if (this.repack < 0) this.repack = 0;
  }

  /** Queue order and the new frame stamp release the submitted frame's previous poses. */
  submitted(): boolean {
    const demand = this.used;
    this.run = this.next = this.after = this.used = 0;
    let released = false;
    if (this.repack >= 0) {
      const end = Math.min(this.repack + 32, this.runs.length);
      while (this.repack < end) {
        const range = this.runs[this.repack++] as AddressRun;
        const start = this.allocator.moveScratchLower(range.first, range.count);
        released ||= start !== range.first;
        range.first = start;
      }
      if (this.repack >= this.runs.length) this.repack = -1;
    }
    if (!shouldShrinkCapacity(demand, this.capacity)) {
      this.smallSubmissions = 0;
      return released;
    }
    // Alternating dense/sparse animation keeps its working space. A burst followed by
    // sustained smaller submissions gives physical addresses back, even in a live scene.
    if (++this.smallSubmissions < 16) return released;
    const keep = dynamicCapacity(demand);
    // Severely fragmented scenes return at most 32 allocator ranges on one receipt.
    for (let i = 0; i < 32 && this.capacity > keep; i++) {
      const tail = this.runs[this.runs.length - 1] as AddressRun;
      const count = Math.min(tail.count, this.capacity - keep);
      tail.count -= count;
      this.allocator.release(tail.first + tail.count, count);
      if (tail.count === 0) this.runs.pop();
      this.capacity -= count;
      released = true;
    }
    return released;
  }

  /** Disposed owners no longer use this address space. */
  clear(): void {
    this.runs.length = 0;
    this.repack = -1;
    this.run = this.next = this.after = this.used = this.capacity = this.smallSubmissions = 0;
  }
}
