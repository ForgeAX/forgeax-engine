import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type Component,
  type ComponentId,
  type ComponentSchema,
  componentDefinition,
  componentId,
  componentSchema,
  isManagedField,
  registeredComponentId,
  type ShapeOf,
  type TypedArrayFor,
} from '../component';
import { Disabled } from '../entity';
import { type EntityHandle, encodeEntity, entityGeneration, entityIndex } from '../entity-handle';
import {
  DerivedWriteActiveError,
  QueryDataRequiresFieldsError,
  QueryDescriptorConflictError,
  QueryIterationActiveError,
  QueryIterationInvalidatedError,
  QuerySpanUnavailableError,
  type QuerySpanUnavailableReason,
  RelationshipTargetReadonlyError,
} from '../errors';
import { QueryBatchUnavailableError } from '../errors/query-batch-errors';
import { worldPoisonedError } from '../errors/shared-kernel-errors';
import type { WorldExecutionState } from '../execution/shared-kernel';
import { DERIVED_WRITER, QUERY_ITERATING } from '../internal';
import { isRelationshipTarget, relationshipRole } from '../relationship-index';
import { type Archetype, type ArchetypeId, archetypeHasComponent } from '../storage/archetype';
import { sparseTagIndex } from '../storage/change-detection';
import {
  type Column,
  columnWindow,
  type FieldView,
  type ManagedColumnReader,
} from '../storage/column';
import type { Table } from '../storage/table';
import { type WorldInternal, worldInternal } from '../world-internal';
import { type BatchLease, IndexedBatch, type QueryBatch, RangeBatch } from './batch';
import { type ChangedEntities, ChangedEntityOrder } from './change-order';
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
  spans(): Result<Iterable<QuerySpan<R, W>>, QuerySpanUnavailableError>;
  /** Borrow physical numeric columns with an explicit range or sparse row index. Read-only, non-temporal descriptors. */
  batches(): Result<Iterable<QueryBatch<R, W, O>>, QueryBatchUnavailableError>;
  combinations(k?: number): Iterable<readonly QueryRow<R, W, O>[]>;
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
const NO_CHANGED_ENTITIES = new Uint32Array(0) as ChangedEntities;
const NO_CANDIDATES = new Uint32Array(0);
const QUERY_DONE: IteratorReturnResult<undefined> = Object.freeze({
  done: true,
  value: undefined,
});

const ACCESS_ROLES = ['read', 'write', 'optional', 'with', 'without'] as const;
const TEMPORAL_ROLES = ['changed', 'added'] as const;
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
      return err(new QueryDescriptorConflictError(component.name, role));
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
      return err(new QueryDataRequiresFieldsError(component.name));
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
    const records = owner.getRecords();
    const slot = entityIndex(this.entity);
    if (
      records.isLive(slot, entityGeneration(this.entity)) &&
      owner.getGraph().archetypes[records.archetypeId[slot] as number] === this.archetype
    ) {
      const archetype = this.archetype as Archetype;
      return owner.readRow(
        archetype,
        component,
        archetype.rows[records.archetypeRow[slot] as number] ?? -1,
      );
    }
    const result = owner.getQueryRow(this.entity, component);
    if (!result.ok) throw result.error;
    return result.value;
  }

  mut<C extends W[number]>(component: C): MutableRowShape<C> {
    const current = this.get(component);
    if (current === undefined) throw new Error(`Query row lacks ${component.name}.`);
    if (isRelationshipTarget(component)) {
      throw new RelationshipTargetReadonlyError(component.name, 'query row');
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
    private readonly rowStart: number,
    readonly length: number,
  ) {}

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
      throw new RelationshipTargetReadonlyError(component.name, 'query span');
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
    appendColumnShape(shape, fieldName, column, fieldType, rowStart, rowCount, fullTable);
    const countField = column.countField;
    if (countField !== undefined) {
      const countColumn = fields.get(countField);
      if (countColumn !== undefined)
        appendColumnShape(shape, countField, countColumn, fieldType, rowStart, rowCount, fullTable);
    }
  }
  return shape;
}

/** The declared field and its optional sidecar share the same managed access rule. */
function appendColumnShape(
  shape: Record<string, FieldView | ManagedColumnReader<string>>,
  name: string,
  column: Column,
  fieldType: ComponentSchema[string] | undefined,
  rowStart: number,
  rowCount: number,
  fullTable: boolean,
): void {
  const managed =
    fieldType !== undefined && (isManagedField(fieldType) || fieldType.startsWith('array<asset<'))
      ? fieldType
      : undefined;
  const start = rowStart * column.arity;
  shape[name] = columnWindow(column, start, start + rowCount * column.arity, managed, fullTable);
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
  private lastObservedEpoch = 0;
  private active = false;
  private rowVisitor:
    | (Iterator<QueryRow<R, W, O>> & { reset(): void; return(): IteratorResult<QueryRow<R, W, O>> })
    | undefined;
  private spansResult: Result<Iterable<QuerySpan<R, W>>, QuerySpanUnavailableError> | undefined;
  private changedOrder: ChangedEntityOrder | undefined;
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
  }

  [Symbol.iterator](): Iterator<QueryRow<R, W, O>> {
    return this.rowIterator(false);
  }

  [QUERY_ITERATING](): boolean {
    return this.active;
  }

  forEach(visit: (row: QueryRow<R, W, O>) => void): void {
    let cursor = this.rowVisitor;
    if (cursor === undefined)
      cursor = this.rowVisitor = new ExecutableQuery.RowIterator(this, false);
    else cursor.reset();
    try {
      for (let step = cursor.next(); !step.done; step = cursor.next()) visit(step.value);
    } finally {
      cursor.return();
    }
  }

  /** Independent iteration state; detached next/return callbacks retain their own cursor. */
  private static readonly RowIterator = class<
    R extends readonly Component[],
    W extends readonly Component[],
    O extends readonly Component[],
  > implements Iterator<QueryRow<R, W, O>>
  {
    private structureEpoch = 0;
    private upperBound = 0;
    private changed: ChangedEntities | undefined;
    private changedIndex = 0;
    private readonly row: QueryRowFacade<R, W, O> | undefined;
    private readonly step: IteratorYieldResult<QueryRow<R, W, O>>;
    private archetypeIndex = 0;
    private tableIndex = 0;
    private rowIndex = 0;
    private finished = false;

    constructor(
      private readonly query: ExecutableQuery<R, W, O>,
      ownedRows: boolean,
    ) {
      this.row = ownedRows ? undefined : new QueryRowFacade<R, W, O>(query.world);
      this.step = { done: false, value: this.row as QueryRow<R, W, O> };
      this.reset();
    }

    reset(): void {
      this.query.beginIteration();
      this.structureEpoch = this.query.world[worldInternal].getStructureEpoch();
      this.upperBound = this.query.world[worldInternal].getMutationEpoch();
      this.changed = this.query.changedEntityCandidates(this.upperBound);
      if (this.changed === undefined) this.query.refreshMatches();
      this.changedIndex = this.rowIndex = 0;
      this.finished = false;
      const unchanged = this.query.hasUnchangedInput();
      this.archetypeIndex = unchanged ? this.query.matchedArchetypes.length : 0;
      this.tableIndex = unchanged ? this.query.matchedTables.length : 0;
    }

    private close(commit: boolean): void {
      if (this.finished) return;
      this.finished = true;
      this.query.active = false;
      if (commit) {
        this.query.assertReadableChanges();
        this.query.lastObservedEpoch = this.upperBound;
      }
    }

    readonly next = (): IteratorResult<QueryRow<R, W, O>> => {
      if (this.finished) return QUERY_DONE;
      try {
        this.query.assertReadableChanges();
      } catch (cause) {
        this.close(false);
        throw cause;
      }
      if (this.query.world[worldInternal].getStructureEpoch() !== this.structureEpoch) {
        this.close(false);
        throw new QueryIterationInvalidatedError(
          this.structureEpoch,
          this.query.world[worldInternal].getStructureEpoch(),
        );
      }
      if (this.changed !== undefined) return this.nextChanged(this.changed);
      return this.query.compiled.sparseRoute ? this.nextSparse() : this.nextDense();
    };

    private nextChanged(changed: ChangedEntities): IteratorResult<QueryRow<R, W, O>> {
      const current =
        this.query.world[worldInternal].getMutationEpoch() === this.upperBound ||
        !this.query.hasFutureChangedInput(this.upperBound);
      while (this.changedIndex < changed.length) {
        const entity = changed[this.changedIndex++] as EntityHandle;
        const archetype = this.query.world[worldInternal].getEntityArchetype(entity);
        if (archetype === undefined) continue;
        const records = this.query.world[worldInternal].getRecords();
        const tableRow = archetype.rows[records.archetypeRow[entityIndex(entity)] ?? -1] ?? -1;
        const table = this.query.world[worldInternal].getGraph().tables[archetype.tableId];
        if (
          table === undefined ||
          (!current && !this.query.changeMatches(entity, table, tableRow, this.upperBound))
        )
          continue;
        this.step.value = this.query.bindRow(entity, archetype, this.row);
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
        if (!this.query.changeMatches(entity, table, currentTableRow, this.upperBound)) continue;
        const recordArchetype = this.query.world[worldInternal].getEntityArchetype(entity);
        if (recordArchetype === undefined) continue;
        this.step.value = this.query.bindRow(entity, recordArchetype, this.row);
        return this.step;
      }
      this.close(true);
      return QUERY_DONE;
    }

    private nextSparse(): IteratorResult<QueryRow<R, W, O>> {
      while (this.archetypeIndex < this.query.matchedArchetypes.length) {
        const archetype =
          this.query.world[worldInternal].getGraph().archetypes[
            this.query.matchedArchetypes[this.archetypeIndex] ?? -1
          ];
        if (archetype === undefined || this.rowIndex >= archetype.size) {
          this.archetypeIndex += 1;
          this.rowIndex = 0;
          continue;
        }
        const currentArchetypeRow = this.rowIndex++;
        const currentTableRow = archetype.rows[currentArchetypeRow] ?? 0;
        const table = this.query.world[worldInternal].getGraph().tables[archetype.tableId];
        if (table === undefined) continue;
        const entity = (table.entities.view[currentTableRow] ?? 0) as EntityHandle;
        if (!this.query.changeMatches(entity, table, currentTableRow, this.upperBound)) continue;
        this.step.value = this.query.bindRow(entity, archetype, this.row);
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

  /** Shared matching and observation; combinations owns each returned facade. */
  private rowIterator(ownedRows: boolean): Iterator<QueryRow<R, W, O>> {
    return new ExecutableQuery.RowIterator(this, ownedRows);
  }

  private bindRow(
    entity: EntityHandle,
    archetype: Archetype,
    borrowed: QueryRowFacade<R, W, O> | undefined,
  ): QueryRow<R, W, O> {
    return (borrowed ?? new QueryRowFacade<R, W, O>(this.world)).bind(entity, archetype);
  }

  at(entity: EntityHandle): QueryRow<R, W, O> | undefined {
    const archetype = this.world[worldInternal].getEntityArchetype(entity);
    if (archetype === undefined || !this.archetypeMatches(archetype)) return undefined;
    return new QueryRowFacade<R, W, O>(this.world).bind(entity, archetype);
  }

  private static readonly SpanIterator = class<
    R extends readonly Component[],
    W extends readonly Component[],
    O extends readonly Component[],
  > implements Iterator<QuerySpan<R, W>>
  {
    private readonly owner: WorldInternal;
    private readonly structureEpoch: number;
    private readonly upperBound: number;
    private readonly changed: ChangedEntities | undefined;
    private tableIndex = 0;
    private changedIndex = 0;
    private finished = false;
    private advanceCallback: (() => IteratorResult<QuerySpan<R, W>>) | undefined;
    private finishCallback: (() => IteratorResult<QuerySpan<R, W>>) | undefined;

    constructor(private readonly query: ExecutableQuery<R, W, O>) {
      query.beginIteration();
      this.owner = query.world[worldInternal];
      this.structureEpoch = this.owner.getStructureEpoch();
      this.upperBound = this.owner.getMutationEpoch();
      this.changed = query.changedEntityCandidates(this.upperBound);
      if (this.changed === undefined) query.refreshMatches();
    }

    private close(commit: boolean): void {
      if (this.finished) return;
      this.finished = true;
      this.query.active = false;
      if (commit) {
        this.query.assertReadableChanges();
        this.query.lastObservedEpoch = this.upperBound;
      }
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
      try {
        this.query.assertReadableChanges();
      } catch (cause) {
        this.close(false);
        throw cause;
      }
      if (this.owner.getStructureEpoch() !== this.structureEpoch) {
        this.close(false);
        throw new QueryIterationInvalidatedError(
          this.structureEpoch,
          this.owner.getStructureEpoch(),
        );
      }
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
      const current =
        this.owner.getMutationEpoch() === this.upperBound ||
        !this.query.hasFutureChangedInput(this.upperBound);
      while (this.changedIndex < changed.length) {
        const entity = changed[this.changedIndex++] as EntityHandle;
        const records = this.owner.getRecords();
        const slot = entityIndex(entity);
        const archetype = this.owner.getGraph().archetypes[records.archetypeId[slot] ?? -1];
        const table =
          archetype === undefined ? undefined : this.owner.getGraph().tables[archetype.tableId];
        const start = archetype?.rows[records.archetypeRow[slot] ?? -1] ?? -1;
        if (
          table === undefined ||
          (!current && !this.query.denseChangeMatches(entity, table, start, this.upperBound))
        )
          continue;
        let count = 1;
        while (this.changedIndex < changed.length) {
          const next = changed[this.changedIndex] as EntityHandle;
          const nextSlot = entityIndex(next);
          const nextArchetype =
            this.owner.getGraph().archetypes[records.archetypeId[nextSlot] ?? -1];
          const nextRow = nextArchetype?.rows[records.archetypeRow[nextSlot] ?? -1] ?? -1;
          if (
            nextArchetype?.tableId !== table.id ||
            nextRow !== start + count ||
            (!current && !this.query.denseChangeMatches(next, table, nextRow, this.upperBound))
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
    if (reason !== undefined) return err(new QuerySpanUnavailableError(reason));
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
    } else if (this.compiled.changedIds.length > 0 || this.compiled.addedIds.length > 0) {
      this.batchesResult = err(new QueryBatchUnavailableError('temporal-filter'));
    } else {
      const lease: BatchLease = {
        structureEpoch: 0,
        active: false,
        generation: 0,
        assertReadable: () => this.assertBatchReadable(lease.structureEpoch),
      };
      this.batchesResult = ok({ [Symbol.iterator]: () => this.batchIterator(lease) });
    }
    return this.batchesResult;
  }

  private assertBatchReadable(epoch: number): void {
    const owner = this.world[worldInternal];
    if (owner.isDerivedWriteActive()) throw new DerivedWriteActiveError();
    const poisoned = worldPoisonedError(this.world.execution);
    if (poisoned !== undefined) throw poisoned;
    const current = owner.getStructureEpoch();
    if (current !== epoch) throw new QueryIterationInvalidatedError(epoch, current);
  }

  private batchIterator(lease: BatchLease): Iterator<QueryBatch<R, W, O>> {
    const epoch = this.world[worldInternal].getStructureEpoch();
    this.assertBatchReadable(epoch);
    this.beginIteration();
    lease.structureEpoch = epoch;
    lease.active = true;
    // Expire the preceding traversal's batch even before the first next().
    lease.generation++;
    const iterator = this.iterateBatches(lease, this.world[worldInternal].getMutationEpoch());
    let finished = false;
    return {
      next: () => {
        if (finished) return QUERY_DONE;
        try {
          const next = iterator.next();
          if (next.done) finished = true;
          return next;
        } catch (cause) {
          finished = true;
          throw cause;
        }
      },
      return: () => {
        if (finished) return QUERY_DONE;
        finished = true;
        try {
          return iterator.return(undefined);
        } finally {
          lease.active = false;
          this.active = false;
        }
      },
    };
  }

  private *iterateBatches(
    lease: BatchLease,
    upperBound: number,
  ): Generator<QueryBatch<R, W, O>, undefined> {
    let complete = false;
    try {
      lease.assertReadable();
      this.refreshMatches();
      const descriptor = this.compiled.descriptor;
      const graph = this.world[worldInternal].getGraph();
      if (this.compiled.sparseRoute) {
        for (let index = 0; index < this.matchedArchetypes.length; index++) {
          lease.assertReadable();
          const archetype = graph.archetypes[this.matchedArchetypes[index] as number];
          if (archetype === undefined || archetype.size === 0) continue;
          const table = graph.tables[archetype.tableId] as Table;
          lease.generation++;
          yield new IndexedBatch(table, descriptor, lease, archetype.rows, archetype.size);
        }
      } else {
        for (let index = 0; index < this.matchedTables.length; index++) {
          lease.assertReadable();
          const table = this.matchedTables[index] as Table;
          if (table.size === 0) continue;
          lease.generation++;
          yield new RangeBatch(table, descriptor, lease, 0, table.size);
        }
      }
      lease.assertReadable();
      complete = true;
    } finally {
      lease.active = false;
      this.active = false;
      if (complete) this.lastObservedEpoch = upperBound;
    }
    return undefined;
  }

  [DERIVED_WRITER]<C extends W[number]>(
    component: C,
  ): Result<DerivedRangeWriter<R[number], C>, QuerySpanUnavailableError> {
    const reason = this.spanUnavailableReason();
    if (reason !== undefined) return err(new QuerySpanUnavailableError(reason));
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

  combinations(k = 2): Iterable<readonly QueryRow<R, W, O>[]> {
    const query = this;
    return {
      *[Symbol.iterator](): Iterator<readonly QueryRow<R, W, O>[]> {
        if (!Number.isInteger(k) || k < 1) return;
        const previousObservedEpoch = query.lastObservedEpoch;
        const structureEpoch = query.world[worldInternal].getStructureEpoch();
        const rows: QueryRow<R, W, O>[] = [];
        const iterator = query.rowIterator(true);
        for (let next = iterator.next(); !next.done; next = iterator.next()) rows.push(next.value);
        query.active = true;
        let completed = false;
        try {
          if (k <= rows.length) {
            const indices = Array.from({ length: k }, (_, index) => index);
            while (true) {
              query.assertReadableChanges();
              if (query.world[worldInternal].getStructureEpoch() !== structureEpoch) {
                throw new QueryIterationInvalidatedError(
                  structureEpoch,
                  query.world[worldInternal].getStructureEpoch(),
                );
              }
              yield indices.map((index) => rows[index] as QueryRow<R, W, O>);
              let pivot = k - 1;
              while (pivot >= 0 && (indices[pivot] ?? 0) === rows.length - k + pivot) pivot -= 1;
              if (pivot < 0) break;
              indices[pivot] = (indices[pivot] ?? 0) + 1;
              for (let index = pivot + 1; index < k; index++) {
                indices[index] = (indices[index - 1] ?? 0) + 1;
              }
            }
          }
          query.assertReadableChanges();
          if (query.world[worldInternal].getStructureEpoch() !== structureEpoch)
            throw new QueryIterationInvalidatedError(
              structureEpoch,
              query.world[worldInternal].getStructureEpoch(),
            );
          completed = true;
        } finally {
          query.active = false;
          if (!completed) query.lastObservedEpoch = previousObservedEpoch;
        }
      },
    };
  }

  /** Only producer-indexed identities; physical ordering is derived for this actual iteration. */
  /**
   * One candidate buffer per query: an iteration only begins after the
   * previous one closed (`beginIteration`), so the buffer is never shared.
   * A typed buffer with its own count: truncating a JS array frees its
   * backing store, so every frame would regrow it.
   */
  // Allocated on the first change scan: structural queries never use them.
  private candidates: Uint32Array = NO_CANDIDATES;
  private candidateCount = 0;
  private candidateUpper = 0;
  private collectCandidateVisitor: ((index: number) => void) | undefined;
  private candidateVisitor(): (index: number) => void {
    this.collectCandidateVisitor ??= (index) => this.collectCandidate(index);
    return this.collectCandidateVisitor;
  }
  private collectCandidate(index: number): void {
    const owner = this.world[worldInternal];
    const graph = owner.getGraph();
    const records = owner.getRecords();
    const archetype = graph.archetypes[records.archetypeId[index] ?? -1];
    if (archetype === undefined || !this.archetypeMatches(archetype)) return;
    const entity = encodeEntity(index, records.generation[index] as number);
    const table = graph.tables[archetype.tableId];
    const row = archetype.rows[records.archetypeRow[index] as number] ?? -1;
    if (table === undefined || !this.changeMatches(entity, table, row, this.candidateUpper)) return;
    if (this.candidateCount === this.candidates.length) {
      const grown = new Uint32Array(Math.max(64, this.candidates.length * 2));
      grown.set(this.candidates);
      this.candidates = grown;
    }
    this.candidates[this.candidateCount++] = entity;
  }

  private changedEntityCandidates(upper: number): ChangedEntities | undefined {
    const primary = this.compiled.changedIds[0] ?? this.compiled.addedIds[0];
    if (primary === undefined) return undefined;
    this.candidateCount = 0;
    if (this.hasUnchangedInput()) return NO_CHANGED_ENTITIES;
    const owner = this.world[worldInternal];
    this.candidateUpper = upper;
    owner
      .getComponentChangeIndex(primary)
      ?.visitSince(this.lastObservedEpoch, upper, this.candidateVisitor());
    const entities = this.candidates.subarray(0, this.candidateCount) as ChangedEntities;
    if (entities.length > 1) {
      this.changedOrder ??= new ChangedEntityOrder(owner, this.compiled.sparseRoute);
      this.changedOrder.sort(entities);
    }
    return entities;
  }

  private hasUnchangedInput(): boolean {
    const epochs = this.world[worldInternal].getComponentMutationEpochs();
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
    const epochs = this.world[worldInternal].getComponentMutationEpochs();
    for (let index = 0; index < ids.length; index++)
      if ((epochs[ids[index] as ComponentId] ?? 0) > upper) return true;
    return false;
  }

  private assertReadableChanges(): void {
    if (this.compiled.changedIds.length > 0 || this.compiled.addedIds.length > 0) {
      if (this.world[worldInternal].isDerivedWriteActive()) throw new DerivedWriteActiveError();
      const poisoned = worldPoisonedError(this.world.execution);
      if (poisoned !== undefined) throw poisoned;
    }
  }

  private beginIteration(): void {
    this.assertReadableChanges();
    if (this.active) throw new QueryIterationActiveError();
    this.active = true;
  }

  private refreshMatches(): void {
    const graph = this.world[worldInternal].getGraph();
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

  private changeMatches(
    entity: EntityHandle,
    table: Table,
    row: number,
    upperBound: number,
  ): boolean {
    const graph = this.world[worldInternal].getGraph();
    const changedIds = this.compiled.changedIds;
    for (let index = 0; index < changedIds.length; index++) {
      const componentId = changedIds[index] as ComponentId;
      const epoch =
        this.world[worldInternal].getComponentChangeIndex(componentId)?.get(entityIndex(entity)) ??
        0;
      if (epoch <= this.lastObservedEpoch || epoch > upperBound) return false;
    }
    const addedIds = this.compiled.addedIds;
    for (let index = 0; index < addedIds.length; index++) {
      const componentId = addedIds[index] as ComponentId;
      const sparseSet = graph.sparseTags.get(componentId);
      const denseIndex = sparseSet === undefined ? -1 : sparseTagIndex(sparseSet, entity);
      const epoch =
        denseIndex >= 0
          ? (sparseSet?.added[denseIndex] ?? 0)
          : (table.storage.get(componentId)?.added[row] ?? 0);
      if (epoch <= this.lastObservedEpoch || epoch > upperBound) return false;
    }
    return true;
  }

  private denseChangeMatches(
    entity: EntityHandle,
    table: Table,
    row: number,
    upperBound: number,
  ): boolean {
    const changedIds = this.compiled.changedIds;
    for (let index = 0; index < changedIds.length; index++) {
      const componentId = changedIds[index] as ComponentId;
      const epoch =
        this.world[worldInternal].getComponentChangeIndex(componentId)?.get(entityIndex(entity)) ??
        0;
      if (epoch <= this.lastObservedEpoch || epoch > upperBound) return false;
    }
    const addedIds = this.compiled.addedIds;
    for (let index = 0; index < addedIds.length; index++) {
      const componentId = addedIds[index] as ComponentId;
      const epoch = table.storage.get(componentId)?.added[row] ?? 0;
      if (epoch <= this.lastObservedEpoch || epoch > upperBound) return false;
    }
    return true;
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

const DESCRIPTOR_ROLES = [...ACCESS_ROLES, ...TEMPORAL_ROLES] as const;
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
