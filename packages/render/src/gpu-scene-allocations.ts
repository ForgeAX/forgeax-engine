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
  /**
   * Rows reserved at `instanceStart` (and, for explicit instances, at
   * `instanceTransformStart`); at least `instanceCount`. Rows past the count
   * are unreferenced: no primitive row addresses them, and they keep the
   * bytes last uploaded for them, so the CPU mirror still equals the GPU.
   */
  readonly instanceCapacity: number;
  readonly materialRanges: Ranges;
}

/** All prepared slots of one Source share this allocation-lifetime observation. */
export interface PrimitiveAllocationResidency {
  invalidated: boolean;
}

const RECORD = 0;
const INSTANCE_START = 1;
const INSTANCE_COUNT = 2;
const TRANSFORM_START = 3;
const INSTANCE_TRANSFORM_START = 4;
const INSTANCE_TRANSFORM_COUNT = 5;
/** Change stamp: a replaced allocation differs from the one it replaced. */
const STAMP = 6;
const INSTANCE_CAPACITY = 7;
const WIDTH = 8;

/** Strongest write required by any lane of this synchronous publication. */
export const SlotWrite = { pose: 0, instances: 1, full: 2, reset: 3 } as const;
type SlotWrite = (typeof SlotWrite)[keyof typeof SlotWrite];

/**
 * Slot-indexed GPU Scene allocations as numeric columns plus two shared
 * reference columns (interned Mesh and material-range owners): no object per
 * slot. `stamp` replaces allocation-object identity.
 */
export class PrimitiveAllocations<Mesh, Ranges> {
  private columns = new Uint32Array(64 * WIDTH);
  private present = new Uint8Array(64);
  /** Attempt-local write class, addressed by the same dense slot as its allocation. */
  private writeClasses = new Uint32Array(64);
  private writeEpoch = 0;
  private meshes: (Mesh | undefined)[] = [];
  private ranges: (Ranges | undefined)[] = [];
  /** Scene version whose complete numeric rows were consumed from preparation. */
  private publications = new Float64Array(64);
  private readonly residencies = new Map<number, PrimitiveAllocationResidency>();
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

  /** Direct numeric columns for consumers that do not need a detached allocation view. */
  transformStart(slot: number): number | undefined {
    return this.present[slot] === 1
      ? (this.columns[slot * WIDTH + TRANSFORM_START] as number)
      : undefined;
  }

  instanceTransformStart(slot: number): number | undefined {
    return this.present[slot] === 1
      ? (this.columns[slot * WIDTH + INSTANCE_TRANSFORM_START] as number)
      : undefined;
  }

  instanceTransformCount(slot: number): number | undefined {
    return this.present[slot] === 1
      ? (this.columns[slot * WIDTH + INSTANCE_TRANSFORM_COUNT] as number)
      : undefined;
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
      instanceCapacity: columns[base + INSTANCE_CAPACITY] as number,
      materialRanges: this.ranges[slot] as Ranges,
    };
  }

  set(
    slot: number,
    allocation: PrimitiveAllocation<Mesh, Ranges>,
    residency?: PrimitiveAllocationResidency,
  ): void {
    if (!Number.isSafeInteger(slot) || slot < 0)
      throw new RangeError('GPU Scene allocations are addressed by non-negative slots');
    this.ensure(slot);
    this.invalidateResidency(slot);
    if (residency !== undefined) this.residencies.set(slot, residency);
    this.publications[slot] = 0;
    const base = slot * WIDTH;
    const columns = this.columns;
    columns[base + RECORD] = allocation.recordIndex;
    columns[base + INSTANCE_START] = allocation.instanceStart;
    columns[base + INSTANCE_COUNT] = allocation.instanceCount;
    columns[base + TRANSFORM_START] = allocation.transformStart;
    columns[base + INSTANCE_TRANSFORM_START] = allocation.instanceTransformStart;
    columns[base + INSTANCE_TRANSFORM_COUNT] = allocation.instanceTransformCount;
    columns[base + INSTANCE_CAPACITY] = allocation.instanceCapacity;
    this.stamps = (this.stamps % 0xfffffffe) + 1;
    columns[base + STAMP] = this.stamps;
    this.meshes[slot] = allocation.mesh;
    this.ranges[slot] = allocation.materialRanges;
    if (this.present[slot] !== 1) this.count++;
    this.present[slot] = 1;
  }

  /**
   * Change a live allocation's instance counts within its reserved capacity.
   * The rows keep their addresses, so the stamp does not change: the slot is
   * not a replaced allocation and its retained rows keep their history.
   */
  resizeInstances(slot: number, instanceCount: number, instanceTransformCount: number): void {
    if (this.present[slot] !== 1) throw new RangeError('GPU Scene allocation unavailable');
    const base = slot * WIDTH;
    const capacity = this.columns[base + INSTANCE_CAPACITY] as number;
    if (instanceCount > capacity || instanceTransformCount > capacity)
      throw new RangeError('GPU Scene instance resize exceeds the reserved capacity');
    this.columns[base + INSTANCE_COUNT] = instanceCount;
    this.columns[base + INSTANCE_TRANSFORM_COUNT] = instanceTransformCount;
    this.publications[slot] = 0;
  }

  beginWrites(): void {
    // Two low bits hold the class. A new attempt also invalidates failed writes.
    if (this.writeEpoch === 0xfffffffc) {
      this.writeClasses.fill(0);
      this.writeEpoch = 0;
    }
    this.writeEpoch += 4;
  }

  requireWrite(slot: number, kind: SlotWrite): void {
    const next = this.writeEpoch + kind;
    if ((this.writeClasses[slot] ?? 0) < next) this.writeClasses[slot] = next;
  }

  writeClass(slot: number): SlotWrite {
    const mark = this.writeClasses[slot] ?? 0;
    return mark < this.writeEpoch ? SlotWrite.pose : ((mark & 3) as SlotWrite);
  }

  /** Grow only the existing columns; no live allocation is published. */
  prepareSlot(slot: number): void {
    this.ensure(slot);
  }

  acceptPublication(slot: number, version: number): void {
    if (this.present[slot] !== 1) throw new RangeError('GPU Scene allocation unavailable');
    this.publications[slot] = version;
  }

  publicationVersion(slot: number): number {
    return this.present[slot] === 1 ? (this.publications[slot] ?? 0) : 0;
  }

  delete(slot: number): void {
    if (this.present[slot] !== 1) return;
    this.invalidateResidency(slot);
    this.present[slot] = 0;
    this.publications[slot] = 0;
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
    for (const residency of this.residencies.values()) residency.invalidated = true;
    this.residencies.clear();
    this.columns = new Uint32Array(0);
    this.present = new Uint8Array(0);
    this.writeClasses = new Uint32Array(0);
    this.writeEpoch = 0;
    this.publications = new Float64Array(0);
    this.meshes = [];
    this.ranges = [];
    this.count = 0;
  }

  private invalidateResidency(slot: number): void {
    const residency = this.residencies.get(slot);
    if (residency === undefined) return;
    residency.invalidated = true;
    this.residencies.delete(slot);
  }

  private ensure(slot: number): void {
    if (slot < this.present.length) return;
    let capacity = Math.max(64, this.present.length);
    while (capacity <= slot) capacity *= 2;
    const present = new Uint8Array(capacity);
    present.set(this.present);
    this.present = present;
    const writeClasses = new Uint32Array(capacity);
    writeClasses.set(this.writeClasses);
    this.writeClasses = writeClasses;
    const publications = new Float64Array(capacity);
    publications.set(this.publications);
    this.publications = publications;
    const columns = new Uint32Array(capacity * WIDTH);
    columns.set(this.columns);
    this.columns = columns;
  }
}
