/**
 * Ordering of one view's sorted phase. `layered` orders by
 * (layer, value, material, tie); `distance` orders by (value, tie).
 */
export type SortedPhaseOrder = 'distance' | 'layered';

/** Cumulative work evidence; tests and benches read deltas. */
export interface SortedPhaseWork {
  /** Comparator evaluations. */
  compared: number;
  /** Elements shifted by insertion, removal or repair. */
  moved: number;
  /** Items whose ordering facts entered, changed or left. */
  changed: number;
  /** Whole-array near-sorted repairs (all values changed or ties were reassigned). */
  repairs: number;
  /** Full sorts after a repair exceeded its displacement budget. */
  sorts: number;
}

const INITIAL_CAPACITY = 64;
// Interleaved member facts: key, layer, value, material, tie.
const STRIDE = 5;
const KEY = 0;
const LAYER = 1;
const VALUE = 2;
const MATERIAL = 3;
const TIE = 4;

/**
 * A view-private retained sorted phase: the members of one sorted draw list,
 * kept in order across frames and keyed by a stable non-negative row key.
 *
 * Consumers feed diffs (`enter` / `update` / `leave`). With the order valid,
 * each diff is applied at once: O(log n) comparisons to locate it plus the
 * native shift of its displacement, so a frame with a static camera costs
 * O(changes). When every value changes (camera move) or ties are reassigned,
 * `invalidate` defers ordering; `commit` then repairs the retained array with
 * a near-sorted insertion sort, O(n + inversions), falling back to a full
 * sort only when displacement exceeds a linear budget. NaN values have no
 * order; while one is a member the phase reports `ordered === false` and the
 * caller owns that frame's order.
 *
 * Ties must be unique among members to make the order strict; the key breaks
 * any remaining tie so every position is addressable by binary search.
 */
export class SortedPhase {
  private readonly ids = new Map<number, number>();
  /** Per id, interleaved so one comparison reads one cache line per member. */
  private facts = new Float64Array(INITIAL_CAPACITY * STRIDE);
  private dead = new Uint8Array(INITIAL_CAPACITY);
  private orderIds = new Int32Array(INITIAL_CAPACITY);
  private count = 0;
  private freeIds: number[] = [];
  private nextId = 0;
  private nan = 0;
  private deferred = false;
  private pendingDead = 0;
  private dirty = false;
  private orderKind: SortedPhaseOrder;
  /** Advances once per commit that changed membership or order. */
  revision = 0;
  readonly work: SortedPhaseWork = { compared: 0, moved: 0, changed: 0, repairs: 0, sorts: 0 };

  constructor(order: SortedPhaseOrder) {
    this.orderKind = order;
  }

  get order(): SortedPhaseOrder {
    return this.orderKind;
  }

  /** Members, including deferred removals until the next commit. */
  get length(): number {
    return this.count;
  }

  /** False while a member's value is NaN: no consistent order exists. */
  get ordered(): boolean {
    return this.nan === 0;
  }

  setOrder(order: SortedPhaseOrder): void {
    if (order === this.orderKind) return;
    this.orderKind = order;
    this.invalidate();
  }

  /** Internal id of a key, or -1. Ids are dense and recycled after removal commits. */
  idOf(key: number): number {
    return this.ids.get(key) ?? -1;
  }

  keyOf(id: number): number {
    return this.facts[id * STRIDE + KEY] as number;
  }

  layerOf(id: number): number {
    return this.facts[id * STRIDE + LAYER] as number;
  }

  valueOf(id: number): number {
    return this.facts[id * STRIDE + VALUE] as number;
  }

  materialOf(id: number): number {
    return this.facts[id * STRIDE + MATERIAL] as number;
  }

  tieOf(id: number): number {
    return this.facts[id * STRIDE + TIE] as number;
  }

  /** Id at an ordered position; valid after commit while `ordered`. */
  at(position: number): number {
    return this.orderIds[position] as number;
  }

  /** Suspend ordering until commit; subsequent diffs cost O(1). */
  invalidate(): void {
    this.deferred = true;
  }

  enter(key: number, layer: number, value: number, material: number, tie: number): number {
    if (this.ids.has(key)) throw new Error('SortedPhase key is already a member');
    const id = this.allocate();
    this.ids.set(key, id);
    this.facts[id * STRIDE + KEY] = key;
    this.assign(id, layer, value, material, tie);
    this.dead[id] = 0;
    this.work.changed += 1;
    this.dirty = true;
    if (Number.isNaN(value)) {
      this.nan += 1;
      this.deferred = true;
    }
    if (this.count === this.orderIds.length) this.orderIds = grow(this.orderIds);
    if (this.deferred) {
      this.orderIds[this.count++] = id;
      return id;
    }
    const position = this.upperBound(id);
    this.shiftRight(position);
    this.orderIds[position] = id;
    return id;
  }

  update(id: number, layer: number, value: number, material: number, tie: number): void {
    const facts = this.facts;
    const at = id * STRIDE;
    if (
      facts[at + LAYER] === layer &&
      Object.is(facts[at + VALUE], value) &&
      facts[at + MATERIAL] === material &&
      facts[at + TIE] === tie
    )
      return;
    this.work.changed += 1;
    const wasNaN = Number.isNaN(facts[at + VALUE] as number);
    const nowNaN = Number.isNaN(value);
    if (this.deferred || wasNaN || nowNaN) {
      this.nan += (nowNaN ? 1 : 0) - (wasNaN ? 1 : 0);
      this.assign(id, layer, value, material, tie);
      this.invalidate();
      return;
    }
    const from = this.positionOf(id);
    this.assign(id, layer, value, material, tie);
    const order = this.orderIds;
    const previous = from > 0 ? (order[from - 1] as number) : -1;
    const next = from + 1 < this.count ? (order[from + 1] as number) : -1;
    if (
      (previous < 0 || this.compare(previous, id) < 0) &&
      (next < 0 || this.compare(id, next) < 0)
    )
      return;
    this.dirty = true;
    // Remove, then insert into the remaining strictly ordered array.
    order.copyWithin(from, from + 1, this.count);
    this.count -= 1;
    const to = this.upperBound(id);
    order.copyWithin(to + 1, to, this.count);
    order[to] = id;
    this.count += 1;
    this.work.moved += Math.abs(to - from);
  }

  leave(id: number): void {
    const key = this.keyOf(id);
    if (this.ids.get(key) !== id || this.dead[id] === 1)
      throw new Error('SortedPhase leave requires a live member');
    this.ids.delete(key);
    this.work.changed += 1;
    this.dirty = true;
    if (Number.isNaN(this.valueOf(id))) {
      this.nan -= 1;
      this.deferred = true;
    }
    if (this.deferred) {
      this.dead[id] = 1;
      this.pendingDead += 1;
      return;
    }
    const position = this.positionOf(id);
    this.orderIds.copyWithin(position, position + 1, this.count);
    this.count -= 1;
    this.work.moved += this.count - position;
    this.freeIds.push(id);
  }

  /** Apply deferred removals and repairs. True when membership or order changed. */
  commit(): boolean {
    if (this.deferred) {
      if (this.pendingDead > 0) this.compact();
      if (this.nan === 0) {
        if (this.repair()) this.dirty = true;
        this.deferred = false;
      }
    }
    const changed = this.dirty;
    this.dirty = false;
    if (changed) this.revision += 1;
    return changed;
  }

  /** Visit live ids in retained order (stale order while deferred). */
  forEachId(visit: (id: number) => void): void {
    const order = this.orderIds;
    for (let position = 0; position < this.count; position++) {
      const id = order[position] as number;
      if (this.dead[id] === 0) visit(id);
    }
  }

  /** Strict total order over live ids. */
  compare(a: number, b: number): number {
    this.work.compared += 1;
    const facts = this.facts;
    const x = a * STRIDE;
    const y = b * STRIDE;
    if (this.orderKind === 'layered') {
      const la = facts[x + LAYER] as number;
      const lb = facts[y + LAYER] as number;
      if (la !== lb) return la - lb;
    }
    const va = facts[x + VALUE] as number;
    const vb = facts[y + VALUE] as number;
    if (va < vb) return -1;
    if (va > vb) return 1;
    if (this.orderKind === 'layered') {
      const ma = facts[x + MATERIAL] as number;
      const mb = facts[y + MATERIAL] as number;
      if (ma !== mb) return ma - mb;
    }
    const ta = facts[x + TIE] as number;
    const tb = facts[y + TIE] as number;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return (facts[x + KEY] as number) - (facts[y + KEY] as number);
  }

  private assign(id: number, layer: number, value: number, material: number, tie: number): void {
    const facts = this.facts;
    const at = id * STRIDE;
    facts[at + LAYER] = layer;
    facts[at + VALUE] = value;
    facts[at + MATERIAL] = material;
    facts[at + TIE] = tie;
  }

  private allocate(): number {
    const recycled = this.freeIds.pop();
    if (recycled !== undefined) return recycled;
    const id = this.nextId++;
    if (id === this.dead.length) {
      this.facts = grow(this.facts);
      this.dead = grow(this.dead);
    }
    return id;
  }

  /** First position whose member orders after `id`; `id` itself is not in the range. */
  private upperBound(id: number): number {
    let low = 0;
    let high = this.count;
    const order = this.orderIds;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.compare(order[middle] as number, id) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private positionOf(id: number): number {
    const position = this.upperBound(id);
    if (this.orderIds[position] !== id) throw new Error('SortedPhase lost its retained order');
    return position;
  }

  private shiftRight(position: number): void {
    this.orderIds.copyWithin(position + 1, position, this.count);
    this.work.moved += this.count - position;
    this.count += 1;
  }

  private compact(): void {
    const order = this.orderIds;
    let write = 0;
    for (let read = 0; read < this.count; read++) {
      const id = order[read] as number;
      if (this.dead[id] === 1) {
        this.dead[id] = 0;
        this.freeIds.push(id);
      } else order[write++] = id;
    }
    this.work.moved += this.count;
    this.count = write;
    this.pendingDead = 0;
  }

  /** Near-sorted insertion repair; true when any member moved. */
  private repair(): boolean {
    this.work.repairs += 1;
    const order = this.orderIds;
    const n = this.count;
    const budget = 8 * n + 1024;
    let moved = 0;
    for (let index = 1; index < n; index++) {
      const id = order[index] as number;
      let at = index - 1;
      if (this.compare(order[at] as number, id) <= 0) continue;
      do {
        order[at + 1] = order[at] as number;
        at--;
        moved++;
      } while (at >= 0 && this.compare(order[at] as number, id) > 0);
      order[at + 1] = id;
      if (moved > budget) {
        this.work.moved += moved;
        this.work.sorts += 1;
        order.subarray(0, n).sort((a, b) => this.compare(a, b));
        return true;
      }
    }
    this.work.moved += moved;
    return moved > 0;
  }
}

function grow<T extends Float64Array | Int32Array | Uint8Array>(array: T): T {
  const next = new (array.constructor as new (length: number) => T)(array.length * 2);
  next.set(array);
  return next;
}
