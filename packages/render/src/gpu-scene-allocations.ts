/**
 * One slot's GPU Scene row allocation. A read view materialized on request;
 * the table stores these facts as per-slot numeric columns.
 */
export interface PrimitiveAllocation<Mesh, Ranges> {
  readonly mesh: Mesh | undefined;
  readonly recordIndex: number;
  readonly instanceStart: number;
  readonly instanceCount: number;
  readonly transformStart: number;
  readonly instanceTransformStart: number;
  readonly instanceTransformCount: number;
  readonly materialRanges: Ranges;
}

const RECORD = 0;
const INSTANCE_START = 1;
const INSTANCE_COUNT = 2;
const TRANSFORM_START = 3;
const INSTANCE_TRANSFORM_START = 4;
const INSTANCE_TRANSFORM_COUNT = 5;
/** Change stamp: a replaced allocation differs from the one it replaced. */
const STAMP = 6;
const WIDTH = 7;

/**
 * Slot-indexed GPU Scene allocations as numeric columns plus two shared
 * reference columns (interned Mesh and material-range owners): no object per
 * slot. `stamp` replaces allocation-object identity.
 */
export class PrimitiveAllocations<Mesh, Ranges> {
  private columns = new Uint32Array(64 * WIDTH);
  private present = new Uint8Array(64);
  private meshes: (Mesh | undefined)[] = [];
  private ranges: (Ranges | undefined)[] = [];
  private stamps = 0;
  private count = 0;

  get size(): number {
    return this.count;
  }

  has(slot: number): boolean {
    return this.present[slot] === 1;
  }

  /** `undefined` when the slot has no allocation. */
  recordIndex(slot: number): number | undefined {
    return this.present[slot] === 1 ? (this.columns[slot * WIDTH + RECORD] as number) : undefined;
  }

  /** Nonzero for a live allocation; changes whenever the slot's allocation is replaced. */
  stamp(slot: number): number {
    return this.present[slot] === 1 ? (this.columns[slot * WIDTH + STAMP] as number) : 0;
  }

  /** The slot's interned material-range owner. */
  materialRanges(slot: number): Ranges | undefined {
    return this.present[slot] === 1 ? this.ranges[slot] : undefined;
  }

  /** First instance row and instance count; `undefined` without an allocation. */
  instanceStart(slot: number): number | undefined {
    return this.present[slot] === 1
      ? (this.columns[slot * WIDTH + INSTANCE_START] as number)
      : undefined;
  }

  instanceCount(slot: number): number {
    return this.present[slot] === 1 ? (this.columns[slot * WIDTH + INSTANCE_COUNT] as number) : 0;
  }

  get(slot: number): PrimitiveAllocation<Mesh, Ranges> | undefined {
    if (this.present[slot] !== 1) return undefined;
    const base = slot * WIDTH;
    const columns = this.columns;
    return {
      mesh: this.meshes[slot],
      recordIndex: columns[base + RECORD] as number,
      instanceStart: columns[base + INSTANCE_START] as number,
      instanceCount: columns[base + INSTANCE_COUNT] as number,
      transformStart: columns[base + TRANSFORM_START] as number,
      instanceTransformStart: columns[base + INSTANCE_TRANSFORM_START] as number,
      instanceTransformCount: columns[base + INSTANCE_TRANSFORM_COUNT] as number,
      materialRanges: this.ranges[slot] as Ranges,
    };
  }

  set(slot: number, allocation: PrimitiveAllocation<Mesh, Ranges>): void {
    if (!Number.isSafeInteger(slot) || slot < 0)
      throw new RangeError('GPU Scene allocations are addressed by non-negative slots');
    this.ensure(slot);
    const base = slot * WIDTH;
    const columns = this.columns;
    columns[base + RECORD] = allocation.recordIndex;
    columns[base + INSTANCE_START] = allocation.instanceStart;
    columns[base + INSTANCE_COUNT] = allocation.instanceCount;
    columns[base + TRANSFORM_START] = allocation.transformStart;
    columns[base + INSTANCE_TRANSFORM_START] = allocation.instanceTransformStart;
    columns[base + INSTANCE_TRANSFORM_COUNT] = allocation.instanceTransformCount;
    this.stamps = (this.stamps % 0xfffffffe) + 1;
    columns[base + STAMP] = this.stamps;
    this.meshes[slot] = allocation.mesh;
    this.ranges[slot] = allocation.materialRanges;
    if (this.present[slot] !== 1) this.count++;
    this.present[slot] = 1;
  }

  delete(slot: number): void {
    if (this.present[slot] !== 1) return;
    this.present[slot] = 0;
    this.meshes[slot] = undefined;
    this.ranges[slot] = undefined;
    this.count--;
  }

  *keys(): Generator<number> {
    const present = this.present;
    for (let slot = 0; slot < present.length && this.count > 0; slot++)
      if (present[slot] === 1) yield slot;
  }

  clear(): void {
    this.present.fill(0);
    this.meshes = [];
    this.ranges = [];
    this.count = 0;
  }

  private ensure(slot: number): void {
    if (slot < this.present.length) return;
    let capacity = this.present.length;
    while (capacity <= slot) capacity *= 2;
    const present = new Uint8Array(capacity);
    present.set(this.present);
    this.present = present;
    const columns = new Uint32Array(capacity * WIDTH);
    columns.set(this.columns);
    this.columns = columns;
  }
}
