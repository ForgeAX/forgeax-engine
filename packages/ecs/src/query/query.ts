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
import { worldPoisonedError } from '../errors/shared-kernel-errors';
import type { WorldExecutionState } from '../execution/shared-kernel';
import { DERIVED_WRITER } from '../internal';
import { isRelationshipTarget, relationshipRole } from '../relationship-index';
import { type Archetype, type ArchetypeId, archetypeHasComponent } from '../storage/archetype';
import { sparseTagIndex } from '../storage/change-detection';
import type { FieldView, ManagedColumnReader } from '../storage/column';
import type { Table } from '../storage/table';
import { type WorldInternal, worldInternal } from '../world-internal';
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
  /**
   * Read one known entity without iterating the query's matching tables.
   * Structural descriptor constraints are applied; temporal `changed` and
   * `added` filters are intentionally not evaluated because this is an
   * identity-addressed read, not a version scan.
   */
  at(entity: EntityHandle): QueryRow<R, W, O> | undefined;
  spans(): Result<Iterable<QuerySpan<R, W>>, QuerySpanUnavailableError>;
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

  snapshot(): QueryRowFacade<R, W, O> {
    if (this.archetype === undefined) throw new Error('Query row is not bound.');
    return new QueryRowFacade<R, W, O>(this.world).bind(this.entity, this.archetype);
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
    const view = this.table.entities.view as Uint32Array;
    return this.rowStart === 0 && this.length === view.length
      ? view
      : view.subarray(this.rowStart, this.rowStart + this.length);
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

function makeManagedColumnReader(
  view: FieldView,
  length: number,
  fieldType: string,
): ManagedColumnReader<string> {
  const slots = view.length === length ? view : view.subarray(0, length);
  return Object.freeze({
    length,
    get(i: number): number {
      return slots[i] ?? 0;
    },
    __managed: fieldType,
  });
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
  for (const [fieldName, column] of fields) {
    const start = rowStart * column.arity;
    const end = start + rowCount * column.arity;
    const view =
      start === 0 && end === column.view.length ? column.view : column.view.subarray(start, end);
    const fieldType =
      componentSchema(component)[fieldName.endsWith(':count') ? fieldName.slice(0, -6) : fieldName];
    shape[fieldName] =
      fieldType !== undefined && (isManagedField(fieldType) || fieldType.startsWith('array<asset<'))
        ? makeManagedColumnReader(view, view.length, fieldType)
        : view;
  }
  return shape;
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
  private spansResult: Result<Iterable<QuerySpan<R, W>>, QuerySpanUnavailableError> | undefined;
  private changedOrder: ChangedEntityOrder | undefined;

  constructor(
    private readonly world: WorldQueryAccess,
    private readonly matches: QueryMatches,
  ) {
    this.compiled = matches.compiled as unknown as CompiledDescriptor<R, W, O>;
    this.matchedArchetypes = matches.matchedArchetypes;
    this.matchedTables = matches.matchedTables;
  }

  [Symbol.iterator](): Iterator<QueryRow<R, W, O>> {
    this.beginIteration();
    const structureEpoch = this.world[worldInternal].getStructureEpoch();
    const upperBound = this.world[worldInternal].getMutationEpoch();
    const changed = this.changedEntityCandidates(upperBound);
    if (changed === undefined) this.refreshMatches();
    let changedIndex = 0;
    const row = new QueryRowFacade<R, W, O>(this.world);
    // One mutable step per iteration: every row step carries the same facade.
    const step = { done: false, value: row } as IteratorResult<QueryRow<R, W, O>>;
    const unchanged = this.hasUnchangedInput();
    let archetypeIndex = unchanged ? this.matchedArchetypes.length : 0;
    let tableIndex = unchanged ? this.matchedTables.length : 0;
    let rowIndex = 0;
    let finished = false;

    const close = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      this.active = false;
      if (commit) {
        this.assertReadableChanges();
        this.lastObservedEpoch = upperBound;
      }
    };

    return {
      next: (): IteratorResult<QueryRow<R, W, O>> => {
        if (finished) return QUERY_DONE;
        try {
          this.assertReadableChanges();
        } catch (cause) {
          close(false);
          throw cause;
        }
        if (this.world[worldInternal].getStructureEpoch() !== structureEpoch) {
          close(false);
          throw new QueryIterationInvalidatedError(
            structureEpoch,
            this.world[worldInternal].getStructureEpoch(),
          );
        }
        if (changed !== undefined) {
          const current =
            this.world[worldInternal].getMutationEpoch() === upperBound ||
            !this.hasFutureChangedInput(upperBound);
          while (changedIndex < changed.length) {
            const entity = changed[changedIndex++] as EntityHandle;
            const archetype = this.world[worldInternal].getEntityArchetype(entity);
            if (archetype === undefined) continue;
            const records = this.world[worldInternal].getRecords();
            const tableRow = archetype.rows[records.archetypeRow[entityIndex(entity)] ?? -1] ?? -1;
            const table = this.world[worldInternal].getGraph().tables[archetype.tableId];
            if (
              table === undefined ||
              (!current && !this.changeMatches(entity, table, tableRow, upperBound))
            )
              continue;
            row.bind(entity, archetype);
            return step;
          }
          close(true);
          return QUERY_DONE;
        }
        if (!this.compiled.sparseRoute) {
          while (tableIndex < this.matchedTables.length) {
            const table = this.matchedTables[tableIndex];
            if (table === undefined || rowIndex >= table.size) {
              tableIndex += 1;
              rowIndex = 0;
              continue;
            }
            const currentTableRow = rowIndex++;
            const entity = (table.entities.view[currentTableRow] ?? 0) as EntityHandle;
            if (!this.changeMatches(entity, table, currentTableRow, upperBound)) continue;
            const recordArchetype = this.world[worldInternal].getEntityArchetype(entity);
            if (recordArchetype === undefined) continue;
            row.bind(entity, recordArchetype);
            return step;
          }
          close(true);
          return QUERY_DONE;
        }
        while (archetypeIndex < this.matchedArchetypes.length) {
          const archetype =
            this.world[worldInternal].getGraph().archetypes[
              this.matchedArchetypes[archetypeIndex] ?? -1
            ];
          if (archetype === undefined || rowIndex >= archetype.size) {
            archetypeIndex += 1;
            rowIndex = 0;
            continue;
          }
          const currentArchetypeRow = rowIndex++;
          const currentTableRow = archetype.rows[currentArchetypeRow] ?? 0;
          const table = this.world[worldInternal].getGraph().tables[archetype.tableId];
          if (table === undefined) continue;
          const entity = (table.entities.view[currentTableRow] ?? 0) as EntityHandle;
          if (!this.changeMatches(entity, table, currentTableRow, upperBound)) continue;
          row.bind(entity, archetype);
          return step;
        }
        close(true);
        return QUERY_DONE;
      },
      return: (): IteratorResult<QueryRow<R, W, O>> => {
        close(false);
        return QUERY_DONE;
      },
    };
  }

  at(entity: EntityHandle): QueryRow<R, W, O> | undefined {
    const archetype = this.world[worldInternal].getEntityArchetype(entity);
    if (archetype === undefined || !this.archetypeMatches(archetype)) return undefined;
    return new QueryRowFacade<R, W, O>(this.world).bind(entity, archetype);
  }

  spans(): Result<Iterable<QuerySpan<R, W>>, QuerySpanUnavailableError> {
    // Availability is a descriptor fact and the iterable only re-enters this
    // query, so one success Result serves every per-frame `spans()` call.
    if (this.spansResult !== undefined) return this.spansResult;
    const reason = this.spanUnavailableReason();
    if (reason !== undefined) return err(new QuerySpanUnavailableError(reason));
    const query = this;
    this.spansResult = ok({
      [Symbol.iterator](): Iterator<QuerySpan<R, W>> {
        query.beginIteration();
        const owner = query.world[worldInternal];
        const structureEpoch = owner.getStructureEpoch();
        const upperBound = owner.getMutationEpoch();
        const changed = query.changedEntityCandidates(upperBound);
        if (changed === undefined) query.refreshMatches();
        let tableIndex = 0;
        let changedIndex = 0;
        let finished = false;
        const close = (commit: boolean): void => {
          if (finished) return;
          finished = true;
          query.active = false;
          if (commit) {
            query.assertReadableChanges();
            query.lastObservedEpoch = upperBound;
          }
        };
        return {
          next(): IteratorResult<QuerySpan<R, W>> {
            if (finished) return QUERY_DONE;
            try {
              query.assertReadableChanges();
            } catch (cause) {
              close(false);
              throw cause;
            }
            if (owner.getStructureEpoch() !== structureEpoch) {
              close(false);
              throw new QueryIterationInvalidatedError(structureEpoch, owner.getStructureEpoch());
            }
            if (changed !== undefined) {
              const current =
                owner.getMutationEpoch() === upperBound || !query.hasFutureChangedInput(upperBound);
              while (changedIndex < changed.length) {
                const entity = changed[changedIndex++] as EntityHandle;
                const records = owner.getRecords();
                const slot = entityIndex(entity);
                const archetype = owner.getGraph().archetypes[records.archetypeId[slot] ?? -1];
                const table =
                  archetype === undefined ? undefined : owner.getGraph().tables[archetype.tableId];
                const start = archetype?.rows[records.archetypeRow[slot] ?? -1] ?? -1;
                if (
                  table === undefined ||
                  (!current && !query.denseChangeMatches(entity, table, start, upperBound))
                )
                  continue;
                let count = 1;
                while (changedIndex < changed.length) {
                  const next = changed[changedIndex] as EntityHandle;
                  const nextSlot = entityIndex(next);
                  const nextArchetype =
                    owner.getGraph().archetypes[records.archetypeId[nextSlot] ?? -1];
                  const nextRow = nextArchetype?.rows[records.archetypeRow[nextSlot] ?? -1] ?? -1;
                  if (
                    nextArchetype?.tableId !== table.id ||
                    nextRow !== start + count ||
                    (!current && !query.denseChangeMatches(next, table, nextRow, upperBound))
                  )
                    break;
                  changedIndex++;
                  count++;
                }
                return {
                  done: false,
                  value: new QuerySpanFacade<R, W>(query.world, table, start, count),
                };
              }
            } else {
              while (tableIndex < query.matchedTables.length) {
                const table = query.matchedTables[tableIndex++];
                if (table === undefined || table.size === 0) continue;
                return {
                  done: false,
                  value: new QuerySpanFacade<R, W>(query.world, table, 0, table.size),
                };
              }
            }
            close(true);
            return QUERY_DONE;
          },
          return(): IteratorResult<QuerySpan<R, W>> {
            close(false);
            return QUERY_DONE;
          },
        };
      },
    });
    return this.spansResult;
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
        for (const row of query) {
          rows.push((row as QueryRowFacade<R, W, O>).snapshot());
        }
        query.active = true;
        let completed = false;
        try {
          if (k <= rows.length) {
            const indices = Array.from({ length: k }, (_, index) => index);
            while (true) {
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
