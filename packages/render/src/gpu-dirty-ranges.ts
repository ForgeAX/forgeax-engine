/** Renderer-local linear ordering of fixed-width GPU row addresses. */
export class GpuDirtyRanges {
  private first = new Uint32Array(0);
  private second = new Uint32Array(0);
  private readonly counts = new Uint32Array(256);

  coalesce(slots: readonly number[]): readonly { readonly start: number; readonly end: number }[] {
    if (slots.length === 0) return [];
    if (slots.length > this.first.length) {
      const capacity = 2 ** Math.ceil(Math.log2(slots.length));
      this.first = new Uint32Array(capacity);
      this.second = new Uint32Array(capacity);
    }
    this.first.set(slots);
    let source = this.first;
    let target = this.second;
    for (let shift = 0; shift < 32; shift += 8) {
      this.counts.fill(0);
      for (let i = 0; i < slots.length; i++) {
        const bucket = ((source[i] ?? 0) >>> shift) & 255;
        this.counts[bucket] = (this.counts[bucket] ?? 0) + 1;
      }
      let offset = 0;
      for (let i = 0; i < 256; i++) {
        const count = this.counts[i] ?? 0;
        this.counts[i] = offset;
        offset += count;
      }
      for (let i = 0; i < slots.length; i++) {
        const value = source[i] ?? 0;
        const bucket = (value >>> shift) & 255;
        const index = this.counts[bucket] ?? 0;
        target[index] = value;
        this.counts[bucket] = index + 1;
      }
      [source, target] = [target, source];
    }
    const ranges: { start: number; end: number }[] = [];
    for (let i = 0; i < slots.length; i++) {
      const slot = source[i] ?? 0;
      const previous = ranges.at(-1);
      if (previous !== undefined && slot <= previous.end)
        previous.end = Math.max(previous.end, slot + 1);
      else ranges.push({ start: slot, end: slot + 1 });
    }
    return ranges;
  }
}
