// World-owned backing for variable `array<T>` fields.
//
// A field's column carries its whole location: `[block, byteOffset, count]`
// (arity 3, u32). `count` is elements, including bytes for `array<u8>`.
// Reading an element is `store.view(block, Ctor)[byteOffset / size + i]`; no
// slot table, borrowed window or copy sits between the column and the bytes.
// Small arrays share 64 KiB pages split into 16/64/256-byte cells; larger ones
// own a dedicated block. Block 0 is the empty array. Cells are not zeroed:
// readers only see `count` elements, and every writer writes before counting.
import type { FieldView } from './column';

import {
  EXTENT_PAGE_BYTES,
  ExtentStore,
  type ExtentStoreStats,
  extentBlock,
  extentByteOffset,
  extentLocation,
} from './extent-store';

export const ARRAY_FIELD_ARITY = 3;
export const ARRAY_PAGE_BYTES = EXTENT_PAGE_BYTES;
const EMPTY = new ArrayBuffer(0);
type ViewCtor = new (buffer: ArrayBuffer, byteOffset?: number, length?: number) => FieldView;
export interface ArrayStoreStats extends ExtentStoreStats {
  readonly liveArrays: number;
  readonly copiedBytes: number;
}
function dedicatedBytes(bytes: number): number {
  let capacity = 1024;
  while (capacity < bytes) capacity *= 2;
  return capacity;
}
/** Component columns retain direct block/offset access; raw backing owns no typed views. */
export class ArrayStore extends ExtentStore {
  private readonly u32Views: Uint32Array[] = [new Uint32Array(EMPTY)];
  private readonly typedViews: (Map<ViewCtor, FieldView> | FieldView | undefined)[] = [undefined];
  private live = 0;
  private copied = 0;
  /** Whole-block u32 view; element `i` of a row is `[byteOffset / 4 + i]`. */
  u32(block: number): Uint32Array {
    return this.u32Views[block] as Uint32Array;
  }

  /** Whole-block view for one element constructor. */
  view(block: number, Ctor: ViewCtor): FieldView {
    if (Ctor === Uint32Array) return this.u32Views[block] as Uint32Array;
    const cached = this.typedViews[block];
    if (cached instanceof Map) {
      let view = cached.get(Ctor);
      if (view === undefined) {
        view = new Ctor(this.buffer(block));
        cached.set(Ctor, view);
      }
      return view;
    }
    if (cached instanceof Ctor) return cached;
    const view = new Ctor(this.buffer(block));
    // A slab can contain fields with different codecs at the same time.
    // A dedicated block has one cell. Reuse can replace its one cached codec.
    this.typedViews[block] = this.isSlab(block) ? new Map([[Ctor, view]]) : view;
    return view;
  }

  buffer(block: number): ArrayBuffer {
    return this.buffers[block] as ArrayBuffer;
  }

  capacity(block: number): number {
    return this.capacityAt(extentLocation(block));
  }
  alloc(column: Uint32Array, base: number, byteLength: number): boolean {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return false;
    try {
      const location = this.allocate(byteLength <= 256 ? byteLength : dedicatedBytes(byteLength));
      column[base] = extentBlock(location);
      column[base + 1] = extentByteOffset(location);
      if (byteLength !== 0) this.live++;
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Make the location at `column[base]` hold at least `byteLength` bytes,
   * keeping its first `liveBytes`. Moves to a larger cell or block only when
   * the current one is too small.
   */
  reserve(column: Uint32Array, base: number, liveBytes: number, byteLength: number): boolean {
    const block = column[base] as number;
    const offset = column[base + 1] as number;
    if (byteLength <= this.capacity(block)) return true;
    if (!this.alloc(column, base, byteLength)) return false;
    if (liveBytes > 0) {
      new Uint8Array(this.buffers[column[base] as number] as ArrayBuffer).set(
        new Uint8Array(this.buffers[block] as ArrayBuffer, offset, liveBytes),
        column[base + 1] as number,
      );
      this.copied += liveBytes;
    }
    this.release(block, offset);
    return true;
  }

  release(block: number, byteOffset: number): void {
    if (block === 0) return;
    this.live--;
    this.releaseLocation(extentLocation(block, byteOffset));
  }
  trim(retainBytes = 0): number {
    let freed = 0;
    for (const capacity of this.dedicatedCapacities())
      freed += this.trimDedicatedCapacity(capacity, Math.max(0, retainBytes - this.idleSlabBytes));
    return freed + this.trimPages(Math.max(0, retainBytes - this.idleDedicatedBytes));
  }
  stats(): ArrayStoreStats {
    return { ...this.backingStats(), liveArrays: this.live, copiedBytes: this.copied };
  }
  protected override newBlock(byteLength: number): number {
    const block = super.newBlock(byteLength);
    try {
      this.u32Views[block] = new Uint32Array(this.buffers[block] as ArrayBuffer);
      this.typedViews[block] = undefined;
      return block;
    } catch (cause) {
      super.retire(block);
      throw cause;
    }
  }
  protected override retire(block: number): void {
    super.retire(block);
    this.u32Views[block] = this.u32Views[0] as Uint32Array;
    this.typedViews[block] = undefined;
  }
}
