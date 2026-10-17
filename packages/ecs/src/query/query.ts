import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type Component,
  type ComponentId,
  type ComponentSchema,
  componentDefinition,
  componentId,
  componentSchema,
  isManagedField,
  type ShapeOf,
  type TypedArrayFor,
} from '../component';
import { Disabled, Entity } from '../entity';
import type { EntityHandle } from '../entity-handle';
import {
  QueryDataRequiresFieldsError,
  QueryDescriptorConflictError,
  QueryIterationActiveError,
  QueryIterationInvalidatedError,
  QuerySpanUnavailableError,
  type QuerySpanUnavailableReason,
  RelationshipTargetReadonlyError,
} from '../errors';
import { DERIVED_WRITER } from '../internal';
import { isRelationshipTarget, relationshipRole } from '../relationship-index';
import { type Archetype, type ArchetypeId, archetypeHasComponent } from '../storage/archetype';
import { PROJECTION_BLOCK_SIZE, sparseTagIndex } from '../storage/change-detection';
import type { FieldView, ManagedColumnReader } from '../storage/column';
import type { Table } from '../storage/table';
import { type WorldInternal, worldInternal } from '../world-internal';
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
    const result = this.world[worldInternal].getQueryRow(this.entity, component);
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
  readonly entities: Readonly<Uint32Array>;

  constructor(
    private readonly world: WorldQueryAccess,
    private readonly table: Table,
    private readonly rowStart: number,
    readonly length: number,
  ) {
    const entityColumn = table.storage.get(componentId(Entity))?.fields.get('self');
    this.entities = (
      entityColumn === undefined
        ? new Uint32Array(0)
        : rowStart === 0 && length === entityColumn.view.length
          ? entityColumn.view
          : entityColumn.view.subarray(rowStart, rowStart + length)
    ) as Readonly<Uint32Array>;
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
    const fieldType = componentSchema(component)[fieldName];
    shape[fieldName] =
      fieldType !== undefined && isManagedField(fieldType)
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
  private readonly matchedArchetypes: ArchetypeId[] = [];
  private readonly matchedTables: Table[] = [];
  private scannedStorageCount = 0;
  private lastObservedEpoch = 0;
  private active = false;

  constructor(
    private readonly world: WorldQueryAccess,
    private readonly compiled: CompiledDescriptor<R, W, O>,
  ) {}

  [Symbol.iterator](): Iterator<QueryRow<R, W, O>> {
    this.beginIteration();
    this.refreshMatches();
    const structureEpoch = this.world[worldInternal].getStructureEpoch();
    const upperBound = this.world[worldInternal].getMutationEpoch();
    const row = new QueryRowFacade<R, W, O>(this.world);
    const unchanged = this.hasUnchangedInput();
    let archetypeIndex = unchanged ? this.matchedArchetypes.length : 0;
    let tableIndex = unchanged ? this.matchedTables.length : 0;
    let rowIndex = 0;
    let finished = false;

    const close = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      this.active = false;
      if (commit) this.lastObservedEpoch = upperBound;
    };

    return {
      next: (): IteratorResult<QueryRow<R, W, O>> => {
        if (finished) return { done: true, value: undefined };
        if (this.world[worldInternal].getStructureEpoch() !== structureEpoch) {
          close(false);
          throw new QueryIterationInvalidatedError(
            structureEpoch,
            this.world[worldInternal].getStructureEpoch(),
          );
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
            const entityColumn = table.storage.get(componentId(Entity))?.fields.get('self');
            if (entityColumn === undefined) continue;
            const entity = (entityColumn.view[currentTableRow] ?? 0) as EntityHandle;
            if (!this.changeMatches(entity, table, currentTableRow, upperBound)) continue;
            const recordArchetype = this.world[worldInternal].getEntityArchetype(entity);
            if (recordArchetype === undefined) continue;
            return { done: false, value: row.bind(entity, recordArchetype) };
          }
          close(true);
          return { done: true, value: undefined };
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
          const entityColumn = table.storage.get(componentId(Entity))?.fields.get('self');
          if (entityColumn === undefined) continue;
          const entity = (entityColumn.view[currentTableRow] ?? 0) as EntityHandle;
          if (!this.changeMatches(entity, table, currentTableRow, upperBound)) continue;
          return { done: false, value: row.bind(entity, archetype) };
        }
        close(true);
        return { done: true, value: undefined };
      },
      return: (): IteratorResult<QueryRow<R, W, O>> => {
        close(false);
        return { done: true, value: undefined };
      },
    };
  }

  at(entity: EntityHandle): QueryRow<R, W, O> | undefined {
    const archetype = this.world[worldInternal].getEntityArchetype(entity);
    if (archetype === undefined || !this.archetypeMatches(archetype)) return undefined;
    return new QueryRowFacade<R, W, O>(this.world).bind(entity, archetype);
  }

  spans(): Result<Iterable<QuerySpan<R, W>>, QuerySpanUnavailableError> {
    const reason = this.spanUnavailableReason();
    if (reason !== undefined) return err(new QuerySpanUnavailableError(reason));
    const query = this;
    return ok({
      [Symbol.iterator](): Iterator<QuerySpan<R, W>> {
        query.beginIteration();
        query.refreshMatches();
        const structureEpoch = query.world[worldInternal].getStructureEpoch();
        const upperBound = query.world[worldInternal].getMutationEpoch();
        const filterIds = [...query.compiled.changedIds, ...query.compiled.addedIds];
        let tableIndex = query.hasUnchangedInput() ? query.matchedTables.length : 0;
        let rowIndex = 0;
        let finished = false;
        const close = (commit: boolean): void => {
          if (finished) return;
          finished = true;
          query.active = false;
          if (commit) query.lastObservedEpoch = upperBound;
        };
        return {
          next(): IteratorResult<QuerySpan<R, W>> {
            if (finished) return { done: true, value: undefined };
            if (query.world[worldInternal].getStructureEpoch() !== structureEpoch) {
              close(false);
              throw new QueryIterationInvalidatedError(
                structureEpoch,
                query.world[worldInternal].getStructureEpoch(),
              );
            }
            while (tableIndex < query.matchedTables.length) {
              const table = query.matchedTables[tableIndex];
              if (table === undefined || table.size === 0) {
                tableIndex += 1;
                rowIndex = 0;
                continue;
              }
              if (query.compiled.changedIds.length === 0 && query.compiled.addedIds.length === 0) {
                tableIndex += 1;
                rowIndex = 0;
                return {
                  done: false,
                  value: new QuerySpanFacade<R, W>(query.world, table, 0, table.size),
                };
              }
              while (
                rowIndex < table.size &&
                !query.denseChangeMatches(table, rowIndex, upperBound)
              ) {
                const block = Math.floor(rowIndex / PROJECTION_BLOCK_SIZE);
                const unchanged = filterIds.some(
                  (id) =>
                    (table.storage.get(id)?.epochs.blocks[block] ?? 0) <= query.lastObservedEpoch,
                );
                rowIndex = unchanged ? (block + 1) * PROJECTION_BLOCK_SIZE : rowIndex + 1;
              }
              if (rowIndex >= table.size) {
                tableIndex += 1;
                rowIndex = 0;
                continue;
              }
              const start = rowIndex;
              rowIndex += 1;
              while (
                rowIndex < table.size &&
                query.denseChangeMatches(table, rowIndex, upperBound)
              ) {
                rowIndex += 1;
              }
              return {
                done: false,
                value: new QuerySpanFacade<R, W>(query.world, table, start, rowIndex - start),
              };
            }
            close(true);
            return { done: true, value: undefined };
          },
          return(): IteratorResult<QuerySpan<R, W>> {
            close(false);
            return { done: true, value: undefined };
          },
        };
      },
    });
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
          structureEpoch: () => this.world[worldInternal].getStructureEpoch(),
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

  private hasUnchangedInput(): boolean {
    const epochs = this.world[worldInternal].getComponentMutationEpochs();
    // Changed predicates are conjunctive. One unchanged input proves the
    // entire result empty without consulting any entity or table row.
    return this.compiled.changedIds.some((id) => (epochs[id] ?? 0) <= this.lastObservedEpoch);
  }

  private beginIteration(): void {
    if (this.active) throw new QueryIterationActiveError();
    this.active = true;
  }

  private refreshMatches(): void {
    const graph = this.world[worldInternal].getGraph();
    // A World's storage rosters only append; membership changes mutate rows
    // within those same owners. Match each new owner once, on the route this
    // query consumes, and keep empty matches for later row repopulation.
    if (this.compiled.sparseRoute) {
      for (; this.scannedStorageCount < graph.archetypes.length; this.scannedStorageCount++) {
        const archetype = graph.archetypes[this.scannedStorageCount];
        if (archetype !== undefined && this.archetypeMatches(archetype)) {
          this.matchedArchetypes.push(archetype.id);
        }
      }
    } else {
      for (; this.scannedStorageCount < graph.tables.length; this.scannedStorageCount++) {
        const table = graph.tables[this.scannedStorageCount];
        if (table !== undefined && this.tableMatches(table)) this.matchedTables.push(table);
      }
    }
  }

  private archetypeMatches(archetype: Archetype): boolean {
    for (const requiredId of this.compiled.requiredIds) {
      if (!archetypeHasComponent(archetype, requiredId)) return false;
    }
    for (const excludedId of this.compiled.withoutIds) {
      if (archetypeHasComponent(archetype, excludedId)) return false;
    }
    return true;
  }

  private tableMatches(table: Table): boolean {
    for (const componentId of this.compiled.requiredIds) {
      if (!table.storage.has(componentId)) return false;
    }
    for (const componentId of this.compiled.withoutIds) {
      if (table.storage.has(componentId)) return false;
    }
    return true;
  }

  private changeMatches(
    entity: EntityHandle,
    table: Table,
    row: number,
    upperBound: number,
  ): boolean {
    const graph = this.world[worldInternal].getGraph();
    for (const componentId of this.compiled.changedIds) {
      const sparseSet = graph.sparseTags.get(componentId);
      const denseIndex = sparseSet === undefined ? -1 : sparseTagIndex(sparseSet, entity);
      const epoch =
        denseIndex >= 0
          ? (sparseSet?.changed[denseIndex] ?? 0)
          : (table.storage.get(componentId)?.epochs.changed[row] ?? 0);
      if (epoch <= this.lastObservedEpoch || epoch > upperBound) return false;
    }
    for (const componentId of this.compiled.addedIds) {
      const sparseSet = graph.sparseTags.get(componentId);
      const denseIndex = sparseSet === undefined ? -1 : sparseTagIndex(sparseSet, entity);
      const epoch =
        denseIndex >= 0
          ? (sparseSet?.added[denseIndex] ?? 0)
          : (table.storage.get(componentId)?.epochs.added[row] ?? 0);
      if (epoch <= this.lastObservedEpoch || epoch > upperBound) return false;
    }
    return true;
  }

  private denseChangeMatches(table: Table, row: number, upperBound: number): boolean {
    for (const componentId of this.compiled.changedIds) {
      const epoch = table.storage.get(componentId)?.epochs.changed[row] ?? 0;
      if (epoch <= this.lastObservedEpoch || epoch > upperBound) return false;
    }
    for (const componentId of this.compiled.addedIds) {
      const epoch = table.storage.get(componentId)?.epochs.added[row] ?? 0;
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
  const compiled = compileDescriptor(descriptor);
  if (!compiled.ok) return compiled;
  return ok(new ExecutableQuery(world, compiled.value));
}
