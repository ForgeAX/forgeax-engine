// World-owned backing for variable `array<T>` and `buffer` fields.
//
// A field's column carries its whole location: `[block, byteOffset, count]`
// (arity 3, u32). `count` is elements for arrays and bytes for `buffer`.
// Reading an element is `store.view(block, Ctor)[byteOffset / size + i]`; no
// slot table, borrowed window or copy sits between the column and the bytes.
// Small arrays share 64 KiB pages split into 16/64/256-byte cells; larger ones
// own a dedicated block. Block 0 is the empty array. Cells are not zeroed:
// readers only see `count` elements, and every writer writes before counting.
import type { FieldView } from './column';

export const ARRAY_FIELD_ARITY = 3;
export const ARRAY_PAGE_BYTES = 64 * 1024;
const CELL_BYTES: readonly number[] = [16, 64, 256];
const MIN_DEDICATED_BYTES = 1024;
const EMPTY = new ArrayBuffer(0);

type ViewCtor = new (buffer: ArrayBuffer, byteOffset?: number, length?: number) => FieldView;

interface Page {
  readonly kind: number;
  readonly free: number[];
  cursor: number;
  live: number;
  /** Index in `open[kind]`, or -1 when the page has no free cell. */
  openIndex: number;
}

export interface ArrayStoreStats {
  readonly blocks: number;
  /** Stored non-empty arrays. */
  readonly liveArrays: number;
  readonly committedBytes: number;
  readonly idleBytes: number;
  readonly backingAllocations: number;
  readonly copiedBytes: number;
  readonly trimmedBytes: number;
}

function cellKind(bytes: number): number {
  for (let kind = 0; kind < CELL_BYTES.length; kind++)
    if (bytes <= (CELL_BYTES[kind] as number)) return kind;
  return -1;
}

function dedicatedBytes(bytes: number): number {
  let capacity = MIN_DEDICATED_BYTES;
  while (capacity < bytes) capacity *= 2;
  return capacity;
}

export class ArrayStore {
  private readonly buffers: ArrayBuffer[] = [EMPTY];
  private readonly pages: (Page | undefined)[] = [undefined];
  private readonly u32Views: Uint32Array[] = [new Uint32Array(EMPTY)];
  private readonly typedViews: (Map<ViewCtor, FieldView> | undefined)[] = [undefined];
  private readonly vacant: number[] = [];
  private readonly open: number[][] = CELL_BYTES.map(() => []);
  /** Released dedicated blocks by capacity; their buffers are reused before trim. */
  private readonly spare = new Map<number, number[]>();
  private committed = 0;
  private live = 0;
  private spareBytes = 0;
  private idlePageBytes = 0;
  private allocations = 0;
  private copied = 0;
  private trimmed = 0;

  /** Whole-block u32 view; element `i` of a row is `[byteOffset / 4 + i]`. */
  u32(block: number): Uint32Array {
    return this.u32Views[block] as Uint32Array;
  }

  /** Whole-block view for one element constructor. */
  view(block: number, Ctor: ViewCtor): FieldView {
    if (Ctor === Uint32Array) return this.u32Views[block] as Uint32Array;
    let views = this.typedViews[block];
    if (views === undefined) {
      views = new Map();
      this.typedViews[block] = views;
    }
    let view = views.get(Ctor);
    if (view === undefined) {
      view = new Ctor(this.buffers[block] as ArrayBuffer);
      views.set(Ctor, view);
    }
    return view;
  }

  /** Bytes of one stored array (a fresh window; the caller must not retain it). */
  bytes(block: number, byteOffset: number, byteLength: number): Uint8Array {
    return new Uint8Array(this.buffers[block] as ArrayBuffer, byteOffset, byteLength);
  }

  buffer(block: number): ArrayBuffer {
    return this.buffers[block] as ArrayBuffer;
  }

  capacity(block: number): number {
    if (block === 0) return 0;
    const page = this.pages[block];
    return page === undefined
      ? (this.buffers[block] as ArrayBuffer).byteLength
      : (CELL_BYTES[page.kind] as number);
  }

  /**
   * Place `byteLength` bytes and write `[block, byteOffset]` at
   * `column[base]`. Returns false when backing cannot be allocated.
   */
  alloc(column: Uint32Array, base: number, byteLength: number): boolean {
    if (byteLength === 0) {
      column[base] = 0;
      column[base + 1] = 0;
      return true;
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return false;
    const kind = cellKind(byteLength);
    try {
      if (kind >= 0) this.allocCell(kind, column, base);
      else {
        column[base] = this.allocDedicated(dedicatedBytes(byteLength));
        column[base + 1] = 0;
      }
      this.live++;
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
    const page = this.pages[block];
    if (page === undefined) {
      const capacity = (this.buffers[block] as ArrayBuffer).byteLength;
      let blocks = this.spare.get(capacity);
      if (blocks === undefined) {
        blocks = [];
        this.spare.set(capacity, blocks);
      }
      blocks.push(block);
      this.spareBytes += capacity;
      return;
    }
    page.free.push(byteOffset);
    page.live--;
    if (page.openIndex < 0) {
      const open = this.open[page.kind] as number[];
      page.openIndex = open.length;
      open.push(block);
    }
    if (page.live === 0) this.idlePageBytes += ARRAY_PAGE_BYTES;
  }

  /** Drop idle pages and spare dedicated blocks; live cells never move. */
  trim(retainBytes = 0): number {
    let freed = 0;
    for (const [capacity, blocks] of this.spare) {
      while (blocks.length > 0 && this.spareBytes + this.idlePageBytes > retainBytes) {
        this.retire(blocks.pop() as number);
        this.spareBytes -= capacity;
        freed += capacity;
      }
    }
    for (let block = 1; block < this.pages.length; block++) {
      if (this.spareBytes + this.idlePageBytes <= retainBytes) break;
      const page = this.pages[block];
      if (page === undefined || page.live !== 0 || page.cursor === 0) continue;
      this.closePage(page);
      this.retire(block);
      this.idlePageBytes -= ARRAY_PAGE_BYTES;
      freed += ARRAY_PAGE_BYTES;
    }
    this.trimmed += freed;
    return freed;
  }

  get committedBytes(): number {
    return this.committed;
  }

  stats(): ArrayStoreStats {
    return {
      blocks: this.buffers.length - 1 - this.vacant.length,
      liveArrays: this.live,
      committedBytes: this.committed,
      idleBytes: this.spareBytes + this.idlePageBytes,
      backingAllocations: this.allocations,
      copiedBytes: this.copied,
      trimmedBytes: this.trimmed,
    };
  }

  private allocCell(kind: number, column: Uint32Array, base: number): void {
    const open = this.open[kind] as number[];
    let block = open.at(-1);
    if (block === undefined) {
      block = this.newBlock(ARRAY_PAGE_BYTES);
      this.pages[block] = { kind, free: [], cursor: 0, live: 0, openIndex: open.length };
      open.push(block);
    }
    const page = this.pages[block] as Page;
    if (page.live === 0 && page.cursor !== 0) this.idlePageBytes -= ARRAY_PAGE_BYTES;
    const cell = CELL_BYTES[kind] as number;
    let offset = page.free.pop();
    if (offset === undefined) {
      offset = page.cursor;
      page.cursor += cell;
    }
    page.live++;
    if (page.free.length === 0 && page.cursor === ARRAY_PAGE_BYTES) this.closePage(page);
    column[base] = block;
    column[base + 1] = offset;
  }

  private allocDedicated(capacity: number): number {
    const reused = this.spare.get(capacity)?.pop();
    if (reused !== undefined) {
      this.spareBytes -= capacity;
      return reused;
    }
    return this.newBlock(capacity);
  }

  private newBlock(byteLength: number): number {
    const buffer = new ArrayBuffer(byteLength);
    const block = this.vacant.pop() ?? this.buffers.length;
    this.buffers[block] = buffer;
    this.pages[block] = undefined;
    this.u32Views[block] = new Uint32Array(buffer);
    this.typedViews[block] = undefined;
    this.committed += byteLength;
    this.allocations++;
    return block;
  }

  private retire(block: number): void {
    this.committed -= (this.buffers[block] as ArrayBuffer).byteLength;
    this.buffers[block] = EMPTY;
    this.pages[block] = undefined;
    this.u32Views[block] = this.u32Views[0] as Uint32Array;
    this.typedViews[block] = undefined;
    this.vacant.push(block);
  }

  private closePage(page: Page): void {
    if (page.openIndex < 0) return;
    const open = this.open[page.kind] as number[];
    const last = open.pop() as number;
    if (page.openIndex < open.length) {
      open[page.openIndex] = last;
      (this.pages[last] as Page).openIndex = page.openIndex;
    }
    page.openIndex = -1;
  }
}
