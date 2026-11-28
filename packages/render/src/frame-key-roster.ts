const EMPTY_BUCKETS = new Uint32Array(0);

/** Ordered borrowed entries. Clearing a transaction releases its references and keeps its capacity. */
export class FrameKeyRoster<Key, Version> {
  private buckets = EMPTY_BUCKETS;
  private readonly usedBuckets: number[] = [];
  private readonly keys: (Key | undefined)[] = [];
  private readonly versions: (Version | undefined)[] = [];
  private count = 0;
  private growths = 0;

  constructor(private readonly address: (key: Key) => number) {}

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.buckets.length >>> 1;
  }

  get bucketGrowths(): number {
    return this.growths;
  }

  reset(): void {
    this.buckets = EMPTY_BUCKETS;
    this.count = 0;
    this.usedBuckets.length = 0;
    this.keys.length = 0;
    this.versions.length = 0;
  }

  keyAt(row: number): Key {
    return this.keys[row] as Key;
  }

  versionAt(row: number): Version {
    return this.versions[row] as Version;
  }

  get(key: Key): Version | undefined {
    if (this.count === 0) return undefined;
    const row = this.buckets[this.bucket(key)] as number;
    return row === 0 ? undefined : this.versionAt(row - 1);
  }

  /** Replace the value at an existing address without changing its admission order. */
  replace(key: Key, version: Version): boolean {
    if (this.count === 0) return false;
    const row = this.buckets[this.bucket(key)] as number;
    if (row === 0) return false;
    this.versions[row - 1] = version;
    return true;
  }

  /** The caller already proved this key has no version in the frame. */
  add(key: Key, version: Version): void {
    this.reserve(this.count + 1);
    this.index(this.count, key);
    this.keys[this.count] = key;
    this.versions[this.count++] = version;
  }

  copy(source: FrameKeyRoster<Key, Version>): void {
    this.reserve(source.size);
    for (let row = 0; row < source.size; row++) this.add(source.keyAt(row), source.versionAt(row));
  }

  clear(): void {
    // Retire only entries of this frame, even when the private capacity is larger.
    for (let row = 0; row < this.count; row++) {
      this.buckets[this.usedBuckets[row] as number] = 0;
      this.keys[row] = undefined;
      this.versions[row] = undefined;
    }
    this.count = 0;
  }

  private reserve(count: number): void {
    if (count <= this.capacity) return;
    let capacity = Math.max(8, this.capacity);
    while (capacity < count) capacity *= 2;
    this.buckets = new Uint32Array(capacity * 2);
    this.growths++;
    for (let row = 0; row < this.count; row++) this.index(row, this.keyAt(row));
  }

  private index(row: number, key: Key): void {
    const bucket = this.bucket(key);
    this.buckets[bucket] = row + 1;
    this.usedBuckets[row] = bucket;
  }

  private bucket(key: Key): number {
    const raw = this.address(key);
    const address = (raw | 0) ^ (raw / 0x100000000);
    const mask = this.buckets.length - 1;
    let bucket = Math.imul(address ^ (address >>> 16), 0x9e3779b1) & mask;
    for (;;) {
      const row = this.buckets[bucket] as number;
      if (row === 0) return bucket;
      const existing = this.keyAt(row - 1);
      if (existing === key || Object.is(existing, key)) return bucket;
      bucket = (bucket + 1) & mask;
    }
  }
}
