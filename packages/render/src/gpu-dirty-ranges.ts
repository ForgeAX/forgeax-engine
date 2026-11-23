/** Renderer-local linear ordering of fixed-width GPU row addresses. */
export class GpuDirtyRanges {
  private first = new Uint32Array(0);
  private second = new Uint32Array(0);
  private counts: Uint32Array | undefined;

  start(index: number): number {
    return this.first[index] as number;
  }
  end(index: number): number {
    return (this.second[index] as number) + 1;
  }

  private reserve(count: number, keep: number): void {
    if (count <= this.first.length) return;
    const capacity = 2 ** Math.ceil(Math.log2(count));
    const first = new Uint32Array(capacity);
    const second = new Uint32Array(capacity);
    if (keep > 0) {
      first.set(this.first);
      second.set(this.second);
    }
    this.first = first;
    this.second = second;
  }

  /** Ordered submissions emit endpoints directly. Arbitrary row order uses the same pages for radix sorting. */
  coalesce(slots: readonly number[], maxCleanGap = 0): number {
    if (slots.length === 0) return 0;
    let start = slots[0] as number;
    let last = start;
    let count = 0;
    for (let i = 1; i < slots.length; i++) {
      const slot = slots[i] as number;
      if (slot < last) return this.coalesceUnordered(slots, maxCleanGap);
      if (slot - last - 1 > maxCleanGap) {
        this.reserve(count + 1, count);
        this.first[count] = start;
        this.second[count++] = last;
        start = slot;
      }
      last = slot;
    }
    this.reserve(count + 1, count);
    this.first[count] = start;
    this.second[count] = last;
    return count + 1;
  }

  private coalesceUnordered(slots: readonly number[], maxCleanGap: number): number {
    this.reserve(slots.length, 0);
    this.counts ??= new Uint32Array(256);
    const counts = this.counts;
    let varyingBits = 0;
    const firstSlot = slots[0] as number;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i] as number;
      this.first[i] = slot;
      varyingBits |= slot ^ firstSlot;
    }
    let source = this.first;
    let target = this.second;
    for (let shift = 0; shift < 32; shift += 8) {
      if (((varyingBits >>> shift) & 255) === 0) continue;
      counts.fill(0);
      for (let i = 0; i < slots.length; i++) {
        const bucket = ((source[i] ?? 0) >>> shift) & 255;
        counts[bucket] = (counts[bucket] ?? 0) + 1;
      }
      let offset = 0;
      for (let i = 0; i < 256; i++) {
        const count = counts[i] ?? 0;
        counts[i] = offset;
        offset += count;
      }
      for (let i = 0; i < slots.length; i++) {
        const value = source[i] ?? 0;
        const bucket = (value >>> shift) & 255;
        const index = counts[bucket] ?? 0;
        target[index] = value;
        counts[bucket] = index + 1;
      }
      const swap = source;
      source = target;
      target = swap;
    }
    let count = 0;
    let last = -2;
    for (let i = 0; i < slots.length; i++) {
      const slot = source[i] as number;
      if (count === 0 || slot - last - 1 > maxCleanGap) {
        this.first[count] = slot;
        count++;
      }
      last = slot;
      this.second[count - 1] = slot;
    }
    return count;
  }
}
