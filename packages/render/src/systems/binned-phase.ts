/** Cumulative work evidence; tests and benches read deltas. */
export interface BinnedPhaseWork {
  /** Items placed into a bin. */
  enqueued: number;
  /** Items removed from a bin. */
  dequeued: number;
  /** Bins created or retired. */
  bins: number;
}

/** One queued item: `rank` orders it within its bin, `member` breaks equal ranks. */
export interface BinnedItem {
  readonly rank: number;
  readonly member: number;
}

/** Where one item of a member is queued: its bin key and the bin's (major, minor) order. */
export interface BinPlacement<T extends BinnedItem> {
  readonly key: number;
  readonly major: number;
  readonly minor: number;
  readonly item: T;
}

/** A retained bin: items ordered by (rank, member). */
export interface Bin<T extends BinnedItem> {
  readonly key: number;
  readonly major: number;
  readonly minor: number;
  readonly items: readonly T[];
  /** Ordinal in the current bin order; valid after {@link BinnedPhase.orderedBins}. */
  readonly ordinal: number;
}

interface MutableBin<T extends BinnedItem> {
  readonly key: number;
  readonly major: number;
  readonly minor: number;
  readonly items: T[];
  ordinal: number;
}

function compareItems(a: BinnedItem, b: BinnedItem): number {
  return a.rank - b.rank || a.member - b.member;
}

/**
 * A view-private retained binned phase (Bevy's `BinnedRenderPhase`): items
 * live in bins keyed by a numeric bin key and ordered by (major, minor), and
 * each member (an entity's draw) remembers its placements, so a member is
 * dequeued from its old bins before it is enqueued again — a bin-key change
 * is one dequeue and one enqueue. Consumers feed only entered, left and
 * changed members; an unchanged phase keeps its revision.
 */
export class BinnedPhase<T extends BinnedItem> {
  private readonly bins = new Map<number, MutableBin<T>>();
  /** Cached placements per member (Bevy's `cached_entity_bin_keys`). */
  private readonly placements = new Map<
    number,
    readonly { readonly bin: MutableBin<T>; readonly item: T }[]
  >();
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

  /** Replace a member's placements; the previous ones are dequeued first. */
  queue(member: number, placements: readonly BinPlacement<T>[]): void {
    this.dequeue(member);
    if (placements.length === 0) return;
    const placed: { readonly bin: MutableBin<T>; readonly item: T }[] = [];
    for (const placement of placements) {
      let bin = this.bins.get(placement.key);
      if (bin === undefined) {
        bin = {
          key: placement.key,
          major: placement.major,
          minor: placement.minor,
          items: [],
          ordinal: -1,
        };
        this.bins.set(placement.key, bin);
        this.orderValid = false;
        this.binRevision += 1;
        this.work.bins += 1;
      }
      bin.items.splice(lowerBound(bin.items, placement.item), 0, placement.item);
      placed.push({ bin, item: placement.item });
      this.work.enqueued += 1;
    }
    this.placements.set(member, placed);
    this.revision += 1;
  }

  /**
   * Replace the placements of many members at once: affected bins are
   * filtered and re-sorted once, so a bulk change costs O(n log n) instead of
   * one splice per item. Equivalent to calling {@link queue} for each entry.
   */
  queueMany(entries: readonly (readonly [number, readonly BinPlacement<T>[]])[]): void {
    if (entries.length === 0) return;
    const leaving = new Set<number>();
    const touched = new Set<MutableBin<T>>();
    for (const [member] of entries) {
      const placed = this.placements.get(member);
      if (placed === undefined) continue;
      leaving.add(member);
      this.placements.delete(member);
      for (const { bin } of placed) touched.add(bin);
      this.work.dequeued += placed.length;
    }
    for (const bin of touched) {
      const kept = bin.items.filter((item) => !leaving.has(item.member));
      bin.items.length = 0;
      for (const item of kept) bin.items.push(item);
    }
    for (const [member, placements] of entries) {
      if (placements.length === 0) continue;
      const placed: { readonly bin: MutableBin<T>; readonly item: T }[] = [];
      for (const placement of placements) {
        let bin = this.bins.get(placement.key);
        if (bin === undefined) {
          bin = {
            key: placement.key,
            major: placement.major,
            minor: placement.minor,
            items: [],
            ordinal: -1,
          };
          this.bins.set(placement.key, bin);
          this.orderValid = false;
          this.binRevision += 1;
          this.work.bins += 1;
        }
        bin.items.push(placement.item);
        touched.add(bin);
        placed.push({ bin, item: placement.item });
        this.work.enqueued += 1;
      }
      this.placements.set(member, placed);
    }
    for (const bin of touched) {
      if (bin.items.length > 0) {
        bin.items.sort(compareItems);
        continue;
      }
      if (this.bins.get(bin.key) !== bin) continue;
      this.bins.delete(bin.key);
      this.orderValid = false;
      this.binRevision += 1;
      this.work.bins += 1;
    }
    this.revision += 1;
  }

  /** Remove every placement of a member; false when it was not queued. */
  dequeue(member: number): boolean {
    const placed = this.placements.get(member);
    if (placed === undefined) return false;
    this.placements.delete(member);
    for (const { bin, item } of placed) {
      const items = bin.items;
      const at = lowerBound(items, item);
      if (items[at] !== item) throw new Error('BinnedPhase lost a placement');
      items.splice(at, 1);
      this.work.dequeued += 1;
      if (items.length === 0 && this.bins.get(bin.key) === bin) {
        this.bins.delete(bin.key);
        this.orderValid = false;
        this.binRevision += 1;
        this.work.bins += 1;
      }
    }
    this.revision += 1;
    return true;
  }

  /** Current ordinal of a live bin in (major, minor) order. */
  ordinalOf(key: number): number {
    this.orderedBins();
    return this.bins.get(key)?.ordinal ?? -1;
  }

  /** Bins in (major, minor) order; ordinals are assigned here. */
  orderedBins(): readonly Bin<T>[] {
    if (!this.orderValid) {
      this.ordered = [...this.bins.values()].sort((a, b) => a.major - b.major || a.minor - b.minor);
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
