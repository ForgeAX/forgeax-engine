/** Fixed slab pages. Slot identity is independent from a cell's location. */
interface Page {
  readonly cellBytes: number;
  readonly kind: number;
  readonly free: number[];
  cursor: number;
  live: number;
  availableIndex: number;
}
export const BUFFER_PAGE_BYTES = 64 * 1024;
export class BufferPages {
  private readonly pages: (Page | undefined)[] = [];
  private readonly buffers: (ArrayBuffer | undefined)[] = [];
  private readonly vacant: number[] = [];
  private readonly available: number[][] = [[], [], []];
  private scan = 0;
  bytes = 0;
  allocations = 0;
  needsClear = false;
  trimmedBytes = 0;
  private idle = 0;

  requiredBytes(kind: number): number {
    return this.available[kind]?.length ? 0 : BUFFER_PAGE_BYTES;
  }

  alloc(kind: number): number {
    const available = this.available[kind] as number[];
    let index = available.at(-1);
    if (index === undefined) {
      const buffer = new ArrayBuffer(BUFFER_PAGE_BYTES);
      index = this.vacant.pop() ?? this.pages.length;
      this.buffers[index] = buffer;
      this.pages[index] = {
        kind,
        cellBytes: 16 * 4 ** kind,
        free: [],
        cursor: 0,
        live: 0,
        availableIndex: available.length,
      };
      available.push(index);
      this.bytes += BUFFER_PAGE_BYTES;
      this.allocations++;
    }
    const page = this.pages[index] as Page;
    const wasIdle = page.live === 0 && page.cursor !== 0;
    const freed = page.free.pop();
    this.needsClear = freed !== undefined;
    const offset = freed ?? page.cursor;
    if (offset === page.cursor) page.cursor += page.cellBytes;
    if (wasIdle) this.idle -= BUFFER_PAGE_BYTES;
    page.live++;
    if (page.free.length === 0 && page.cursor === BUFFER_PAGE_BYTES) this.removeAvailable(page);
    return index * BUFFER_PAGE_BYTES + offset;
  }

  pageBuffer(index: number): ArrayBuffer {
    return this.buffers[index] as ArrayBuffer;
  }
  buffer(location: number): ArrayBuffer {
    return this.buffers[Math.floor(location / BUFFER_PAGE_BYTES)] as ArrayBuffer;
  }

  release(location: number): void {
    const index = Math.floor(location / BUFFER_PAGE_BYTES);
    const page = this.pages[index] as Page;
    if (page.availableIndex < 0) {
      const available = this.available[page.kind] as number[];
      page.availableIndex = available.length;
      available.push(index);
    }
    page.free.push(location % BUFFER_PAGE_BYTES);
    page.live--;
    if (page.live === 0) this.idle += BUFFER_PAGE_BYTES;
  }

  /** Bounded page visits; never moves live cells. */
  trim(targetBytes: number, visits = this.pages.length): number {
    let freed = 0;
    for (let n = 0; n < Math.min(visits, this.pages.length); n++) {
      const index = this.scan++ % this.pages.length;
      const page = this.pages[index];
      if (page === undefined || page.live !== 0 || this.idle <= targetBytes) continue;
      this.removeAvailable(page);
      this.pages[index] = undefined;
      this.buffers[index] = undefined;
      this.vacant.push(index);
      this.bytes -= BUFFER_PAGE_BYTES;
      this.idle -= BUFFER_PAGE_BYTES;
      this.trimmedBytes += BUFFER_PAGE_BYTES;
      freed += BUFFER_PAGE_BYTES;
    }
    return freed;
  }

  idleBytes(): number {
    return this.idle;
  }

  private removeAvailable(page: Page): void {
    if (page.availableIndex < 0) return;
    const available = this.available[page.kind] as number[];
    const last = available.pop() as number;
    if (page.availableIndex < available.length) {
      available[page.availableIndex] = last;
      (this.pages[last] as Page).availableIndex = page.availableIndex;
    }
    page.availableIndex = -1;
  }
}
