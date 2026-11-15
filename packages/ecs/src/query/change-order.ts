import { type EntityHandle, entityIndex } from '../entity-handle';
import type { WorldInternal } from '../world-internal';

/** Changed identities of one iteration, held in a query-owned typed buffer. */
export type ChangedEntities = Uint32Array & { [index: number]: EntityHandle };

const BUCKETS = 256;
const LEVELS = 8;
const SMALL = 32;

/** Physical iteration order for changed identities, without comparison-sort growth. */
export class ChangedEntityOrder {
  // Allocated only for a large changed batch; key buffers track the largest batch, like candidates.
  private scratch: Uint32Array | undefined;
  // Batch-local (storage, row) keys, permuted with the identities they describe.
  private storageKeys = new Uint32Array(0);
  private rowKeys = new Uint32Array(0);

  constructor(
    private readonly owner: WorldInternal,
    private readonly sparse: boolean,
  ) {}

  // World storage borrowed for one sort call only.
  private records: ReturnType<WorldInternal['getRecords']> | undefined;
  private archetypes: ReturnType<WorldInternal['getGraph']>['archetypes'] | undefined;
  // Largest keys of the current batch; bytes above them are zero for every key.
  private maxStorage = 0;
  private maxRow = 0;

  sort(entities: ChangedEntities): void {
    this.records = this.owner.getRecords();
    this.archetypes = this.owner.getGraph().archetypes;
    if (this.storageKeys.length < entities.length) {
      this.storageKeys = new Uint32Array(entities.length * 2);
      this.rowKeys = new Uint32Array(entities.length * 2);
    }
    try {
      // Producers commonly write in physical order; one linear pass proves it.
      if (this.ordered(entities)) return;
      if (entities.length <= SMALL) {
        this.insertion(entities, 0, entities.length);
        return;
      }
      this.scratch ??= new Uint32Array(LEVELS * BUCKETS * 3);
      this.partition(entities, 0, entities.length, 0, this.scratch);
    } finally {
      this.records = undefined;
      this.archetypes = undefined;
    }
  }

  private ordered(entities: ChangedEntities): boolean {
    let storage = -1,
      row = -1,
      ordered = true,
      maxStorage = 0,
      maxRow = 0;
    for (let at = 0; at < entities.length; at++) {
      const entity = entities[at] as EntityHandle;
      const nextStorage = this.key(entity, false);
      const nextRow = this.key(entity, true);
      this.storageKeys[at] = nextStorage;
      this.rowKeys[at] = nextRow;
      if (nextStorage < storage || (nextStorage === storage && nextRow < row)) ordered = false;
      storage = nextStorage;
      row = nextRow;
      if (nextStorage > maxStorage) maxStorage = nextStorage;
      if (nextRow > maxRow) maxRow = nextRow;
    }
    this.maxStorage = maxStorage;
    this.maxRow = maxRow;
    return ordered;
  }

  private constantLevel(level: number): boolean {
    return (level >= 4 ? this.maxRow : this.maxStorage) >>> (24 - (level & 3) * 8) === 0;
  }

  private key(entity: EntityHandle, row: boolean): number {
    const records = this.records as ReturnType<WorldInternal['getRecords']>;
    const slot = entityIndex(entity);
    const archetype = this.archetypes?.[records.archetypeId[slot] ?? -1];
    if (row)
      return this.sparse
        ? (records.archetypeRow[slot] ?? 0)
        : (archetype?.rows[records.archetypeRow[slot] ?? -1] ?? 0);
    return this.sparse ? (archetype?.id ?? 0) : (archetype?.tableId ?? 0);
  }

  private insertion(entities: ChangedEntities, start: number, end: number): void {
    const storageKeys = this.storageKeys,
      rowKeys = this.rowKeys;
    for (let at = start + 1; at < end; at++) {
      const entity = entities[at] as EntityHandle;
      const storage = storageKeys[at] as number,
        row = rowKeys[at] as number;
      let into = at;
      while (into > start) {
        const before = storageKeys[into - 1] as number;
        if (before < storage || (before === storage && (rowKeys[into - 1] as number) <= row)) break;
        entities[into] = entities[into - 1] as EntityHandle;
        storageKeys[into] = before;
        rowKeys[into] = rowKeys[into - 1] as number;
        into--;
      }
      entities[into] = entity;
      storageKeys[into] = storage;
      rowKeys[into] = row;
    }
  }

  private bucket(at: number, level: number): number {
    // Both keys are native array indices, so four unsigned bytes each suffice.
    const key = (level >= 4 ? this.rowKeys[at] : this.storageKeys[at]) as number;
    return (key >>> (24 - (level & 3) * 8)) & 255;
  }

  private swap(entities: ChangedEntities, a: number, b: number): void {
    const entity = entities[a] as EntityHandle;
    entities[a] = entities[b] as EntityHandle;
    entities[b] = entity;
    const storage = this.storageKeys[a] as number;
    this.storageKeys[a] = this.storageKeys[b] as number;
    this.storageKeys[b] = storage;
    const row = this.rowKeys[a] as number;
    this.rowKeys[a] = this.rowKeys[b] as number;
    this.rowKeys[b] = row;
  }

  private partition(
    entities: ChangedEntities,
    start: number,
    end: number,
    first: number,
    scratch: Uint32Array,
  ): void {
    if (end - start <= SMALL) {
      this.insertion(entities, start, end);
      return;
    }
    let level = first;
    while (level < LEVELS && this.constantLevel(level)) level++;
    if (level === LEVELS) return;
    const counts = level * BUCKETS * 3;
    const next = counts + BUCKETS;
    const ends = next + BUCKETS;
    scratch.fill(0, counts, next);
    for (let at = start; at < end; at++) {
      const bucket = this.bucket(at, level);
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
        const destination = this.bucket(at, level);
        if (destination === bucket) scratch[next + bucket] = at + 1;
        else {
          const into = scratch[next + destination] ?? 0;
          this.swap(entities, at, into);
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
