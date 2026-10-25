/** What one logged write did to its slot. */
export type RowChange = 'enter' | 'update' | 'leave';

const KINDS: readonly RowChange[] = ['enter', 'update', 'leave'];
const CODE: Readonly<Record<RowChange, number>> = { enter: 0, update: 1, leave: 2 };
const MIN_CAPACITY = 1024;

/**
 * The scene's row changes as an append-only ring of (slot, kind, generation).
 * A consumer's cursor is the log position of the frame it last consumed, so
 * each consumer visits only the entries appended since its own cursor. The
 * ring overwrites its oldest entries once it holds at least `retain`
 * entries; a cursor older than the retained history cannot be answered.
 */
export class RowChangeLog {
  private slots = new Int32Array(MIN_CAPACITY);
  private kinds = new Uint8Array(MIN_CAPACITY);
  private generations = new Uint32Array(MIN_CAPACITY);
  private head = 0;
  private tail = 0;

  /** The position the next entry takes; a frame captures it as its cursor. */
  get position(): number {
    return this.head;
  }

  append(slot: number, kind: RowChange, generation: number, retain: number): void {
    if (this.head - this.tail === this.slots.length) {
      if (this.slots.length < retain) this.grow();
      else this.tail++;
    }
    const at = this.head & (this.slots.length - 1);
    this.slots[at] = slot;
    this.kinds[at] = CODE[kind];
    this.generations[at] = generation;
    this.head++;
  }

  /** No earlier cursor can be answered: every row may have changed. */
  reset(): void {
    this.head++;
    this.tail = this.head;
  }

  /**
   * Visit the entries in `[from, to)` in append order. `false` (nothing
   * visited) when the ring no longer holds `from`.
   */
  visit(
    from: number,
    to: number,
    visit: (slot: number, kind: RowChange, generation: number) => void,
  ): boolean {
    if (from < this.tail || from > to || to > this.head) return false;
    const mask = this.slots.length - 1;
    for (let position = from; position < to; position++) {
      const at = position & mask;
      visit(
        this.slots[at] as number,
        KINDS[this.kinds[at] as number] as RowChange,
        this.generations[at] as number,
      );
    }
    return true;
  }

  private grow(): void {
    const capacity = this.slots.length * 2;
    const slots = new Int32Array(capacity);
    const kinds = new Uint8Array(capacity);
    const generations = new Uint32Array(capacity);
    const oldMask = this.slots.length - 1;
    for (let position = this.tail; position < this.head; position++) {
      const from = position & oldMask;
      const to = position & (capacity - 1);
      slots[to] = this.slots[from] as number;
      kinds[to] = this.kinds[from] as number;
      generations[to] = this.generations[from] as number;
    }
    this.slots = slots;
    this.kinds = kinds;
    this.generations = generations;
  }
}
