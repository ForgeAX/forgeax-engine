/** Raw backing lifetime. Each instance owns an independent budget domain. */
export const EXTENT_PAGE_BYTES = 64 * 1024;
export const CELL_BYTES = [16, 64, 256] as const;
const LOCATION_ALIGNMENT = CELL_BYTES[0];
const LOCATION_STRIDE = EXTENT_PAGE_BYTES / LOCATION_ALIGNMENT;

/** Locations use the minimum cell alignment; offsets in component columns remain bytes. */
export function extentLocation(block: number, byteOffset = 0): number {
  return block * LOCATION_STRIDE + byteOffset / LOCATION_ALIGNMENT;
}
export function extentBlock(location: number): number {
  return Math.floor(location / LOCATION_STRIDE);
}
export function extentByteOffset(location: number): number {
  return (location % LOCATION_STRIDE) * LOCATION_ALIGNMENT;
}
const EMPTY = new ArrayBuffer(0);
interface Page {
  readonly kind: number;
  readonly free: number[];
  cursor: number;
  live: number;
  openIndex: number;
  readonly scanIndex: number;
}
export interface ExtentStoreStats {
  readonly blocks: number;
  readonly committedBytes: number;
  readonly idleBytes: number;
  readonly backingAllocations: number;
  readonly trimmedBytes: number;
}
function cellKind(bytes: number): number {
  for (let kind = 0; kind < CELL_BYTES.length; kind++)
    if (bytes <= (CELL_BYTES[kind] as number)) return kind;
  return -1;
}
export class ExtentStore {
  protected readonly buffers: ArrayBuffer[] = [EMPTY];
  private readonly pages: (Page | undefined)[] = [undefined];
  private readonly vacant: number[] = [];
  private readonly open: number[][] = CELL_BYTES.map(() => []);
  private readonly spare = new Map<number, number[]>();
  private committed = 0;
  private spareBytes = 0;
  private idlePageBytes = 0;
  private allocations = 0;
  private trimmed = 0;
  private scan = 0;
  private readonly slabs: (number | undefined)[] = [];
  private readonly vacantSlabs: number[] = [];
  /** Whether the last allocation reused bytes that its owner must initialize. */
  reused = false;

  /** Capacity is selected by the caller; only small cells are rounded here. */
  allocate(capacity: number): number {
    this.reused = false;
    if (capacity === 0) return 0;
    const kind = cellKind(capacity);
    if (kind < 0) {
      const reused = this.spare.get(capacity)?.pop();
      if (reused !== undefined) {
        this.spareBytes -= capacity;
        this.reused = true;
        return extentLocation(reused);
      }
      return extentLocation(this.newBlock(capacity));
    }
    const open = this.open[kind] as number[];
    let block = open.at(-1);
    if (block === undefined) {
      block = this.newBlock(EXTENT_PAGE_BYTES);
      const scanIndex = this.vacantSlabs.pop() ?? this.slabs.length;
      this.slabs[scanIndex] = block;
      this.pages[block] = { kind, free: [], cursor: 0, live: 0, openIndex: open.length, scanIndex };
      open.push(block);
    }
    const page = this.pages[block] as Page;
    if (page.live === 0 && page.cursor !== 0) this.idlePageBytes -= EXTENT_PAGE_BYTES;
    const cell = CELL_BYTES[kind] as number;
    const freed = page.free.pop();
    this.reused = freed !== undefined;
    const offset = freed ?? page.cursor;
    if (freed === undefined) page.cursor += cell;
    page.live++;
    if (page.free.length === 0 && page.cursor === EXTENT_PAGE_BYTES) this.closePage(page);
    return extentLocation(block, offset);
  }
  bufferAt(location: number): ArrayBuffer {
    return this.buffers[extentBlock(location)] as ArrayBuffer;
  }
  capacityAt(location: number): number {
    if (location === 0) return 0;
    const block = extentBlock(location);
    const page = this.pages[block];
    return page === undefined
      ? (this.buffers[block] as ArrayBuffer).byteLength
      : (CELL_BYTES[page.kind] as number);
  }
  additionalBytes(capacity: number): number {
    if (capacity === 0) return 0;
    const kind = cellKind(capacity);
    return kind >= 0
      ? (this.open[kind]?.length ?? 0) > 0
        ? 0
        : EXTENT_PAGE_BYTES
      : this.spare.get(capacity)?.length
        ? 0
        : capacity;
  }
  releaseLocation(location: number, cache = true): void {
    if (location === 0) return;
    const block = extentBlock(location);
    const page = this.pages[block];
    if (page === undefined) {
      if (!cache) {
        this.retire(block);
        return;
      }
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
    page.free.push(extentByteOffset(location));
    page.live--;
    if (page.openIndex < 0) {
      const open = this.open[page.kind] as number[];
      page.openIndex = open.length;
      open.push(block);
    }
    if (page.live === 0) this.idlePageBytes += EXTENT_PAGE_BYTES;
  }
  get idleDedicatedBytes(): number {
    return this.spareBytes;
  }
  get idleSlabBytes(): number {
    return this.idlePageBytes;
  }
  dedicatedCapacities(): Iterable<number> {
    return this.spare.keys();
  }
  trimDedicatedCapacity(capacity: number, retainBytes: number, maxBlocks = Infinity): number {
    const blocks = this.spare.get(capacity);
    let freed = 0;
    while (
      blocks !== undefined &&
      blocks.length > 0 &&
      this.spareBytes > retainBytes &&
      freed / capacity < maxBlocks
    ) {
      this.retire(blocks.pop() as number);
      this.spareBytes -= capacity;
      freed += capacity;
    }
    this.trimmed += freed;
    return freed;
  }
  /** Visit slab slots only, including their reusable holes; dedicated blocks do not consume visits. */
  trimPages(retainBytes: number, maxVisits = this.slabs.length): number {
    const visits = Math.min(maxVisits, this.slabs.length);
    if (this.idlePageBytes <= retainBytes && visits > 0) {
      // Carry the scan forward even when nothing can be reclaimed this pass.
      this.scan += Math.ceil(visits);
      return 0;
    }
    let freed = 0;
    for (let n = 0; n < visits; n++) {
      const block = this.slabs[this.scan++ % this.slabs.length];
      if (block === undefined) continue;
      const page = this.pages[block];
      if (page === undefined || page.live !== 0 || this.idlePageBytes <= retainBytes) continue;
      this.closePage(page);
      this.retire(block);
      this.idlePageBytes -= EXTENT_PAGE_BYTES;
      freed += EXTENT_PAGE_BYTES;
    }
    this.trimmed += freed;
    return freed;
  }
  get committedBytes(): number {
    return this.committed;
  }
  backingStats(): ExtentStoreStats {
    return {
      blocks: this.buffers.length - 1 - this.vacant.length,
      committedBytes: this.committed,
      idleBytes: this.spareBytes + this.idlePageBytes,
      backingAllocations: this.allocations,
      trimmedBytes: this.trimmed,
    };
  }
  protected newBlock(byteLength: number): number {
    const buffer = new ArrayBuffer(byteLength);
    const block = this.vacant.pop() ?? this.buffers.length;
    this.buffers[block] = buffer;
    this.pages[block] = undefined;
    this.committed += byteLength;
    this.allocations++;
    return block;
  }
  protected isSlab(block: number): boolean {
    return this.pages[block] !== undefined;
  }

  protected retire(block: number): void {
    this.committed -= (this.buffers[block] as ArrayBuffer).byteLength;
    this.buffers[block] = EMPTY;
    const page = this.pages[block];
    if (page !== undefined) {
      this.slabs[page.scanIndex] = undefined;
      this.vacantSlabs.push(page.scanIndex);
    }
    this.pages[block] = undefined;
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
