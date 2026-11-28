/** Cumulative work evidence; tests and benches read deltas. */
export interface BinnedPhaseWork {
  /** Items placed into a bin. */
  enqueued: number;
  /** Items removed from a bin. */
  dequeued: number;
  /** Bins created or retired. */
  bins: number;
}

/** A queued item owns its bin and its position within that bin. */
export interface BinnedItem {
  readonly rank: number;
  readonly member: number;
  readonly bin: number;
  readonly binMajor: number;
}

/** A retained bin: items ordered by (rank, member). */
export interface Bin<T extends BinnedItem> {
  readonly key: number;
  readonly major: number;
  readonly items: readonly T[];
  /** Ordinal in the current bin order; valid after {@link BinnedPhase.orderedBins}. */
  readonly ordinal: number;
}

interface MutableBin<T extends BinnedItem> {
  readonly key: number;
  readonly major: number;
  readonly items: T[];
  ordinal: number;
}

function compareItems(a: BinnedItem, b: BinnedItem): number {
  return a.rank - b.rank || a.member - b.member;
}

/**
 * A view-private retained binned phase (Bevy's `BinnedRenderPhase`): items
 * live in bins keyed by a numeric bin key and ordered by (major, key), and
 * each member (an entity's draw) remembers its placements, so a member is
 * dequeued from its old bins before it is enqueued again — a bin-key change
 * is one dequeue and one enqueue. Consumers feed only entered, left and
 * changed members; an unchanged phase keeps its revision.
 */
export class BinnedPhase<T extends BinnedItem> {
  private readonly bins = new Map<number, MutableBin<T>>();
  /** The same placed items their member published, indexed for removal. */
  private readonly placements = new Map<number, readonly T[]>();
  private ordered: MutableBin<T>[] = [];
  private orderValid = true;
  /** Advances on every membership change. */
  revision = 0;
  /** Advances when a bin is created or retired, which moves later bin ordinals. */
  binRevision = 0;
  readonly work: BinnedPhaseWork = { enqueued: 0, dequeued: 0, bins: 0 };

  get size(): number {
    return this.placements.size;
  }

  has(member: number): boolean {
    return this.placements.has(member);
  }

  /** Replace a member's placements with its fixed item list. */
  queue(member: number, items: readonly T[]): void {
    this.dequeue(member);
    if (items.length === 0) return;
    for (const item of items) {
      const bin = this.binFor(item);
      bin.items.splice(lowerBound(bin.items, item), 0, item);
      this.work.enqueued += 1;
    }
    this.placements.set(member, items);
    this.revision += 1;
  }

  /**
   * Replace placements for distinct members in bulk. Each affected bin is
   * compacted and re-sorted once, with no secondary item list.
   */
  queueMany(entries: readonly (readonly [number, readonly T[]])[]): void {
    if (entries.length === 0) return;
    const leaving = new Set<number>();
    const touched = new Set<MutableBin<T>>();
    for (const [member] of entries) {
      const placed = this.placements.get(member);
      if (placed === undefined) continue;
      leaving.add(member);
      this.placements.delete(member);
      for (const item of placed) touched.add(this.bins.get(item.bin) as MutableBin<T>);
      this.work.dequeued += placed.length;
    }
    for (const { items } of touched) {
      let kept = 0;
      for (const item of items) if (!leaving.has(item.member)) items[kept++] = item;
      items.length = kept;
    }
    for (const [member, items] of entries) {
      if (items.length === 0) continue;
      for (const item of items) {
        const bin = this.binFor(item);
        bin.items.push(item);
        touched.add(bin);
        this.work.enqueued += 1;
      }
      this.placements.set(member, items);
    }
    for (const bin of touched) {
      if (bin.items.length > 0) bin.items.sort(compareItems);
      else this.retireBin(bin);
    }
    this.revision += 1;
  }

  /** Remove every placement of a member; false when it was not queued. */
  dequeue(member: number): boolean {
    const placed = this.placements.get(member);
    if (placed === undefined) return false;
    this.placements.delete(member);
    for (const item of placed) {
      const bin = this.bins.get(item.bin) as MutableBin<T>;
      const items = bin.items;
      let at = lowerBound(items, item);
      // Several sections of one member may share the same Pass and rank.
      while (items[at] !== item) {
        const tied = items[at];
        if (tied === undefined || compareItems(tied, item) !== 0) break;
        at++;
      }
      if (items[at] !== item) throw new Error('BinnedPhase lost a placement');
      items.splice(at, 1);
      this.work.dequeued += 1;
      if (items.length === 0) this.retireBin(bin);
    }
    this.revision += 1;
    return true;
  }

  private binFor(item: T): MutableBin<T> {
    let bin = this.bins.get(item.bin);
    if (bin === undefined) {
      bin = {
        key: item.bin,
        major: item.binMajor,
        items: [],
        ordinal: -1,
      };
      this.bins.set(bin.key, bin);
      this.orderValid = false;
      this.binRevision += 1;
      this.work.bins += 1;
    }
    return bin;
  }

  private retireBin(bin: MutableBin<T>): void {
    this.bins.delete(bin.key);
    this.orderValid = false;
    this.binRevision += 1;
    this.work.bins += 1;
  }

  /** Current ordinal of a live bin in (major, key) order. */
  ordinalOf(key: number): number {
    this.orderedBins();
    return this.bins.get(key)?.ordinal ?? -1;
  }

  /** Bins in (major, key) order; ordinals are assigned here. */
  orderedBins(): readonly Bin<T>[] {
    if (!this.orderValid) {
      this.ordered = [...this.bins.values()].sort((a, b) => a.major - b.major || a.key - b.key);
      for (let index = 0; index < this.ordered.length; index++)
        (this.ordered[index] as MutableBin<T>).ordinal = index;
      this.orderValid = true;
    }
    return this.ordered;
  }

  clear(): void {
    if (this.placements.size === 0) return;
    this.work.dequeued += this.placements.size;
    this.work.bins += this.bins.size;
    this.bins.clear();
    this.placements.clear();
    this.ordered = [];
    this.orderValid = true;
    this.revision += 1;
    this.binRevision += 1;
  }
}

function lowerBound<T extends BinnedItem>(items: readonly T[], item: T): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareItems(items[middle] as T, item) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}
