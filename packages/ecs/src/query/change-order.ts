import { type EntityHandle, entityIndex } from '../entity-handle';
import type { WorldInternal } from '../world-internal';

const BUCKETS = 256;
const LEVELS = 8;
const SMALL = 32;

/** Physical iteration order for changed identities, without comparison-sort growth. */
export class ChangedEntityOrder {
  // Allocated only for a large changed batch. No entity-sized retained scratch.
  private scratch: Uint32Array | undefined;

  constructor(
    private readonly owner: WorldInternal,
    private readonly sparse: boolean,
  ) {}

  sort(entities: EntityHandle[]): void {
    if (entities.length <= SMALL) {
      this.insertion(entities, 0, entities.length);
      return;
    }
    this.scratch ??= new Uint32Array(LEVELS * BUCKETS * 3);
    this.partition(entities, 0, entities.length, 0, this.scratch);
  }

  private key(entity: EntityHandle, row: boolean): number {
    const record = this.owner.getRecords()[entityIndex(entity)];
    const archetype = this.owner.getGraph().archetypes[record?.archetypeId ?? -1];
    if (row)
      return this.sparse
        ? (record?.archetypeRow ?? 0)
        : (archetype?.rows[record?.archetypeRow ?? -1] ?? 0);
    return this.sparse ? (archetype?.id ?? 0) : (archetype?.tableId ?? 0);
  }

  private compare(a: EntityHandle, b: EntityHandle): number {
    return this.key(a, false) - this.key(b, false) || this.key(a, true) - this.key(b, true);
  }

  private insertion(entities: EntityHandle[], start: number, end: number): void {
    for (let at = start + 1; at < end; at++) {
      const entity = entities[at] as EntityHandle;
      let into = at;
      while (into > start && this.compare(entities[into - 1] as EntityHandle, entity) > 0) {
        entities[into] = entities[into - 1] as EntityHandle;
        into--;
      }
      entities[into] = entity;
    }
  }

  private bucket(entity: EntityHandle, level: number): number {
    // Both keys are native array indices, so four unsigned bytes each suffice.
    return (this.key(entity, level >= 4) >>> (24 - (level & 3) * 8)) & 255;
  }

  private partition(
    entities: EntityHandle[],
    start: number,
    end: number,
    level: number,
    scratch: Uint32Array,
  ): void {
    if (end - start <= SMALL) {
      this.insertion(entities, start, end);
      return;
    }
    const counts = level * BUCKETS * 3;
    const next = counts + BUCKETS;
    const ends = next + BUCKETS;
    scratch.fill(0, counts, next);
    for (let at = start; at < end; at++) {
      const bucket = this.bucket(entities[at] as EntityHandle, level);
      scratch[counts + bucket] = (scratch[counts + bucket] ?? 0) + 1;
    }
    let offset = start;
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      scratch[next + bucket] = offset;
      offset += scratch[counts + bucket] ?? 0;
      scratch[ends + bucket] = offset;
    }
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      while ((scratch[next + bucket] ?? 0) < (scratch[ends + bucket] ?? 0)) {
        const at = scratch[next + bucket] ?? 0;
        const entity = entities[at] as EntityHandle;
        const destination = this.bucket(entity, level);
        if (destination === bucket) scratch[next + bucket] = at + 1;
        else {
          const into = scratch[next + destination] ?? 0;
          entities[at] = entities[into] as EntityHandle;
          entities[into] = entity;
          scratch[next + destination] = into + 1;
        }
      }
    }
    if (level + 1 === LEVELS) return;
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      const stop = scratch[ends + bucket] ?? 0;
      const begin = stop - (scratch[counts + bucket] ?? 0);
      if (stop - begin > 1) this.partition(entities, begin, stop, level + 1, scratch);
    }
  }
}
