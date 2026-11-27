import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type Component,
  type ComponentId,
  type ComponentSchema,
  componentDefinition,
  componentId,
  componentSchema,
  registeredComponentId,
  type ShapeOf,
  type TypedArrayFor,
} from '../component';
import { Disabled } from '../entity';
import { type EntityHandle, entityGeneration, entityIndex } from '../entity-handle';
import {
  createQueryDataRequiresFieldsError,
  createQueryDescriptorConflictError,
  createQueryIterationInvalidatedError,
  createQuerySpanUnavailableError,
  createRelationshipTargetReadonlyError,
  DerivedWriteActiveError,
  QueryBatchUnavailableError,
  type QueryDataRequiresFieldsError,
  type QueryDescriptorConflictError,
  QueryIterationActiveError,
  type QuerySpanUnavailableError,
  type QuerySpanUnavailableReason,
  worldPoisonedError,
} from '../errors';
import type { WorldExecutionState } from '../execution/shared-kernel';
import { DERIVED_WRITER, QUERY_ITERATING } from '../internal';
import { isRelationshipTarget, relationshipRole } from '../relationship-index';
import { type Archetype, type ArchetypeId, archetypeHasComponent } from '../storage/archetype';
import { CHANGE_CHUNK_SHIFT } from '../storage/change-column';
import { readComponentChanged, sparseTagIndex } from '../storage/change-detection';
import { columnWindow, type FieldView, type ManagedColumnReader } from '../storage/column';
import type { Table } from '../storage/table';
import { type WorldInternal, worldInternal } from '../world-internal';
import { type BatchLease, IndexedBatch, type QueryBatch, RangeBatch } from './batch';
import { createDerivedRangeWriter, type DerivedRangeWriter } from './derived-range-writer';

export interface QueryDescriptor<
  R extends readonly Component[] = readonly Component[],
  W extends readonly Component[] = readonly Component[],
  O extends readonly Component[] = readonly Component[],
> {
  readonly read?: R;
  readonly write?: W;
  readonly optional?: O;
  readonly with?: readonly Component[];
  readonly without?: readonly Component[];
  readonly changed?: readonly Component[];
  readonly added?: readonly Component[];
}

export type ReadonlyRowShape<C> =
  C extends Component<string, infer S> ? Readonly<ShapeOf<S>> : never;
export type MutableRowShape<C> =
  C extends Component<string, infer S>
    ? { -readonly [K in keyof ShapeOf<S>]: ShapeOf<S>[K] }
    : never;

type ColumnShapeForSchema<S extends ComponentSchema> = {
  [K in keyof S]: TypedArrayFor<S[K]>;
};

export type ReadonlyColumnShape<C> =
  C extends Component<string, infer S> ? Readonly<ColumnShapeForSchema<S>> : never;
export type MutableColumnShape<C> =
  C extends Component<string, infer S>
    ? { -readonly [K in keyof ColumnShapeForSchema<S>]: ColumnShapeForSchema<S>[K] }
    : never;

export interface QueryRow<
  R extends readonly Component[] = readonly Component[],
  W extends readonly Component[] = readonly Component[],
  O extends readonly Component[] = readonly Component[],
> {
  readonly entity: EntityHandle;
  /** Test component presence without materialising its row object. */
  has(component: R[number] | W[number] | O[number]): boolean;
  get<C extends R[number]>(component: C): ReadonlyRowShape<C>;
  get<C extends O[number]>(component: C): ReadonlyRowShape<C> | undefined;
  mut<C extends W[number]>(component: C): MutableRowShape<C>;
}

export interface QuerySpan<
  R extends readonly Component[] = readonly Component[],
  W extends readonly Component[] = readonly Component[],
> {
  /** Packed entity identities for this contiguous table range. */
  readonly entities: Readonly<Uint32Array>;
  readonly length: number;
  /** Table holding the span, and the table row of its first entity. */
  readonly tableId: number;
  readonly rowStart: number;
  get<C extends R[number]>(component: C): ReadonlyColumnShape<C>;
  mut<C extends W[number]>(component: C): MutableColumnShape<C>;
}

export interface Query<
  R extends readonly Component[] = readonly Component[],
  W extends readonly Component[] = readonly Component[],
  O extends readonly Component[] = readonly Component[],
> extends Iterable<QueryRow<R, W, O>> {
  /** Synchronously visit borrowed rows without allocating an iterator per traversal. */
  forEach(visit: (row: QueryRow<R, W, O>) => void): void;
  /**
   * Read one known entity without iterating the query's matching tables.
   * Structural descriptor constraints are applied; temporal `changed` and
   * `added` filters are intentionally not evaluated because this is an
   * identity-addressed read, not a version scan.
   */
  at(entity: EntityHandle): QueryRow<R, W, O> | undefined;
  /** Apply at() selection in input order. Each synchronous traversal lends one row to its visitor. */
  forEachAt(entities: Iterable<EntityHandle>, visit: (row: QueryRow<R, W, O>) => void): void;
  spans(): Result<Iterable<QuerySpan<R, W>>, QuerySpanUnavailableError>;
  /**
   * Accept every change visible now without visiting it: the next temporal
   * (`changed` / `added`) iteration starts after the current mutation epoch,
   * exactly as if this query had been iterated to completion here. Applies the
   * same readability and active-iteration guards as starting an iteration.
   */
  markObserved(): void;
  /** Borrow physical numeric columns with an explicit range or sparse row index. Read-only, non-temporal descriptors. */
  batches(): Result<Iterable<QueryBatch<R, W, O>>, QueryBatchUnavailableError>;
}

export type QueryCreationError = QueryDescriptorConflictError | QueryDataRequiresFieldsError;

interface WorldQueryAccess {
  readonly [worldInternal]: WorldInternal;
  readonly execution: WorldExecutionState;
}

interface CompiledDescriptor<
  R extends readonly Component[],
  W extends readonly Component[],
  O extends readonly Component[],
> {
  readonly descriptor: QueryDescriptor<R, W, O>;
  readonly requiredIds: readonly ComponentId[];
  readonly withoutIds: readonly ComponentId[];
  readonly changedIds: readonly ComponentId[];
  readonly addedIds: readonly ComponentId[];
  readonly sparseRoute: boolean;
}

/** Shared terminal step; iterator results are read immediately by consumers. */
/** Changed identities of one iteration, held in a query-owned typed buffer. */
export type ChangedEntities = Uint32Array & { [index: number]: EntityHandle };
const NO_CHANGED_ENTITIES = new Uint32Array(0) as ChangedEntities;
const NO_CANDIDATES = new Uint32Array(0);
const CHANGE_CHUNK = 1 << CHANGE_CHUNK_SHIFT;
type TableComponentStorage = NonNullable<ReturnType<Table['storage']['get']>>;
const QUERY_DONE: IteratorReturnResult<undefined> = Object.freeze({
  done: true,
  value: undefined,
});

const ACCESS_ROLES = ['read', 'write', 'optional', 'with', 'without'] as const;
const TEMPORAL_ROLES = ['changed', 'added'] as const;
export const DESCRIPTOR_ROLES = [...ACCESS_ROLES, ...TEMPORAL_ROLES] as const;
const EMPTY_COMPONENT_IDS: readonly ComponentId[] = Object.freeze([]);
type Role = (typeof ACCESS_ROLES)[number];

function compileDescriptor<
  const R extends readonly Component[],
  const W extends readonly Component[],
  const O extends readonly Component[],
>(descriptor: QueryDescriptor<R, W, O>): Result<CompiledDescriptor<R, W, O>, QueryCreationError> {
  // Successful descriptors need one role per component. Allocate diagnostic
  // role lists only for conflicts, preserving first-component error order.
  const roles = new Map<Component, Role | Role[]>();
  for (const role of ACCESS_ROLES) {
    const components = descriptor[role];
    if (components === undefined) continue;
    for (const component of components) {
      const previous = roles.get(component);
      if (previous === undefined) roles.set(component, role);
      else if (typeof previous === 'string') roles.set(component, [previous, role]);
      else previous.push(role);
    }
  }
  for (const [component, role] of roles) {
    if (typeof role !== 'string') {
      return err(createQueryDescriptorConflictError(component.name, role));
    }
  }

  let requiredIds: ComponentId[] = [];
  const withoutIds: ComponentId[] = [];
  let sparseRoute = false;
  for (const [component, role] of roles) {
    if (
      (role === 'read' || role === 'write' || role === 'optional') &&
      componentDefinition(component).fieldNames.length === 0
    ) {
      return err(createQueryDataRequiresFieldsError(component.name));
    }
    if (role === 'optional') continue;
    if (role === 'without') withoutIds.push(componentId(component));
    else requiredIds.push(componentId(component));
    if (component.storage === 'sparse') sparseRoute = true;
  }

  let changedIds = EMPTY_COMPONENT_IDS;
  let addedIds = EMPTY_COMPONENT_IDS;
  let requiredSet: Set<ComponentId> | undefined;
  for (const role of TEMPORAL_ROLES) {
    const components = descriptor[role];
    if (components === undefined || components.length === 0) continue;
    requiredSet ??= new Set(requiredIds);
    const ids = new Set<ComponentId>();
    for (const component of components) {
      const id = componentId(component);
      ids.add(id);
      requiredSet.add(id);
      if (component.storage === 'sparse') sparseRoute = true;
    }
    if (role === 'changed') changedIds = [...ids];
    else addedIds = [...ids];
  }
  if (requiredSet !== undefined) requiredIds = [...requiredSet];
  const disabledId = componentId(Disabled);
  if (!requiredIds.includes(disabledId) && !withoutIds.includes(disabledId)) {
    withoutIds.push(disabledId);
  }
  return ok({ descriptor, requiredIds, withoutIds, changedIds, addedIds, sparseRoute });
}

class QueryRowFacade<
  R extends readonly Component[],
  W extends readonly Component[],
  O extends readonly Component[],
> implements QueryRow<R, W, O>
{
  entity = 0 as EntityHandle;
  private archetype: Archetype | undefined;

  constructor(private readonly world: WorldQueryAccess) {}

  bind(entity: EntityHandle, archetype: Archetype): this {
    this.entity = entity;
    this.archetype = archetype;
    return this;
  }

  has(component: R[number] | W[number] | O[number]): boolean {
    const id = componentId(component);
    return this.archetype !== undefined && archetypeHasComponent(this.archetype, id);
  }

  get<C extends R[number]>(component: C): ReadonlyRowShape<C>;
  get<C extends O[number]>(component: C): ReadonlyRowShape<C> | undefined;
  get(component: Component): Record<string, unknown> | undefined {
    if (!this.has(component)) {
      return undefined;
    }
    // Live row bound to its current archetype: read the columns directly,
    // without the Result carrier of the identity-addressed World.get.
    const owner = this.world[worldInternal];
    const records = owner.records;
    const slot = entityIndex(this.entity);
    if (
      records.isLive(slot, entityGeneration(this.entity)) &&
      owner.graph.archetypes[records.archetypeId[slot] as number] === this.archetype
    ) {
      const archetype = this.archetype as Archetype;
      return owner.readRow(archetype, component, records.tableRow[slot] ?? -1);
    }
    const result = owner.getQueryRow(this.entity, component);
    if (!result.ok) throw result.error;
    return result.value;
  }

  mut<C extends W[number]>(component: C): MutableRowShape<C> {
    const current = this.get(component);
    if (current === undefined) throw new Error(`Query row lacks ${component.name}.`);
    if (isRelationshipTarget(component)) {
      throw createRelationshipTargetReadonlyError(component.name, 'query row');
    }
    // Relationship sources must let the owner validate before recording
    // authored evidence. A stale/cyclic target therefore has zero mutation
    // side effects, while ordinary components retain the existing eager
    // `mut()` evidence semantics.
    const relationshipSource = relationshipRole(component)?.kind === 'source';
    if (!relationshipSource) {
      this.world[worldInternal].markComponentChanged(this.entity, componentId(component));
    }
    return new Proxy(current, {
      set: (target, property, value) => {
        if (typeof property !== 'string') return false;
        const result = this.world[worldInternal].setQueryRow(this.entity, component, {
          [property]: value,
        });
        if (!result.ok) throw result.error;
        (target as Record<string, unknown>)[property] = value;
        return true;
      },
    }) as MutableRowShape<C>;
  }
}

class QuerySpanFacade<R extends readonly Component[], W extends readonly Component[]>
  implements QuerySpan<R, W>
{
  constructor(
    private readonly world: WorldQueryAccess,
    private readonly table: Table,
    readonly rowStart: number,
    readonly length: number,
  ) {}

  get tableId(): number {
    return this.table.id;
  }

  /** Derived on demand: a changed-row span rarely needs its identity window. */
  get entities(): Readonly<Uint32Array> {
    return columnWindow(
      this.table.entities,
      this.rowStart,
      this.rowStart + this.length,
      undefined,
      this.rowStart === 0 && this.length === this.table.size,
    ) as Uint32Array;
  }

  get<C extends R[number]>(component: C): ReadonlyColumnShape<C> {
    return buildColumnShape(
      this.table,
      component,
      this.rowStart,
      this.length,
    ) as ReadonlyColumnShape<C>;
  }

  mut<C extends W[number]>(component: C): MutableColumnShape<C> {
    // A span exposes live column storage. Relationship source and target
    // columns must never obtain that raw write capability: source writes need
    // target-side maintenance and target writes are engine-owned projections.
    if (relationshipRole(component) !== undefined) {
      throw createRelationshipTargetReadonlyError(component.name, 'query span');
    }
    this.world[worldInternal].markComponentRangeChanged(
      this.table,
      componentId(component),
      this.rowStart,
      this.length,
    );
    return buildColumnShape(
      this.table,
      component,
      this.rowStart,
      this.length,
    ) as MutableColumnShape<C>;
  }
}

function buildColumnShape(
  table: Table,
  component: Component,
  rowStart: number,
  rowCount: number,
): Record<string, FieldView | ManagedColumnReader<string>> {
  const shape: Record<string, FieldView | ManagedColumnReader<string>> = {};
  const fields = table.storage.get(componentId(component))?.fields;
  if (fields === undefined) return shape;
  const definition = componentDefinition(component);
  const schema = componentSchema(component);
  const fullTable = rowStart === 0 && rowCount === table.size;
  for (let index = 0; index < definition.fieldNames.length; index++) {
    const fieldName = definition.fieldNames[index] as string;
    const column = fields.get(fieldName);
    if (column === undefined) continue;
    const fieldType = schema[fieldName];
    const plan = column.layout;
    const managed =
      plan.kind === 'string' ||
      plan.kind === 'unique' ||
      plan.kind === 'shared' ||
      plan.kind === 'asset' ||
      ((plan.kind === 'array' || plan.kind === 'fixed-array') && plan.reference === 'asset')
        ? fieldType
        : undefined;
    const start = rowStart * plan.arity;
    shape[fieldName] = columnWindow(
      column,
      start,
      start + rowCount * plan.arity,
      managed,
      fullTable,
    );
  }
  return shape;
}

/** Scan the chunks whose maxima exceed `since`; a row qualifies when every
 * predicate column reads a changed epoch in `(since, upper]`. */
function scanChangedChunks(
  entities: ArrayLike<number>,
  size: number,
  columns: ReadonlyArray<ArrayLike<number>>,
  width: number,
  chunks: ArrayLike<number> | undefined,
  since: number,
  upper: number,
  candidates: Uint32Array,
  count: number,
): number {
  for (let start = 0, chunk = 0; start < size; start += CHANGE_CHUNK, chunk++) {
    if (chunks !== undefined && (chunks[chunk] as number) <= since) continue;
    const end = Math.min(size, start + CHANGE_CHUNK);
    for (let row = start; row < end; row++) {
      let lane = 0;
      for (; lane < width; lane++) {
        const epoch = (columns[lane] as Float64Array)[row] as number;
        if (epoch <= since || epoch > upper) break;
      }
      if (lane === width) candidates[count++] = entities[row] as number;
    }
  }
  return count;
}

class ExecutableQuery<
  R extends readonly Component[],
  W extends readonly Component[],
  O extends readonly Component[],
> implements Query<R, W, O>
{
  private readonly matchedArchetypes: ArchetypeId[];
  private readonly matchedTables: Table[];
  private readonly compiled: CompiledDescriptor<R, W, O>;
  private readonly temporal: boolean;
  private lastObservedEpoch = 0;
  private active = false;
  private rowVisitor:
    | (Iterator<QueryRow<R, W, O>> & { reset(): void; return(): IteratorResult<QueryRow<R, W, O>> })
    | undefined;
  private spansResult: Result<Iterable<QuerySpan<R, W>>, QuerySpanUnavailableError> | undefined;
  private batchesResult:
    | Result<Iterable<QueryBatch<R, W, O>>, QueryBatchUnavailableError>
    | undefined;

  constructor(
    private readonly world: WorldQueryAccess,
    private readonly matches: QueryMatches,
  ) {
    this.compiled = matches.compiled as unknown as CompiledDescriptor<R, W, O>;
    this.matchedArchetypes = matches.matchedArchetypes;
    this.matchedTables = matches.matchedTables;
    this.temporal = this.compiled.changedIds.length > 0 || this.compiled.addedIds.length > 0;
  }

  [Symbol.iterator](): Iterator<QueryRow<R, W, O>> {
    return new ExecutableQuery.RowIterator(this);
  }

  [QUERY_ITERATING](): boolean {
    return this.active;
  }

  forEach(visit: (row: QueryRow<R, W, O>) => void): void {
    let cursor = this.rowVisitor;
    if (cursor === undefined) cursor = this.rowVisitor = new ExecutableQuery.RowIterator(this);
    else cursor.reset();
    try {
      for (let step = cursor.next(); !step.done; step = cursor.next()) visit(step.value);
    } finally {
      cursor.return();
    }
  }

  /** Shared observation state for row and span cursors. */
  private static readonly Iteration = class<
    R extends readonly Component[],
    W extends readonly Component[],
    O extends readonly Component[],
  > {
    protected readonly owner: WorldInternal;
    protected structureEpoch = 0;
    protected upperBound = 0;
    protected finished = false;

    constructor(protected readonly query: ExecutableQuery<R, W, O>) {
      this.owner = query.world[worldInternal];
    }

    protected start(): ChangedEntities | undefined {
      this.query.beginIteration();
      this.structureEpoch = this.owner.getStructureEpoch();
      this.upperBound = this.owner.getMutationEpoch();
      const changed = this.query.changedEntityCandidates(this.upperBound);
      if (changed === undefined) this.query.refreshMatches();
      this.finished = false;
      return changed;
    }

    protected close(commit: boolean): void {
      if (this.finished) return;
      this.finished = true;
      this.query.endIteration(commit ? this.upperBound : undefined);
    }

    protected assertReadable(): void {
      try {
        this.query.assertIterationReadable(this.structureEpoch);
      } catch (cause) {
        this.close(false);
        throw cause;
      }
    }

    protected needsChangeRecheck(): boolean {
      return (
        this.owner.getMutationEpoch() !== this.upperBound &&
        this.query.hasFutureChangedInput(this.upperBound)
      );
    }
  };

  /** Independent iteration state; detached next/return callbacks retain their own cursor. */
  private static readonly RowIterator = class<
      R extends readonly Component[],
      W extends readonly Component[],
      O extends readonly Component[],
    >
    extends ExecutableQuery.Iteration<R, W, O>
    implements Iterator<QueryRow<R, W, O>>
  {
    private changed: ChangedEntities | undefined;
    private changedIndex = 0;
    private readonly row: QueryRowFacade<R, W, O>;
    private readonly step: IteratorYieldResult<QueryRow<R, W, O>>;
    private archetypeIndex = 0;
    private tableIndex = 0;
    private rowIndex = 0;
    constructor(query: ExecutableQuery<R, W, O>) {
      super(query);
      this.row = new QueryRowFacade<R, W, O>(query.world);
      this.step = { done: false, value: this.row };
      this.reset();
    }

    reset(): void {
      this.changed = this.start();
      this.changedIndex = this.rowIndex = 0;
      const unchanged = this.query.hasUnchangedInput();
      this.archetypeIndex = unchanged ? this.query.matchedArchetypes.length : 0;
      this.tableIndex = unchanged ? this.query.matchedTables.length : 0;
    }

    readonly next = (): IteratorResult<QueryRow<R, W, O>> => {
      if (this.finished) return QUERY_DONE;
      if (this.query.temporal || this.owner.getStructureEpoch() !== this.structureEpoch)
        this.assertReadable();
      if (this.changed !== undefined) return this.nextChanged(this.changed);
      return this.query.compiled.sparseRoute ? this.nextSparse() : this.nextDense();
    };

    private nextChanged(changed: ChangedEntities): IteratorResult<QueryRow<R, W, O>> {
      const recheck = this.needsChangeRecheck();
      while (this.changedIndex < changed.length) {
        const entity = changed[this.changedIndex++] as EntityHandle;
        const archetype = this.owner.getEntityArchetype(entity);
        if (archetype === undefined) continue;
        const records = this.owner.records;
        const tableRow = records.tableRow[entityIndex(entity)] ?? -1;
        if (
          recheck &&
          !this.query.changeMatches(entity, archetype.table, tableRow, this.upperBound)
        )
          continue;
        this.step.value = this.row.bind(entity, archetype);
        return this.step;
      }
      this.close(true);
      return QUERY_DONE;
    }

    private nextDense(): IteratorResult<QueryRow<R, W, O>> {
      while (this.tableIndex < this.query.matchedTables.length) {
        const table = this.query.matchedTables[this.tableIndex];
        if (table === undefined || this.rowIndex >= table.size) {
          this.tableIndex += 1;
          this.rowIndex = 0;
          continue;
        }
        const currentTableRow = this.rowIndex++;
        const entity = (table.entities.view[currentTableRow] ?? 0) as EntityHandle;
        if (
          this.query.temporal &&
          !this.query.changeMatches(entity, table, currentTableRow, this.upperBound)
        )
          continue;
        const recordArchetype = this.owner.getEntityArchetype(entity);
        if (recordArchetype === undefined) continue;
        this.step.value = this.row.bind(entity, recordArchetype);
        return this.step;
      }
      this.close(true);
      return QUERY_DONE;
    }

    private nextSparse(): IteratorResult<QueryRow<R, W, O>> {
      while (this.archetypeIndex < this.query.matchedArchetypes.length) {
        const archetype =
          this.owner.graph.archetypes[this.query.matchedArchetypes[this.archetypeIndex] ?? -1];
        if (archetype === undefined || this.rowIndex >= archetype.size) {
          this.archetypeIndex += 1;
          this.rowIndex = 0;
          continue;
        }
        const currentArchetypeRow = this.rowIndex++;
        const currentTableRow = archetype.rows[currentArchetypeRow] ?? 0;
        const table = archetype.table;
        const entity = (table.entities.view[currentTableRow] ?? 0) as EntityHandle;
        if (
          this.query.temporal &&
          !this.query.changeMatches(entity, table, currentTableRow, this.upperBound)
        )
          continue;
        this.step.value = this.row.bind(entity, archetype);
        return this.step;
      }
      this.close(true);
      return QUERY_DONE;
    }

    readonly return = (): IteratorResult<QueryRow<R, W, O>> => {
      this.close(false);
      return QUERY_DONE;
    };
  };

  private matchingArchetype(entity: EntityHandle): Archetype | undefined {
    const archetype = this.world[worldInternal].getEntityArchetype(entity);
    return archetype !== undefined && this.archetypeMatches(archetype) ? archetype : undefined;
  }

  at(entity: EntityHandle): QueryRow<R, W, O> | undefined {
    const archetype = this.matchingArchetype(entity);
    return archetype === undefined
      ? undefined
      : new QueryRowFacade<R, W, O>(this.world).bind(entity, archetype);
  }

  forEachAt(entities: Iterable<EntityHandle>, visit: (row: QueryRow<R, W, O>) => void): void {
    const row = new QueryRowFacade<R, W, O>(this.world);
    for (const entity of entities) {
      const archetype = this.matchingArchetype(entity);
      if (archetype !== undefined) visit(row.bind(entity, archetype));
    }
  }

  markObserved(): void {
    // A completed drain commits the mutation epoch captured when it began; with
    // no row visited in between that is the epoch at this call.
    this.beginIteration();
    this.endIteration(this.world[worldInternal].getMutationEpoch());
  }

  private static readonly SpanIterator = class<
      R extends readonly Component[],
      W extends readonly Component[],
      O extends readonly Component[],
    >
    extends ExecutableQuery.Iteration<R, W, O>
    implements Iterator<QuerySpan<R, W>>
  {
    private readonly changed: ChangedEntities | undefined;
    private tableIndex = 0;
    private changedIndex = 0;
    private advanceCallback: (() => IteratorResult<QuerySpan<R, W>>) | undefined;
    private finishCallback: (() => IteratorResult<QuerySpan<R, W>>) | undefined;

    constructor(query: ExecutableQuery<R, W, O>) {
      super(query);
      this.changed = this.start();
    }

    // Callbacks stay detached capabilities. The ordinary completion path does
    // not create an unused early-close callback or a separate close closure.
    get next(): () => IteratorResult<QuerySpan<R, W>> {
      this.advanceCallback ??= this.advance.bind(this);
      return this.advanceCallback;
    }

    get return(): () => IteratorResult<QuerySpan<R, W>> {
      this.finishCallback ??= this.finish.bind(this);
      return this.finishCallback;
    }

    private finish(): IteratorResult<QuerySpan<R, W>> {
      this.close(false);
      return QUERY_DONE;
    }

    private advance(): IteratorResult<QuerySpan<R, W>> {
      if (this.finished) return QUERY_DONE;
      this.assertReadable();
      if (this.changed !== undefined) return this.nextChanged(this.changed);
      while (this.tableIndex < this.query.matchedTables.length) {
        const table = this.query.matchedTables[this.tableIndex++];
        if (table === undefined || table.size === 0) continue;
        return {
          done: false,
          value: new QuerySpanFacade<R, W>(this.query.world, table, 0, table.size),
        };
      }

      this.close(true);
      return QUERY_DONE;
    }

    private nextChanged(changed: ChangedEntities): IteratorResult<QuerySpan<R, W>> {
      const recheck = this.needsChangeRecheck();
      while (this.changedIndex < changed.length) {
        const entity = changed[this.changedIndex++] as EntityHandle;
        const records = this.owner.records;
        const slot = entityIndex(entity);
        const archetype = this.owner.graph.archetypes[records.archetypeId[slot] ?? -1];
        const table = archetype?.table;
        const start = records.tableRow[slot] ?? -1;
        if (
          table === undefined ||
          (recheck && !this.query.changeMatches(entity, table, start, this.upperBound))
        )
          continue;
        let count = 1;
        while (this.changedIndex < changed.length) {
          const next = changed[this.changedIndex] as EntityHandle;
          const nextSlot = entityIndex(next);
          const nextArchetype = this.owner.graph.archetypes[records.archetypeId[nextSlot] ?? -1];
          const nextRow = records.tableRow[nextSlot] ?? -1;
          if (
            nextArchetype?.table !== table ||
            nextRow !== start + count ||
            (recheck && !this.query.changeMatches(next, table, nextRow, this.upperBound))
          )
            break;
          this.changedIndex++;
          count++;
        }
        return {
          done: false,
          value: new QuerySpanFacade<R, W>(this.query.world, table, start, count),
        };
      }
      this.close(true);
      return QUERY_DONE;
    }
  };

  spans(): Result<Iterable<QuerySpan<R, W>>, QuerySpanUnavailableError> {
    if (this.spansResult !== undefined) return this.spansResult;
    const reason = this.spanUnavailableReason();
    if (reason !== undefined) return err(createQuerySpanUnavailableError(reason));
    const query = this;
    this.spansResult = ok({
      [Symbol.iterator](): Iterator<QuerySpan<R, W>> {
        return new ExecutableQuery.SpanIterator(query);
      },
    });
    return this.spansResult;
  }

  batches(): Result<Iterable<QueryBatch<R, W, O>>, QueryBatchUnavailableError> {
    if (this.batchesResult !== undefined) return this.batchesResult;
    const descriptor = this.compiled.descriptor;
    if ((descriptor.write?.length ?? 0) > 0) {
      this.batchesResult = err(new QueryBatchUnavailableError('write-access'));
    } else if (this.temporal) {
      this.batchesResult = err(new QueryBatchUnavailableError('temporal-filter'));
    } else {
      const lease: BatchLease = {
        structureEpoch: 0,
        active: false,
        generation: 0,
        assertReadable: () => this.assertIterationReadable(lease.structureEpoch, true),
      };
      this.batchesResult = ok({ [Symbol.iterator]: () => this.batchIterator(lease) });
    }
    return this.batchesResult;
  }

  private batchIterator(lease: BatchLease): Iterator<QueryBatch<R, W, O>> {
    const owner = this.world[worldInternal];
    const epoch = owner.getStructureEpoch();
    this.assertIterationReadable(epoch, true);
    this.beginIteration();
    lease.structureEpoch = epoch;
    lease.active = true;
    lease.generation++;
    const upper = owner.getMutationEpoch();
    const descriptor = this.compiled.descriptor;
    const matches = this.compiled.sparseRoute ? this.matchedArchetypes : this.matchedTables;
    let index = 0;
    let finished = false;
    const close = (observed?: number): IteratorResult<QueryBatch<R, W, O>> => {
      if (!finished) {
        finished = true;
        lease.active = false;
        this.endIteration(observed);
      }
      return QUERY_DONE;
    };
    return {
      next: () => {
        if (finished) return QUERY_DONE;
        try {
          lease.assertReadable();
          if (index === 0) this.refreshMatches();
          while (index < matches.length) {
            const match = matches[index++];
            if (typeof match === 'number') {
              const arch = owner.graph.archetypes[match];
              if (arch === undefined || arch.size === 0) continue;
              lease.generation++;
              return {
                done: false,
                value: new IndexedBatch(arch.table, descriptor, lease, arch.rows, arch.size),
              };
            }
            if (match === undefined || match.size === 0) continue;
            lease.generation++;
            return { done: false, value: new RangeBatch(match, descriptor, lease, 0, match.size) };
          }
          return close(upper);
        } catch (cause) {
          close();
          throw cause;
        }
      },
      return: () => close(),
    };
  }

  [DERIVED_WRITER]<C extends W[number]>(
    component: C,
  ): Result<DerivedRangeWriter<R[number], C>, QuerySpanUnavailableError> {
    const reason = this.spanUnavailableReason();
    if (reason !== undefined) return err(createQuerySpanUnavailableError(reason));
    return ok(
      createDerivedRangeWriter<R[number], C>(
        this.world as unknown as import('../world').World,
        component,
        {
          tables: () => {
            this.refreshMatches();
            return this.matchedTables;
          },
          readComponents: this.compiled.descriptor.read ?? [],
          writeComponents: this.compiled.descriptor.write ?? [],
        },
      ),
    );
  }

  /**
   * One candidate buffer per query: an iteration only begins after the
   * previous one closed (`beginIteration`), so the buffer is never shared.
   * A typed buffer with its own count: truncating a JS array frees its
   * backing store, so every frame would regrow it.
   */
  // Allocated on the first change scan: structural queries never use them.
  private candidates: Uint32Array = NO_CANDIDATES;
  private candidateCount = 0;
  private readonly probeColumns: Float64Array[] = [];

  /**
   * Changed identities in physical order, or `undefined` when the iteration
   * must walk matched archetypes and test each row (sparse routes).
   */
  private changedEntityCandidates(upper: number): ChangedEntities | undefined {
    const primary = this.compiled.changedIds[0] ?? this.compiled.addedIds[0];
    if (primary === undefined || this.compiled.sparseRoute) return undefined;
    this.candidateCount = 0;
    if (this.hasUnchangedInput()) return NO_CHANGED_ENTITIES;
    this.collectMatchedRows(upper);
    return this.candidates.subarray(0, this.candidateCount) as ChangedEntities;
  }

  /**
   * Probe matched table rows. The primary changed column's chunk maxima skip
   * whole tables and 64-row chunks no write reached since the last observed
   * epoch; a chunk maximum never under-reports, so skipping is exact.
   */
  private collectMatchedRows(upper: number): void {
    this.refreshMatches();
    const tables = this.matchedTables;
    const changedIds = this.compiled.changedIds;
    const addedIds = this.compiled.addedIds;
    const since = this.lastObservedEpoch;
    let rows = 0;
    for (let index = 0; index < tables.length; index++) rows += (tables[index] as Table).size;
    if (this.candidates.length < rows)
      this.candidates = new Uint32Array(Math.max(64, rows, this.candidates.length * 2));
    const columns = this.probeColumns;
    const candidates = this.candidates;
    let count = 0;
    for (let index = 0; index < tables.length; index++) {
      const table = tables[index] as Table;
      const entities = table.entities.view;
      const size = table.size;
      // Dense table matches require each component in both temporal roles.
      let width = 0;
      let primary: TableComponentStorage | undefined;
      for (let id = 0; id < changedIds.length; id++) {
        const storage = table.storage.get(changedIds[id] as ComponentId) as TableComponentStorage;
        primary ??= storage;
        columns[width++] = storage.changed.epochs;
      }
      for (let id = 0; id < addedIds.length; id++)
        columns[width++] = (
          table.storage.get(addedIds[id] as ComponentId) as TableComponentStorage
        ).added;
      if (primary !== undefined && primary.changed.max <= since) continue;
      count = scanChangedChunks(
        entities,
        size,
        columns,
        width,
        primary?.changed.chunks,
        since,
        upper,
        candidates,
        count,
      );
    }
    this.candidateCount = count;
  }

  private hasUnchangedInput(): boolean {
    const epochs = this.world[worldInternal].componentMutationEpochs;
    // Changed predicates are conjunctive. One unchanged input proves the
    // entire result empty without consulting any entity or table row.
    const changedIds = this.compiled.changedIds;
    for (let index = 0; index < changedIds.length; index++)
      if ((epochs[changedIds[index] as ComponentId] ?? 0) <= this.lastObservedEpoch) return true;
    return false;
  }

  /** Called after health/derived/structure fences. Added facts are unchanged
   * under that structure fence; unrelated value writes need no revalidation. */
  private hasFutureChangedInput(upper: number): boolean {
    const ids = this.compiled.changedIds;
    const epochs = this.world[worldInternal].componentMutationEpochs;
    for (let index = 0; index < ids.length; index++)
      if ((epochs[ids[index] as ComponentId] ?? 0) > upper) return true;
    return false;
  }

  private assertReadableChanges(): void {
    if (this.temporal) {
      const error = this.worldReadError();
      if (error !== undefined) throw error;
    }
  }

  private worldReadError() {
    return this.world[worldInternal].isDerivedWriteActive()
      ? new DerivedWriteActiveError()
      : worldPoisonedError(this.world.execution);
  }

  private iterationError(epoch: number, strict = false) {
    const error = strict || this.temporal ? this.worldReadError() : undefined;
    if (error !== undefined) return error;
    const current = this.world[worldInternal].getStructureEpoch();
    return current === epoch ? undefined : createQueryIterationInvalidatedError(epoch, current);
  }

  private assertIterationReadable(epoch: number, strict = false): void {
    const error = this.iterationError(epoch, strict);
    if (error !== undefined) throw error;
  }

  private endIteration(observed?: number): void {
    this.active = false;
    if (observed !== undefined) {
      this.assertReadableChanges();
      this.lastObservedEpoch = observed;
    }
  }

  private beginIteration(): void {
    this.assertReadableChanges();
    if (this.active) throw new QueryIterationActiveError();
    this.active = true;
  }

  private refreshMatches(): void {
    const graph = this.world[worldInternal].graph;
    // A World's storage rosters only append; membership changes mutate rows
    // within those same owners. Match each new owner once, on the route this
    // query consumes, and keep empty matches for later row repopulation. Every
    // query with the same descriptor content shares this monotonic roster.
    const matches = this.matches;
    if (this.compiled.sparseRoute) {
      for (; matches.scannedStorageCount < graph.archetypes.length; matches.scannedStorageCount++) {
        const archetype = graph.archetypes[matches.scannedStorageCount];
        if (archetype !== undefined && this.archetypeMatches(archetype)) {
          this.matchedArchetypes.push(archetype.id);
        }
      }
    } else {
      for (; matches.scannedStorageCount < graph.tables.length; matches.scannedStorageCount++) {
        const table = graph.tables[matches.scannedStorageCount];
        if (table !== undefined && this.tableMatches(table)) this.matchedTables.push(table);
      }
    }
  }

  // Indexed loops: these run per candidate row on change-filtered iteration,
  // where for-of would allocate an array iterator per call when not inlined.
  private archetypeMatches(archetype: Archetype): boolean {
    const requiredIds = this.compiled.requiredIds;
    for (let index = 0; index < requiredIds.length; index++)
      if (!archetypeHasComponent(archetype, requiredIds[index] as ComponentId)) return false;
    const withoutIds = this.compiled.withoutIds;
    for (let index = 0; index < withoutIds.length; index++)
      if (archetypeHasComponent(archetype, withoutIds[index] as ComponentId)) return false;
    return true;
  }

  private tableMatches(table: Table): boolean {
    const requiredIds = this.compiled.requiredIds;
    for (let index = 0; index < requiredIds.length; index++)
      if (!table.storage.has(requiredIds[index] as ComponentId)) return false;
    const withoutIds = this.compiled.withoutIds;
    for (let index = 0; index < withoutIds.length; index++)
      if (table.storage.has(withoutIds[index] as ComponentId)) return false;
    return true;
  }

  /** Changed epoch of one input on a row: its table column, or its sparse tag set. */
  private changedEpoch(
    entity: EntityHandle,
    table: Table,
    row: number,
    componentId: ComponentId,
  ): number {
    const column = table.storage.get(componentId)?.changed;
    if (column !== undefined) return column.epochs[row] ?? 0;
    const owner = this.world[worldInternal];
    return readComponentChanged(owner.graph, owner.records, entityIndex(entity), componentId) ?? 0;
  }

  private changeMatches(
    entity: EntityHandle,
    table: Table,
    row: number,
    upperBound: number,
  ): boolean {
    const changedIds = this.compiled.changedIds;
    for (let index = 0; index < changedIds.length; index++) {
      const epoch = this.changedEpoch(entity, table, row, changedIds[index] as ComponentId);
      if (epoch <= this.lastObservedEpoch || epoch > upperBound) return false;
    }
    const addedIds = this.compiled.addedIds;
    for (let index = 0; index < addedIds.length; index++) {
      const componentId = addedIds[index] as ComponentId;
      const epoch =
        table.storage.get(componentId)?.added[row] ?? this.sparseAddedEpoch(componentId, entity);
      if (epoch <= this.lastObservedEpoch || epoch > upperBound) return false;
    }
    return true;
  }

  private sparseAddedEpoch(componentId: ComponentId, entity: EntityHandle): number {
    const set = this.world[worldInternal].graph.sparseTags.get(componentId);
    return set?.added[sparseTagIndex(set, entity)] ?? 0;
  }

  private spanUnavailableReason(): QuerySpanUnavailableReason | undefined {
    if (this.compiled.sparseRoute) return 'sparse-component';
    if ((this.compiled.descriptor.optional?.length ?? 0) > 0) return 'optional-data';
    // A writable relationship source would bypass the source owner (and its
    // materialized target/backpointer), while a target is an ECS-owned
    // projection. Keep read-only relationship inputs usable by Scene's
    // derived writer; only the descriptor's writable role is ineligible.
    if ((this.compiled.descriptor.write ?? []).some((component) => relationshipRole(component))) {
      return 'relationship-component';
    }
    return undefined;
  }
}

export function createQuery<
  const R extends readonly Component[] = readonly [],
  const W extends readonly Component[] = readonly [],
  const O extends readonly Component[] = readonly [],
>(
  world: WorldQueryAccess,
  descriptor: QueryDescriptor<R, W, O>,
): Result<Query<R, W, O>, QueryCreationError> {
  const matches = sharedQueryMatches(world, descriptor);
  if (!matches.ok) return matches;
  return ok(new ExecutableQuery<R, W, O>(world, matches.value));
}

/**
 * Compiled descriptor plus its append-only storage match roster. Matching is
 * purely structural, so every query of one World with the same descriptor
 * content shares one instance; cursors, change epochs and the iteration guard
 * remain per query. Per-frame `world.query(...)` calls therefore neither
 * recompile nor rescan the storage roster.
 */
class QueryMatches {
  readonly matchedArchetypes: ArchetypeId[] = [];
  readonly matchedTables: Table[] = [];
  scannedStorageCount = 0;
  constructor(readonly compiled: CompiledDescriptor<Component[], Component[], Component[]>) {}
}

const sharedMatches = new WeakMap<WorldInternal, Map<number, QueryMatches[]>>();

// Allocation-free content key; equal hashes are confirmed by `sameDescriptor`.
function descriptorHash(
  descriptor: QueryDescriptor<Component[], Component[], Component[]>,
): number {
  let hash = 0x811c9dc5;
  for (let role = 0; role < DESCRIPTOR_ROLES.length; role++) {
    const components = descriptor[DESCRIPTOR_ROLES[role] as (typeof DESCRIPTOR_ROLES)[number]];
    hash = Math.imul(hash ^ (role + 1), 16777619);
    if (components === undefined) continue;
    for (let index = 0; index < components.length; index++) {
      const id = registeredComponentId(components[index] as Component);
      hash = Math.imul(hash ^ (id === undefined ? 0x7fffffff : id + 2), 16777619);
    }
  }
  return hash >>> 0;
}

function sameDescriptor(
  left: QueryDescriptor<Component[], Component[], Component[]>,
  right: QueryDescriptor<Component[], Component[], Component[]>,
): boolean {
  for (let role = 0; role < DESCRIPTOR_ROLES.length; role++) {
    const key = DESCRIPTOR_ROLES[role] as (typeof DESCRIPTOR_ROLES)[number];
    const a = left[key];
    const b = right[key];
    const length = a?.length ?? 0;
    if (length !== (b?.length ?? 0)) return false;
    for (let index = 0; index < length; index++)
      if ((a as readonly Component[])[index] !== (b as readonly Component[])[index]) return false;
  }
  return true;
}

function sharedQueryMatches(
  world: WorldQueryAccess,
  descriptor: QueryDescriptor<readonly Component[], readonly Component[], readonly Component[]>,
): Result<QueryMatches, QueryCreationError> {
  const plain = descriptor as QueryDescriptor<Component[], Component[], Component[]>;
  const owner = world[worldInternal];
  let byHash = sharedMatches.get(owner);
  if (byHash === undefined) {
    byHash = new Map();
    sharedMatches.set(owner, byHash);
  }
  const hash = descriptorHash(plain);
  const bucket = byHash.get(hash);
  if (bucket !== undefined) {
    for (let index = 0; index < bucket.length; index++) {
      const candidate = bucket[index] as QueryMatches;
      if (sameDescriptor(candidate.compiled.descriptor, plain)) return ok(candidate);
    }
  }
  const compiled = compileDescriptor(plain);
  if (!compiled.ok) return compiled;
  const matches = new QueryMatches(compiled.value);
  if (bucket === undefined) byHash.set(hash, [matches]);
  else bucket.push(matches);
  return ok(matches);
}
