/** What one logged write did to its slot. */
export type RowChange = 'enter' | 'update' | 'leave';

const KINDS: readonly RowChange[] = ['enter', 'update', 'leave'];
const CODE: Readonly<Record<RowChange, number>> = { enter: 0, update: 1, leave: 2 };
const ROW_KIND = 3;
/** The address has an earlier event in the same Scene publication. */
const FOLLOWUP_ROW = 4;
const MIN_CAPACITY = 1024;
const BOX = 6;
const MIN_BOX_CAPACITY = 64;

/**
 * Evidence flags of one GPU content entry. `CHANGED` names a slot whose GPU
 * content changed; `BOX` carries one conservative world box (six floats) the
 * slot occupied before or after the change; `UNBOUNDED` marks a changed slot
 * without a proven box; `WHOLE` (no slot) means every slot may have changed.
 */
export const CONTENT_CHANGED = 1;
export const CONTENT_BOX = 2;
export const CONTENT_UNBOUNDED = 4;
export const CONTENT_WHOLE = 8;
const CONTENT = 0x80;

/**
 * Visits one content entry; `boxes[offset..offset+6)` holds its box when
 * `flags` has {@link CONTENT_BOX}. Returning `false` stops the visit.
 */
export type ContentVisit = (
  slot: number,
  flags: number,
  boxes: Float32Array,
  offset: number,
) => boolean | undefined;

/**
 * The scene's one change journal: an append-only ring of row changes
 * (slot, enter|update|leave, generation) and the GPU Scene's content entries
 * (slot, evidence flags, box). A consumer's cursor is the log position it
 * last consumed, so each consumer visits only the entries appended since its
 * own cursor; row visitors skip content entries and content visitors skip
 * row entries. The ring overwrites its oldest entries once it holds at least
 * `retain` entries; a cursor older than the retained history cannot be
 * answered.
 */
export class RowChangeLog {
  private slots = new Int32Array(MIN_CAPACITY);
  private kinds = new Uint8Array(MIN_CAPACITY);
  /** A row generation or the low 32 bits of a box sequence number. */
  private generations = new Uint32Array(MIN_CAPACITY);
  private head = 0;
  private tail = 0;
  private retain = MIN_CAPACITY;
  private boxes = new Float32Array(0);
  private boxHead = 0;
  private boxTail = 0;
  /** A synchronous publication reader pins only the ring it is visiting. */
  private readingRows: Int32Array | undefined;

  /** The position the next entry takes; a frame captures it as its cursor. */
  get position(): number {
    return this.head;
  }

  append(
    slot: number,
    kind: RowChange,
    generation: number,
    retain: number,
    followup = false,
  ): void {
    this.retain = Math.max(MIN_CAPACITY, retain);
    this.push(slot, CODE[kind] | (followup ? FOLLOWUP_ROW : 0), generation);
  }

  /** Address of a known pose write, while its position is still retained. */
  updateSlotAt(position: number): number | undefined {
    if (position < this.tail || position >= this.head) return undefined;
    const at = position & (this.slots.length - 1);
    const kind = this.kinds[at] as number;
    return kind < CONTENT && (kind & ROW_KIND) === CODE.update ? this.slots[at] : undefined;
  }

  /** Append one GPU content entry, copying `box[offset..offset+6)` when flagged. */
  appendContent(slot: number, flags: number, box?: ArrayLike<number>, offset = 0): void {
    let at = 0;
    if ((flags & CONTENT_BOX) !== 0) {
      if (box === undefined) flags = (flags & ~CONTENT_BOX) | CONTENT_UNBOUNDED;
      else at = this.pushBox(box, offset);
    }
    this.push(slot, CONTENT | flags, at);
  }

  get backingBytes(): number {
    return (
      this.slots.byteLength +
      this.kinds.byteLength +
      this.generations.byteLength +
      this.boxes.byteLength
    );
  }

  /** A smaller published scene no longer owns the former retention budget.
   * Preserve every position still in budget and each box it can address. */
  trim(retain: number): void {
    this.retain = Math.max(MIN_CAPACITY, retain);
    if (this.retain * 4 >= this.slots.length && this.retain * 4 >= this.boxes.length / BOX) return;

    let capacity = MIN_CAPACITY;
    while (capacity < this.retain) capacity *= 2;
    if (this.slots.length > capacity) {
      this.resizeRows(capacity, Math.max(this.tail, this.head - capacity));
    }
    const firstBox = this.firstRetainedBox();
    const boxes = this.boxHead - firstBox;
    let boxCapacity = boxes === 0 ? 0 : MIN_BOX_CAPACITY;
    while (boxCapacity < boxes) boxCapacity *= 2;
    if (boxCapacity < this.boxes.length / BOX) this.resizeBoxes(boxCapacity, firstBox);
  }

  /** Box positions are monotone in retained row order, including across u32 wrap. */
  private firstRetainedBox(): number {
    const mask = this.slots.length - 1;
    const retained = this.boxHead - this.boxTail;
    for (let position = this.tail; position < this.head; position++) {
      const at = position & mask;
      const code = this.kinds[at] as number;
      if ((code & (CONTENT | CONTENT_BOX)) !== (CONTENT | CONTENT_BOX)) continue;
      const distance = ((this.generations[at] as number) - this.boxTail) >>> 0;
      if (distance < retained) return this.boxTail + distance;
    }
    return this.boxHead;
  }

  /** No earlier cursor can be answered: every row may have changed. */
  reset(): void {
    // Earlier cursors lapse, so their retained capacity is no longer a live
    // history requirement. Preserve monotonic positions across incarnations.
    if (this.slots.length > MIN_CAPACITY || this.slots === this.readingRows) {
      this.resizeRows(MIN_CAPACITY, this.head);
    }
    if (this.boxes.length > 0) this.boxes = new Float32Array(0);
    this.boxHead = this.boxTail = 0;
    this.retain = MIN_CAPACITY;
    this.head++;
    this.tail = this.head;
  }

  /**
   * Visit the row entries in `[from, to)` in append order. `false` (nothing
   * visited) when the ring no longer holds `from`.
   */
  visit(
    from: number,
    to: number,
    visit: (slot: number, kind: RowChange, generation: number) => void,
  ): boolean {
    if (!this.holds(from, to)) return false;
    const mask = this.slots.length - 1;
    for (let position = from; position < to; position++) {
      const at = position & mask;
      const code = this.kinds[at] as number;
      if (code >= CONTENT) continue;
      visit(
        this.slots[at] as number,
        KINDS[code & ROW_KIND] as RowChange,
        this.generations[at] as number,
      );
    }
    return true;
  }

  /** Read a captured publication in first-write order from the same event ring.
   * Distinct writes have consecutive versions. A repeated or interrupted batch
   * reads its final versions from the immutable frame. */
  visitPublication(
    from: number,
    to: number,
    version: number,
    visit: (slot: number, version: number) => void,
    finalVersion?: (slot: number) => number,
  ): boolean {
    if (!this.holds(from, to)) return false;
    const prior = this.readingRows;
    const { slots, kinds } = this;
    const mask = slots.length - 1;
    this.readingRows = slots;
    try {
      for (let position = from; position < to; position++) {
        const at = position & mask;
        const code = kinds[at] as number;
        if (code >= CONTENT || (code & FOLLOWUP_ROW) !== 0) continue;
        const slot = slots[at] as number;
        visit(
          slot,
          finalVersion === undefined ? (code === CODE.leave ? 0 : ++version) : finalVersion(slot),
        );
      }
      return true;
    } finally {
      this.readingRows = prior;
    }
  }

  /**
   * Visit the content entries in `[from, to)` in append order. `'lapsed'`
   * when the ring (or its box ring) no longer holds them, `'stopped'` when
   * `visit` returned `false`.
   */
  visitContent(from: number, to: number, visit: ContentVisit): 'done' | 'stopped' | 'lapsed' {
    if (!this.holds(from, to)) return 'lapsed';
    const mask = this.slots.length - 1;
    const boxMask = this.boxes.length / BOX - 1;
    for (let position = from; position < to; position++) {
      const at = position & mask;
      const code = this.kinds[at] as number;
      if (code < CONTENT) continue;
      const flags = code & ~CONTENT;
      let offset = 0;
      if ((flags & CONTENT_BOX) !== 0) {
        const box = this.generations[at] as number;
        // The retained ring is narrower than one 32-bit cycle. Distance from its
        // oldest sequence disambiguates live and overwritten boxes across wrap.
        if ((box - this.boxTail) >>> 0 >= this.boxHead - this.boxTail) return 'lapsed';
        offset = (box & boxMask) * BOX;
      }
      if (visit(this.slots[at] as number, flags, this.boxes, offset) === false) return 'stopped';
    }
    return 'done';
  }

  private holds(from: number, to: number): boolean {
    return from >= this.tail && from <= to && to <= this.head;
  }

  private push(slot: number, code: number, generation: number): void {
    if (this.head - this.tail === this.slots.length) {
      if (this.slots.length < this.retain) this.resizeRows(this.slots.length * 2, this.tail);
      else if (this.slots === this.readingRows) this.resizeRows(this.slots.length, this.tail + 1);
      else this.tail++;
    }
    const at = this.head & (this.slots.length - 1);
    this.slots[at] = slot;
    this.kinds[at] = code;
    this.generations[at] = generation;
    this.head++;
  }

  private pushBox(box: ArrayLike<number>, offset: number): number {
    const capacity = this.boxes.length / BOX;
    if (this.boxHead - this.boxTail === capacity) {
      if (capacity < this.retain)
        this.resizeBoxes(Math.max(MIN_BOX_CAPACITY, capacity * 2), this.boxTail);
      else this.boxTail++;
    }
    const at = (this.boxHead & (this.boxes.length / BOX - 1)) * BOX;
    for (let i = 0; i < BOX; i++) this.boxes[at + i] = box[offset + i] as number;
    return this.boxHead++;
  }

  private resizeRows(capacity: number, tail: number): void {
    const slots = new Int32Array(capacity);
    const kinds = new Uint8Array(capacity);
    const generations = new Uint32Array(capacity);
    const oldMask = this.slots.length - 1;
    for (let position = tail; position < this.head; position++) {
      const from = position & oldMask;
      const to = position & (capacity - 1);
      slots[to] = this.slots[from] as number;
      kinds[to] = this.kinds[from] as number;
      generations[to] = this.generations[from] as number;
    }
    this.slots = slots;
    this.kinds = kinds;
    this.generations = generations;
    this.tail = tail;
  }

  private resizeBoxes(capacity: number, tail: number): void {
    const old = this.boxes.length / BOX;
    const boxes = new Float32Array(capacity * BOX);
    for (let position = tail; position < this.boxHead; position++) {
      const from = (position & (old - 1)) * BOX;
      const to = (position & (capacity - 1)) * BOX;
      for (let i = 0; i < BOX; i++) boxes[to + i] = this.boxes[from + i] as number;
    }
    this.boxes = boxes;
    this.boxTail = tail;
  }
}
