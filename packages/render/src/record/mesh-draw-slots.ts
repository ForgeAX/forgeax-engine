import type { RenderSceneRecord } from '../scene/render-scene-types';
import { StableRangeAllocator } from '../stable-range-allocator';
import { NativeDrawRoster } from './native-draw-roster';

interface DrawRanges {
  readonly generation: number;
  source?: number;
  folded?: number;
  liveEpoch: number;
  sourceQueued?: boolean;
  readonly native: Map<string, number>;
}

/** Physical draw addresses follow Scene lifetime, independently of any pass roster. */
export class MeshDrawSlots {
  private allocator = new StableRangeAllocator();
  private readonly nativeRows = new Set<DrawRanges>();
  private readonly rows: (DrawRanges | undefined)[] = [];
  private readonly foldedDraws: Pick<RenderSceneRecord, 'slot' | 'generation'>[] = [];
  /** Scratch capacity is retained; no row reference survives a frame or failed traversal. */
  private readonly liveRows: (DrawRanges | undefined)[] = [];
  /** Liveness is derived from the canonical physical slot, without a per-key wrapper. */
  private readonly nativeEpochs: (number | undefined)[] = [];
  private epoch = 0;
  private owned: NativeDrawRoster | undefined;
  private readonly sourceRetirements: DrawRanges[] = [];
  private readonly unlisted: { record: RenderSceneRecord; key: string }[] = [];
  /** Work of address maintenance, excluding output consumption and real retirement. */
  readonly work = { enumerated: 0, changed: 0, cold: 0 };

  /** Retire the preceding submission's optional folded work before allocating sources. */
  beginFrame(draws?: Iterable<{ readonly record: RenderSceneRecord; readonly key: string }>): void {
    if (NativeDrawRoster.is(draws)) {
      const previous = this.owned;
      if (previous === undefined) {
        this.work.cold++;
        this.reconcileNativeDraws(draws);
      } else
        draws.changesSince(previous, (change) => {
          this.work.changed++;
          const row = this.rows[change.record.slot];
          if (row?.generation !== change.record.generation) return;
          if (change.present) this.retireSource(row);
          else {
            const address = row.native.get(change.key);
            if (address === undefined) return;
            this.allocator.release(address, 1);
            this.nativeEpochs[address] = undefined;
            row.native.delete(change.key);
            if (row.native.size === 0) this.nativeRows.delete(row);
          }
        });
      this.owned = draws;
    } else if (draws !== undefined) {
      this.owned = undefined;
      this.reconcileNativeDraws(draws);
    }
    if (NativeDrawRoster.is(draws)) {
      for (const entry of this.unlisted) {
        const row = this.rows[entry.record.slot];
        if (row?.generation !== entry.record.generation || this.owned?.has(entry) === true)
          continue;
        const address = row.native.get(entry.key);
        if (address === undefined) continue;
        this.allocator.release(address, 1);
        this.nativeEpochs[address] = undefined;
        row.native.delete(entry.key);
        if (row.native.size === 0) this.nativeRows.delete(row);
      }
    }
    if (draws !== undefined) this.unlisted.length = 0;
    for (const row of this.sourceRetirements) this.retireSource(row);
    this.sourceRetirements.length = 0;
    for (const record of this.foldedDraws) {
      const row = this.rows[record.slot];
      if (row?.generation !== record.generation || row.folded === undefined) continue;
      this.allocator.release(row.folded, 1);
      delete row.folded;
    }
    this.foldedDraws.length = 0;
  }

  /** Mark existing addresses in place; a steady roster creates no membership Map or Set. */
  private reconcileNativeDraws(
    draws: Iterable<{ readonly record: RenderSceneRecord; readonly key: string }>,
  ): void {
    const epoch = ++this.epoch;
    let liveCount = 0;
    try {
      for (const { record, key } of draws) {
        this.work.enumerated++;
        const row = this.rows[record.slot];
        if (row?.generation !== record.generation) continue;
        if (row.liveEpoch !== epoch) {
          row.liveEpoch = epoch;
          this.liveRows[liveCount++] = row;
        }
        const native = row.native.get(key);
        if (native !== undefined) this.nativeEpochs[native] = epoch;
      }
      // Preserve first-seen source retirement order, after traversal has completed.
      for (let index = 0; index < liveCount; index++) {
        const row = this.liveRows[index];
        if (row !== undefined) this.retireSource(row);
      }
      for (const row of this.nativeRows) {
        // One stable callback avoids allocating a Map iterator/entry pair per row.
        row.native.forEach(this.retireNativeRange, this);
        if (row.native.size === 0) this.nativeRows.delete(row);
      }
    } finally {
      for (let index = 0; index < liveCount; index++) this.liveRows[index] = undefined;
    }
  }

  private queueSource(row: DrawRanges): void {
    if (row.sourceQueued || row.source === undefined) return;
    row.sourceQueued = true;
    this.sourceRetirements.push(row);
  }

  private retireSource(row: DrawRanges): void {
    row.sourceQueued = false;
    if (row.source === undefined) return;
    this.allocator.release(row.source, 1);
    delete row.source;
  }

  private retireNativeRange(index: number, key: string, native: Map<string, number>): void {
    if (this.nativeEpochs[index] === this.epoch) return;
    this.allocator.release(index, 1);
    this.nativeEpochs[index] = undefined;
    native.delete(key);
  }

  index(record: RenderSceneRecord, kind: 'source' | 'folded' | { readonly key: string }): number {
    let row = this.rows[record.slot];
    if (row !== undefined && row.generation !== record.generation)
      throw new Error('Scene must release the prior generation before allocating draw slots');
    if (row === undefined) {
      row = { generation: record.generation, liveEpoch: 0, native: new Map() };
      this.rows[record.slot] = row;
    }
    if (kind === 'source' || kind === 'folded') {
      if (row[kind] === undefined) {
        row[kind] = this.allocator.allocate(1);
        if (kind === 'source' && this.owned !== undefined && row.native.size > 0)
          this.queueSource(row);
        if (kind === 'folded')
          this.foldedDraws.push({ slot: record.slot, generation: record.generation });
      }
      return row[kind];
    }
    let index = row.native.get(kind.key);
    if (index === undefined) {
      index = this.allocator.allocate(1);
      this.nativeEpochs[index] = this.epoch;
      row.native.set(kind.key, index);
      this.nativeRows.add(row);
      if (this.owned !== undefined) {
        const entry = { record, key: kind.key };
        if (!this.owned.has(entry)) this.unlisted.push(entry);
        this.queueSource(row);
      }
    }
    return index;
  }

  release(record: RenderSceneRecord): void {
    const row = this.rows[record.slot];
    if (row === undefined || row.generation !== record.generation) return;
    this.retireSource(row);
    if (row.folded !== undefined) this.allocator.release(row.folded, 1);
    for (const index of row.native.values()) {
      this.allocator.release(index, 1);
      this.nativeEpochs[index] = undefined;
    }
    this.nativeRows.delete(row);
    this.rows[record.slot] = undefined;
  }

  clear(): void {
    this.allocator = new StableRangeAllocator();
    this.nativeRows.clear();
    this.rows.length = 0;
    this.foldedDraws.length = 0;
    this.liveRows.length = 0;
    this.nativeEpochs.length = 0;
    this.sourceRetirements.length = 0;
    this.unlisted.length = 0;
    this.owned = undefined;
  }

  /** A reused Scene address drops the draw addresses of its prior generation. */
  releaseStale(record: RenderSceneRecord): void {
    const row = this.rows[record.slot];
    if (row === undefined || row.generation === record.generation) return;
    this.release({ ...record, generation: row.generation });
  }

  get capacity(): number {
    return this.allocator.requiredCapacity();
  }
}
