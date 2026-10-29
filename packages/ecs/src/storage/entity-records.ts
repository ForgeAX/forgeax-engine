// Entity index table as struct-of-arrays: one typed column per record field,
// so a million entities cost three typed-array cells each, not one heap
// object each.
//
// Liveness: a despawn unconditionally bumps `generation` (so a stale handle's
// generation no longer matches), and a retired generation is never pushed
// back to the free-list. A deferred-spawn reservation is "pending" while
// `archetypeId === -1`. During a failed append, `archetypeId` is reserved
// before the first storage write and `archetypeRow` remains `-1`; that marker
// prevents command abort from reclaiming a reservation that may already have
// touched table storage. The single liveness predicate is therefore
// "generation matches AND archetypeId !== -1 AND archetypeRow !== -1".

const INITIAL_CAPACITY = 64;

/** World-owned entity location table indexed by entity slot. */
export class EntityRecords {
  /** Slot generation; retired slots keep their final generation. */
  generation: Uint16Array = new Uint16Array(INITIAL_CAPACITY);
  /** Archetype id, or -1 while pending / despawned. */
  archetypeId: Int32Array = new Int32Array(INITIAL_CAPACITY).fill(-1);
  /** Row inside the archetype, or -1 while pending / despawned. */
  archetypeRow: Int32Array = new Int32Array(INITIAL_CAPACITY).fill(-1);
  /** Allocated slot count; cells at or past it are not records. */
  length = 0;

  /** Append one pending record (generation 0, no archetype) and return its slot. */
  push(): number {
    const slot = this.length;
    if (slot === this.generation.length) this.grow(slot * 2);
    this.length = slot + 1;
    return slot;
  }

  /** Current generation, or -1 for a slot that was never allocated. */
  generationOf(slot: number): number {
    return slot >= 0 && slot < this.length ? (this.generation[slot] as number) : -1;
  }

  /** True when `slot` is allocated, materialized and still at `generation`. */
  isLive(slot: number, generation: number): boolean {
    return (
      slot >= 0 &&
      slot < this.length &&
      this.generation[slot] === generation &&
      this.archetypeId[slot] !== -1 &&
      this.archetypeRow[slot] !== -1
    );
  }

  private grow(capacity: number): void {
    const generation = new Uint16Array(capacity);
    generation.set(this.generation);
    const archetypeId = new Int32Array(capacity).fill(-1);
    archetypeId.set(this.archetypeId);
    const archetypeRow = new Int32Array(capacity).fill(-1);
    archetypeRow.set(this.archetypeRow);
    this.generation = generation;
    this.archetypeId = archetypeId;
    this.archetypeRow = archetypeRow;
  }
}
