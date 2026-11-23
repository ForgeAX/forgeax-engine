import { dynamicCapacity, shouldShrinkCapacity } from '../dynamic-capacity';

/** Transaction-local lookup into the borrowed wire column. The receiver retains only numeric scratch. */
export class PublicationTransformRows {
  private scratch: Uint32Array | undefined;
  private mode: 'ordered' | 'dense' | 'permutation' = 'ordered';
  private minimum = 0;
  private underusedPackets = 0;
  private buckets: Uint32Array | undefined;

  validate(entities: Uint32Array, needsLookup: boolean): boolean {
    const n = entities.length;
    let min = entities[0] ?? 0;
    let max = min;
    let ordered = true;
    for (let i = 1; i < n; i++) {
      const id = entities[i] as number;
      if (id === entities[i - 1]) return false;
      if (id < max) ordered = false;
      if (id < min) min = id;
      if (id > max) max = id;
    }
    this.minimum = min;
    const span = max - min + 1;
    const dense = !ordered && span <= 2 * n;
    const count = ordered ? 0 : dense ? span : needsLookup ? 2 * n : n;
    // Mixed ordered/unordered frames can alternate. Retire burst storage after
    // sustained low demand without allocating it again every other publication.
    if (this.scratch && shouldShrinkCapacity(count, this.scratch.length)) {
      if (++this.underusedPackets >= 16) this.scratch = undefined;
    } else this.underusedPackets = 0;
    if (ordered) {
      this.mode = 'ordered';
      return true;
    }
    if (!this.scratch || this.scratch.length < count)
      this.scratch = new Uint32Array(dynamicCapacity(count));
    const scratch = this.scratch;
    if (dense) {
      this.mode = 'dense';
      scratch.fill(0, 0, span);
      for (let i = 0; i < n; i++) {
        const slot = (entities[i] as number) - min;
        if (scratch[slot] !== 0) return false;
        scratch[slot] = i + 1;
      }
      return true;
    }
    // Wide, unordered pose-only packets need uniqueness only. Native numeric sort
    // validates them without manufacturing a row permutation or touching wire order.
    this.mode = 'permutation';
    if (!needsLookup) {
      const used = scratch.subarray(0, n);
      used.set(entities);
      used.sort();
      for (let i = 1; i < n; i++) if (used[i] === used[i - 1]) return false;
    } else {
      this.sortWireRows(entities, scratch);
      for (let i = 1; i < n; i++)
        if (entities[scratch[i] as number] === entities[scratch[i - 1] as number]) return false;
    }
    return true;
  }

  private sortWireRows(entities: Uint32Array, rows: Uint32Array): void {
    const n = entities.length;
    for (let i = 0; i < n; i++) rows[i] = i;
    if (n <= 32) {
      for (let i = 1; i < n; i++) {
        const key = entities[i] as number;
        let j = i;
        while (j > 0 && (entities[rows[j - 1] as number] as number) > key) {
          rows[j] = rows[j - 1] as number;
          j--;
        }
        rows[j] = i;
      }
      return;
    }
    this.buckets ??= new Uint32Array(256);
    const buckets = this.buckets;
    let source = 0;
    for (let shift = 0; shift < 32; shift += 8) {
      const target = n - source;
      buckets.fill(0);
      for (let i = 0; i < n; i++) {
        const digit = ((entities[rows[source + i] as number] as number) >>> shift) & 255;
        buckets[digit] = (buckets[digit] as number) + 1;
      }
      let prefix = 0;
      for (let i = 0; i < buckets.length; i++) {
        const count = buckets[i] as number;
        buckets[i] = prefix;
        prefix += count;
      }
      for (let i = 0; i < n; i++) {
        const row = rows[source + i] as number;
        const digit = ((entities[row] as number) >>> shift) & 255;
        const offset = buckets[digit] as number;
        rows[target + offset] = row;
        buckets[digit] = offset + 1;
      }
      source = target;
    }
  }

  /** Called only for a packet with upserts after successful validation. */
  find(entities: Uint32Array, entity: number): number | undefined {
    const relative = entity - this.minimum;
    if (this.mode === 'dense') {
      if (relative < 0 || relative >= 2 * entities.length) return undefined;
      const row = (this.scratch?.[relative] ?? 0) - 1;
      return entities[row] === entity ? row : undefined;
    }
    if (this.mode === 'ordered' && entities[relative] === entity) return relative;
    const permutation = this.mode === 'permutation' ? this.scratch : undefined;
    let lo = 0;
    let hi = entities.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const row = permutation?.[mid] ?? mid;
      const id = entities[row] as number;
      if (id === entity) return row;
      if (id < entity) lo = mid + 1;
      else hi = mid;
    }
    return undefined;
  }

  dispose(): void {
    this.scratch = undefined;
    this.buckets = undefined;
  }
}
