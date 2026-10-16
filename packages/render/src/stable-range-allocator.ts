export interface StableRange {
  readonly start: number;
  readonly count: number;
}

/** Reusable physical ranges; changing one allocation never compacts another. */
export class StableRangeAllocator {
  private next = 0;
  private readonly free: Array<{ start: number; count: number }> = [];

  allocate(count: number, alignment = 1): number {
    if (count <= 0) return 0;
    if (!Number.isSafeInteger(alignment) || alignment < 1)
      throw new RangeError('range alignment must be a positive integer');
    for (let index = 0; index < this.free.length; index += 1) {
      const range = this.free[index];
      if (range === undefined) continue;
      const start = Math.ceil(range.start / alignment) * alignment;
      const end = start + count;
      const rangeEnd = range.start + range.count;
      if (end > rangeEnd) continue;
      this.free.splice(index, 1);
      if (start > range.start) this.release(range.start, start - range.start);
      if (end < rangeEnd) this.release(end, rangeEnd - end);
      return start;
    }
    const start = Math.ceil(this.next / alignment) * alignment;
    if (start > this.next) this.release(this.next, start - this.next);
    this.next = start + count;
    return start;
  }

  /** Retain spare capacity while the owner remains live; grow only its range. */
  resize(previous: StableRange | undefined, count: number): StableRange {
    if (previous !== undefined && previous.count >= count) return previous;
    if (previous !== undefined) this.release(previous.start, previous.count);
    return { start: this.allocate(count), count };
  }

  release(start: number, count: number): void {
    if (count <= 0) return;
    this.free.push({ start, count });
    this.free.sort((left, right) => left.start - right.start);
    for (let index = this.free.length - 1; index > 0; index -= 1) {
      const current = this.free[index];
      const previous = this.free[index - 1];
      if (
        current === undefined ||
        previous === undefined ||
        previous.start + previous.count !== current.start
      )
        continue;
      this.free[index - 1] = { start: previous.start, count: previous.count + current.count };
      this.free.splice(index, 1);
    }
  }

  requiredCapacity(): number {
    return this.next;
  }

  reset(start = 0): void {
    this.next = start;
    this.free.length = 0;
  }
}
