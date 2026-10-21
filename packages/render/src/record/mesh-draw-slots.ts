import type { RenderSceneRecord } from '../scene/render-scene-types';
import { StableRangeAllocator } from '../stable-range-allocator';

interface DrawRanges {
  readonly generation: number;
  source?: number;
  folded?: number;
  readonly native: Map<string, number>;
}

/** Physical draw addresses follow Scene lifetime, independently of any pass roster. */
export class MeshDrawSlots {
  private readonly allocator = new StableRangeAllocator();
  private readonly nativeRows = new Set<DrawRanges>();
  private readonly rows: (DrawRanges | undefined)[] = [];
  private readonly foldedDraws: Pick<RenderSceneRecord, 'slot' | 'generation'>[] = [];

  /** Retire the preceding submission's optional folded work before allocating sources. */
  beginFrame(draws?: Iterable<{ readonly record: RenderSceneRecord; readonly key: string }>): void {
    if (draws !== undefined) {
      const live = new Map<DrawRanges, Set<string>>();
      for (const { record, key } of draws) {
        const row = this.rows[record.slot];
        if (row?.generation !== record.generation) continue;
        let keys = live.get(row);
        if (keys === undefined) {
          keys = new Set();
          live.set(row, keys);
        }
        keys.add(key);
      }
      // Only prior actual draw addresses are visited, never cells in an asset or its consumers.
      for (const row of live.keys()) {
        if (row.source === undefined) continue;
        this.allocator.release(row.source, 1);
        delete row.source;
      }
      for (const row of this.nativeRows) {
        const keys = live.get(row);
        for (const [key, index] of row.native) {
          if (keys?.has(key)) continue;
          this.allocator.release(index, 1);
          row.native.delete(key);
        }
        if (row.native.size === 0) this.nativeRows.delete(row);
      }
    }
    for (const record of this.foldedDraws) {
      const row = this.rows[record.slot];
      if (row?.generation !== record.generation || row.folded === undefined) continue;
      this.allocator.release(row.folded, 1);
      delete row.folded;
    }
    this.foldedDraws.length = 0;
  }

  index(record: RenderSceneRecord, kind: 'source' | 'folded' | { readonly key: string }): number {
    let row = this.rows[record.slot];
    if (row !== undefined && row.generation !== record.generation)
      throw new Error('Scene must release the prior generation before allocating draw slots');
    if (row === undefined) {
      row = { generation: record.generation, native: new Map() };
      this.rows[record.slot] = row;
    }
    if (kind === 'source' || kind === 'folded') {
      if (row[kind] === undefined) {
        row[kind] = this.allocator.allocate(1);
        if (kind === 'folded')
          this.foldedDraws.push({ slot: record.slot, generation: record.generation });
      }
      return row[kind];
    }
    let index = row.native.get(kind.key);
    if (index === undefined) {
      index = this.allocator.allocate(1);
      row.native.set(kind.key, index);
      this.nativeRows.add(row);
    }
    return index;
  }

  release(record: RenderSceneRecord): void {
    const row = this.rows[record.slot];
    if (row === undefined || row.generation !== record.generation) return;
    if (row.source !== undefined) this.allocator.release(row.source, 1);
    if (row.folded !== undefined) this.allocator.release(row.folded, 1);
    for (const index of row.native.values()) this.allocator.release(index, 1);
    this.nativeRows.delete(row);
    this.rows[record.slot] = undefined;
  }

  get capacity(): number {
    return this.allocator.requiredCapacity();
  }
}
