/**
 * Pending writes in one physical GPU table. Two runs fit in scalar endpoints.
 * Fragmented writes occupy one bit per address and a summary bit per nonempty
 * word, so iteration skips empty spans.
 * A failed submission keeps exactly the same set for the next attempt.
 */
export class GpuTableWrites {
  private first = 0;
  private after = 0;
  private second = 0;
  private secondAfter = 0;
  private fragmented = false;
  private readonly levels: Uint32Array[] = [];

  get empty(): boolean {
    return this.first === this.after;
  }

  get storageBytes(): number {
    let bytes = 0;
    for (const level of this.levels) bytes += level.byteLength;
    return bytes;
  }

  add(row: number): void {
    if (!this.fragmented) {
      if (this.admitRun(row, row + 1)) return;
    } else this.reserve(row);
    let bit = row;
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i] as Uint32Array;
      const word = bit >>> 5;
      const before = level[word] as number;
      level[word] = before | (1 << (bit & 31));
      if (before !== 0) return;
      bit = word;
    }
  }

  addRange(first: number, after: number): void {
    if (first >= after) return;
    if (!this.fragmented) {
      if (this.admitRun(first, after)) return;
    } else this.reserve(after - 1);
    this.writeRun(first, after);
  }

  private admitRun(first: number, after: number): boolean {
    if (this.empty) {
      this.first = first;
      this.after = after;
      return true;
    }
    if (first <= this.after && after >= this.first) {
      this.first = Math.min(this.first, first);
      this.after = Math.max(this.after, after);
      if (this.secondAfter !== 0 && this.after >= this.second) {
        this.after = Math.max(this.after, this.secondAfter);
        this.secondAfter = 0;
      }
      return true;
    }
    if (this.secondAfter === 0) {
      if (after < this.first) {
        this.second = this.first;
        this.secondAfter = this.after;
        this.first = first;
        this.after = after;
      } else {
        this.second = first;
        this.secondAfter = after;
      }
      return true;
    }
    if (first <= this.secondAfter && after >= this.second) {
      this.second = Math.min(first, this.second);
      this.secondAfter = Math.max(after, this.secondAfter);
      return true;
    }
    this.reserve(Math.max(after, this.secondAfter) - 1);
    this.writeRun(this.first, this.after);
    this.writeRun(this.second, this.secondAfter);
    this.fragmented = true;
    return false;
  }

  private reserve(lastRow: number): void {
    const required = (lastRow >>> 5) + 1;
    if ((this.levels[0]?.length ?? 0) >= required) return;
    const oldRoot = this.levels.at(-1)?.[0] ?? 0;
    let length = 2 ** Math.ceil(Math.log2(required));
    for (let i = 0; ; i++) {
      const old = this.levels[i];
      if (old?.length !== length) {
        const level = new Uint32Array(length);
        if (old !== undefined) level.set(old);
        else if (oldRoot !== 0) level[0] = 1;
        this.levels[i] = level;
      }
      if (length === 1) return;
      length = Math.ceil(length / 32);
    }
  }

  private writeRun(first: number, after: number): void {
    for (const level of this.levels) {
      const startWord = first >>> 5;
      const last = after - 1;
      const endWord = last >>> 5;
      const startMask = -1 << (first & 31);
      const endMask = 0xffffffff >>> (31 - (last & 31));
      if (startWord === endWord) {
        const before = level[startWord] as number;
        level[startWord] = before | (startMask & endMask);
        if (before !== 0) return;
      } else {
        level[startWord] = (level[startWord] as number) | startMask;
        level[endWord] = (level[endWord] as number) | endMask;
        if (endWord > startWord + 1) level.fill(0xffffffff, startWord + 1, endWord);
      }
      first = startWord;
      after = endWord + 1;
    }
  }

  /** First dirty row at or after the supplied address. */
  next(first: number): number {
    if (this.fragmented) return this.nextBit(0, first);
    if (first < this.after) return Math.max(first, this.first);
    return first < this.secondAfter ? Math.max(first, this.second) : -1;
  }

  /** Exclusive end of the dirty range containing this row. */
  end(first: number): number {
    if (this.fragmented) return this.endBit(0, first);
    return first < this.after ? this.after : this.secondAfter;
  }

  private nextBit(tier: number, first: number): number {
    const level = this.levels[tier] as Uint32Array;
    if (first >= level.length * 32) return -1;
    let word = first >>> 5;
    let bits = (level[word] as number) & (-1 << (first & 31));
    if (bits === 0) {
      if (tier + 1 === this.levels.length) return -1;
      word = this.nextBit(tier + 1, word + 1);
      if (word < 0) return -1;
      bits = level[word] as number;
    }
    return word * 32 + 31 - Math.clz32(bits & -bits);
  }

  private endBit(tier: number, first: number): number {
    const level = this.levels[tier] as Uint32Array;
    let word = first >>> 5;
    let holes = ~(level[word] as number) & (-1 << (first & 31));
    while (holes === 0) {
      if (++word >= level.length) return word * 32;
      holes = ~(level[word] as number);
    }
    return word * 32 + 31 - Math.clz32(holes & -holes);
  }

  clear(): void {
    if (this.fragmented) {
      for (let tier = 1; tier < this.levels.length; tier++) {
        const lower = this.levels[tier - 1] as Uint32Array;
        let word = this.nextBit(tier, 0);
        while (word !== -1) {
          const after = this.endBit(tier, word);
          lower.fill(0, word, after);
          word = this.nextBit(tier, after);
        }
      }
      (this.levels[this.levels.length - 1] as Uint32Array)[0] = 0;
    }
    this.first = this.after = this.secondAfter = 0;
    this.fragmented = false;
  }

  /** Called after retirement, when the allocator knows its remaining highest live row. */
  trim(liveEnd: number): void {
    if (this.empty && (this.levels[0]?.length ?? 0) * 32 > Math.max(1024, 4 * liveEnd))
      this.release();
  }

  /** Drop backing once its GPU table releases the corresponding address space. */
  release(): void {
    this.levels.length = 0;
    this.first = this.after = this.secondAfter = 0;
    this.fragmented = false;
  }
}
