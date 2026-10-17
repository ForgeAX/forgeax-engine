import { publishComponentRange } from './storage/change-detection';
// @forgeax/engine-ecs — World: top-level ECS container.
//
// World owns entities, archetypes (via ArchetypeGraph), and component registry.
// Supports multi-component spawn, despawn (with generation retirement D-08),
// get/set, addComponent/removeComponent (archetype migration via edges).
// M3: addSystem / update (DAG schedule) + deferred commands + Resource CRUD.
//
// [w6] All 6 public methods return Result<T, EcsError> (AP-8 Layer 1).
// Construction errors (EntityIndexOverflowError) still throw — they are
// build-time / infrastructure failures.

import type { Handle, Result } from '@forgeax/engine-types';
import {
  BUILTIN_BASE,
  err,
  isRetiredSlot,
  ok,
  toShared,
  toUnique,
  unwrapHandle,
} from '@forgeax/engine-types';
import { BufferPool } from './buffer-pool';
import {
  type ArrayMeta,
  bufferFieldByteLength,
  type Component,
  ComponentCatalog,
  type ComponentSchema,
  componentId,
  componentSchema,
  type InputShapeOf,
  isEntityField,
  isManagedArrayField,
  isManagedBufferField,
  isManagedField,
  type ShapeOf,
  TYPE_METADATA,
} from './component';
import { fillComponentDefaults, validateComponentDataKeys } from './component-default-fallback';
import { componentDefinition, expandComponentRequirements } from './component-schema';
import { validateManagedArrayValues, validateSharedFieldValues } from './component-value-validate';
import { Entity as EntityComponent } from './entity';
import {
  ENTITY_MAX_INDEX,
  ENTITY_NULL_RAW,
  type EntityHandle,
  encodeEntity,
  entityGeneration,
  entityIndex,
} from './entity-handle';
import type {
  CommandFailedError,
  ComponentFieldInvalidValueError,
  ComponentNotDefinedError,
  ComponentNumericValueInvalidError,
  DerivedRangeOutOfBoundsError,
  ManagedArrayErrorEnvelope,
  ManagedArrayInvalidValueError,
  ManagedBufferShrinkNotSupportedError,
  RelationshipDetachMismatchError,
  RelationshipMirrorComponentNotRegisteredError,
  RelationshipMirrorFieldTypeMismatchError,
  ScheduleMutationError,
  ScheduleScopeMismatchError,
  SharedKernelEligibilityError,
  SharedKernelFailureError,
  SystemFailedError,
  SystemSetNotRegisteredError,
  TimeConfigInvalidError,
  TimeDeltaInvalidError,
  UniqueRefDoubleReleaseError,
  UniqueRefReleasedError,
  UniqueRefStaleError,
} from './errors';
import {
  ArrayRangeOutOfBoundsError,
  ChangeEpochExhaustedError,
  ComponentAlreadyPresentError,
  ComponentNotPresentError,
  EntityIndexOverflowError,
  FixedSizeMismatchError,
  ManagedBufferOutOfBoundsError,
  RelationshipSelfCycleError,
  RelationshipTargetReadonlyError,
  RemoveEssentialComponentError,
  StaleEntityError,
  validateEnumFieldValues,
  validateNumericFieldValues,
  type WorldPoisonedError,
} from './errors';
import { worldPoisonedError } from './errors/shared-kernel-errors';
import {
  createWorldIdentity,
  healthyWorldExecutionState,
  poisonedWorldExecutionState,
  type WorldExecutionFault,
  type WorldExecutionState,
} from './execution/shared-kernel';
import type { QueryDescriptor } from './query/query';
import { createQuery, type Query, type QueryCreationError } from './query/query';
import {
  isRelationshipTarget,
  RelationshipIndex,
  type RelationshipTargetComponent,
  relationshipMirror,
  relationshipRole,
  relationshipSource,
} from './relationship-index';
import { createResourceStore, type ResourceStore } from './resource';
import { createSchedule, type SystemDescriptor, type SystemSet } from './schedule';
import { FixedUpdate, Update } from './schedule-token';
import type { SharedRefStore } from './shared-ref-store.js';
import { SharedRefStore as SharedRefStoreImpl } from './shared-ref-store.js';
import {
  type Archetype,
  appendArchetypeRow,
  archetypeHasComponent,
  removeArchetypeRow,
} from './storage/archetype';
import {
  type ArchetypeGraph,
  createArchetypeGraph,
  getAddEdge,
  getOrCreateArchetype,
  getRemoveEdge,
  getTable,
} from './storage/archetype-graph';
import { ArrayRangeLog, type ArrayRangesChange } from './storage/array-range-log';
import {
  type ChangeTicks,
  copyComponentEpoch,
  markComponentChanged,
  markComponentsAdded,
  readComponentChange,
  removeSparseTag,
} from './storage/change-detection';
import {
  arrayCountColumnName,
  type Column,
  type FieldView,
  normalizeBufferWrite,
} from './storage/column';
import { appendTableRow, markTableMembership, removeTableRow, type Table } from './storage/table';
import {
  createWorldClock,
  DEFAULT_TIME_POLICY,
  FIXED_TIME_RESOURCE_KEY,
  TIME_RESOURCE_KEY,
  type WorldOptions,
} from './time';
import { type UniqueRefStore, UniqueRefStore as UniqueRefStoreImpl } from './unique-ref-store';
import {
  spawnCore,
  worldAddChild,
  worldIterAncestors,
  worldIterDescendants,
  worldRemoveChild,
  worldReparent,
} from './world-entity-lifecycle';
import { worldInternal } from './world-internal';
import { type WorldRead, worldRead } from './world-read';
import {
  worldAddSystem,
  worldAddSystems,
  worldGetResource,
  worldHasResource,
  worldInsertResource,
  worldInspect,
  worldRemoveResource,
  worldRemoveSystem,
  worldReplaceSystem,
  worldScheduleData,
  worldScheduleUsesComponent,
  worldUpdate,
} from './world-scheduling';
import {
  detachWorldInspection,
  elementByteSize,
  readArrayElementAt,
  reinterpretBufferRegion,
  reinterpretSlotBytes,
  writeArrayElementAt,
} from './world-storage-primitives';

/**
 * Union of all EcsError types that World methods can return via Result.
 * AI users: switch on `.code` for programmatic branching.
 */
export type EcsError =
  | ArrayRangeOutOfBoundsError
  | CommandFailedError
  | StaleEntityError
  | ComponentNotPresentError
  | ComponentAlreadyPresentError
  | ComponentFieldInvalidValueError
  | ComponentNumericValueInvalidError
  | ManagedArrayInvalidValueError
  | UniqueRefReleasedError
  | UniqueRefDoubleReleaseError
  | UniqueRefStaleError
  | ManagedBufferOutOfBoundsError
  | ManagedBufferShrinkNotSupportedError
  | FixedSizeMismatchError
  | RelationshipSelfCycleError
  | RelationshipMirrorComponentNotRegisteredError
  | RelationshipMirrorFieldTypeMismatchError
  | RelationshipDetachMismatchError
  | RelationshipTargetReadonlyError
  | ComponentNotDefinedError
  | RemoveEssentialComponentError
  | SystemSetNotRegisteredError
  | SystemFailedError
  | TimeDeltaInvalidError
  | TimeConfigInvalidError
  | ScheduleScopeMismatchError
  | SharedKernelEligibilityError
  | SharedKernelFailureError
  | DerivedRangeOutOfBoundsError
  | ChangeEpochExhaustedError
  | WorldPoisonedError;

/** Component data for spawn/addComponent: component token + initial values.
 *
 * `data` is `Partial<InputShapeOf<S>>` (feat-20260517 / M2; tweak-20260616
 * input/output split): spawn / addComponent / SceneAsset.instantiate share the
 * SAME shape contract via the layer-2 + layer-3 silent fallback applied inside
 * `writeRow` (`fillComponentDefaults`). The input shape widens
 * `array<scalar, N>` / `array<scalar>` to also accept `readonly number[]`
 * because writeArrayField copies bytes from either shape — AI users can write
 * `times: [0.5]` instead of `new Float32Array([0.5])` boilerplate. Wrong-VALUE
 * fields (e.g. `{ fov: 'bad' }`) still fire field-level TS2322 — mapped-tuple
 * primary inference does not degrade to the "No overload matches" wall
 * (AC-03 / C-4). */
export interface ComponentData<S extends ComponentSchema = ComponentSchema> {
  component: Component<string, S>;
  data: Partial<InputShapeOf<S>>;
}

type WritableComponent<C extends Component> = C extends RelationshipTargetComponent ? never : C;

type ErrorContext = { readonly systemName: string };

/**
 * Per-archetype summary returned by `world.inspect()`. Sorted ComponentId key
 * (always prefixed by the essential id=0 Entity column, e.g. "0+2+5+7"),
 * human-readable component names, live entity count, allocated row capacity.
 */
export interface ArchetypeInfo {
  /** Sorted ComponentId key, always prefixed by the id=0 Entity column (e.g. "0+2+5+7"). */
  readonly key: string;
  /** Human-readable component names in this archetype. */
  readonly componentNames: string[];
  /** Number of live entities in this archetype. */
  readonly entityCount: number;
  readonly tableId: number;
}

export interface TableInfo {
  readonly id: number;
  readonly key: string;
  readonly componentNames: string[];
  readonly entityCount: number;
  readonly capacity: number;
}

/**
 * Typed diagnostic snapshot of the World state.
 * Returned by `world.inspect()` for programmatic introspection by AI users.
 */
export interface WorldInspection {
  /** Total number of live entities. */
  readonly entityCount: number;
  /** Number of archetypes currently allocated. */
  readonly archetypeCount: number;
  /** Per-archetype details. */
  readonly archetypes: ArchetypeInfo[];
  readonly tableCount: number;
  readonly tables: TableInfo[];
  /**
   * Names of components that are currently active in this World — i.e.
   * every distinct component name appearing on at least one non-empty
   * archetype. Collected by walking the archetype graph, so a component
   * that was defined but never spawned into this World does not appear.
   */
  readonly activeComponents: string[];
  /** Number of registered systems. Always equals `systems.length` (M2 derived invariant). */
  readonly systemCount: number;
  /**
   * Per-system summary (M3 — plan-strategy D-8). One entry per
   * registered system, in registration order. The `systemCount` field is
   * preserved as a derived alias of `systems.length` so existing inspector
   * P0 e2e cases that read `systemCount` keep working.
   *
   * `sets` is the list of set names this system belongs to (empty array for
   * systems registered via plain `addSystem` without `addSystems`).
   */
  readonly systems: ReadonlyArray<{ readonly name: string; readonly sets: readonly string[] }>;
  /** Keys of all inserted resources. */
  readonly resourceKeys: string[];
  /** Systems grouped by their schedule token. */
  readonly schedules: ReadonlyArray<{
    readonly schedule: import('./schedule-token').ScheduleToken;
    readonly systems: ReadonlyArray<{ readonly name: string; readonly sets: readonly string[] }>;
  }>;
  /** Count systems in one explicit schedule. */
  scheduleSystemCount(schedule: import('./schedule-token').ScheduleToken): number;
}

/** JSON-safe schedule graph and access metadata returned by `world.scheduleData()`. */
export interface WorldScheduleQueryData {
  readonly with: readonly string[];
  readonly without: readonly string[];
  readonly optional: readonly string[];
  readonly changed: readonly string[];
  readonly added: readonly string[];
}

/** JSON-safe system registration and access metadata. */
export interface WorldScheduleSystemData {
  readonly name: string;
  readonly sets: readonly string[];
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly queries: readonly WorldScheduleQueryData[];
  readonly resources: readonly string[];
}

/** JSON-safe system-set membership and ordering metadata. */
export interface WorldScheduleSetData {
  readonly name: string;
  readonly members: readonly string[];
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly chained: boolean;
}

/** JSON-safe projection of one explicit World schedule. */
export interface WorldScheduleData {
  readonly name: string;
  readonly systems: readonly WorldScheduleSystemData[];
  readonly systemSets: readonly WorldScheduleSetData[];
  readonly dependencies: readonly (readonly [string, string])[];
}

/**
 * Internal record describing where an entity lives.
 *
 * Liveness (feat-20260602 / plan-strategy D-4): the former `alive` boolean was
 * absorbed into `generation`. A despawn unconditionally bumps `generation` (so a
 * stale handle's `gen` no longer matches), and `gen > 255` retires the slot
 * permanently (it is never pushed back to `freeIndices`). The single liveness
 * predicate is therefore "handle gen matches AND archetypeId !== -1" -- see
 * `World.recordIsLive`. A deferred-spawn allocation is "pending" when
 * archetypeId === -1 (not yet materialized into an archetype row). During a
 * failed append, `archetypeId` is reserved before the first storage write and
 * `archetypeRow` remains `-1`; that marker prevents command abort from
 * reclaiming a reservation that may already have touched table storage.
 */
export interface EntityRecord {
  generation: number;
  archetypeId: number; // -1 if no archetype (pending / despawned)
  archetypeRow: number;
}

/**
 * The World owns the component registry, archetype graph, entity index table,
 * and recyclable free-list.
 */
export class World {
  readonly [worldRead]: WorldRead = {
    getRelationshipEpoch: (component) =>
      this.relationshipIndexes.get(componentId(component))?.epoch ?? 0,
    getFieldValue: this.internalgetFieldValue.bind(this),
    getArrayLength: this.internalgetArrayLength.bind(this),
    getArrayElement: this.internalgetArrayElement.bind(this),
  };
  // ── Internal state ──

  /** World-local state is kept together so one owner closes each mutation. */
  private executionState: WorldExecutionState = healthyWorldExecutionState(createWorldIdentity());
  private readonly graph: ArchetypeGraph;
  private readonly records: EntityRecord[] = [];
  private readonly freeIndices: number[] = [];
  /** BufferPool for schema-declared variable buffers and arrays. */
  private readonly bufferPool = new BufferPool();
  /** Per-World managed unique-ref store used by lifecycle mutations. */
  private readonly uniqueRefs: UniqueRefStore = new UniqueRefStoreImpl();
  /** Per-World shared-ref store; public read-only for direct handle operations. */
  readonly sharedRefs: SharedRefStore = new SharedRefStoreImpl();
  private readonly componentMutationEpochs: number[] = [];
  /** Bounded history of in-place `setArrayRange` writes. */
  private readonly arrayRangeLog = new ArrayRangeLog();
  /** One packed reverse index per relationship source component. */
  private readonly relationshipIndexes = new Map<number, RelationshipIndex>();
  private mutationEpoch = 0;
  private structureEpoch = 0;
  /** Keep identity as a prototype getter; it is a diagnostic capability, not enumerable state. */
  get identity() {
    return this.executionState.identity;
  }
  /** Plugin-owned component discovery scoped to this World and removed through leases. */
  readonly components = new ComponentCatalog((component) => this.componentIsInUse(component));
  /** DAG schedules for the two built-in execution scopes. */
  private readonly schedules = new Map([
    [Update, createSchedule(Update)],
    [FixedUpdate, createSchedule(FixedUpdate)],
  ]);
  /** Resource store: typed key-value global singletons. */
  private readonly resources: ResourceStore = createResourceStore();
  private readonly clock: ReturnType<typeof createWorldClock>;
  /** Remainder carried between fixed-step runs. */
  private fixedAccumulator = 0;
  constructor(options: WorldOptions = {}) {
    this.graph = createArchetypeGraph(options.storage === 'shared');
    this.clock = createWorldClock({ ...DEFAULT_TIME_POLICY, ...options.time });
    this.resources.entries.set(TIME_RESOURCE_KEY, {
      value: this.clock.time,
      added: 0,
      changed: 0,
    });
    this.resources.entries.set(FIXED_TIME_RESOURCE_KEY, {
      value: this.clock.fixed,
      added: 0,
      changed: 0,
    });
    this[worldInternal] = {
      allocatePendingEntity: this.allocatePendingEntity.bind(this),
      cancelPendingEntity: this.cancelPendingEntity.bind(this),
      getArrayRangesChangedSince: this.internalgetArrayRangesChangedSince.bind(this),
      getArrayView: this.getArrayView.bind(this),
      getBufferPool: () => this.bufferPool,
      getClockWriter: () => this.clock.writer,
      getComponentChange: this.internalgetComponentChange.bind(this),
      getComponentMutationEpochs: () => this.componentMutationEpochs,
      getEntityArchetype: this.internalgetEntityArchetype.bind(this),
      getFixedAccumulator: () => this.fixedAccumulator,
      getGraph: () => this.graph,
      getMutationEpoch: () => this.mutationEpoch,
      getQueryRow: (entity, component) =>
        this.get(entity, component) as Result<Record<string, unknown>, EcsError>,
      getRecords: () => this.records,
      getRelationshipEpoch: this[worldRead].getRelationshipEpoch,
      getRelationshipTargetEntities: this.relationshipTargetEntries.bind(this),
      getResources: () => this.resources,
      getSchedule: (token) => this.schedules.get(token),
      getSchedules: () => this.schedules,
      getSharedRefs: () => this.sharedRefs,
      getStructureEpoch: this.getStructureEpoch.bind(this),
      lookupAlive: this.lookupAlive.bind(this),
      markComponentChanged: this.internalmarkComponentChanged.bind(this),
      markComponentRangeChanged: this.internalmarkComponentRangeChanged.bind(this),
      materializeEntity: this.materializeEntity.bind(this),
      materializePendingEntity: this.materializePendingEntity.bind(this),
      nextMutationEpoch: this.internalnextMutationEpoch.bind(this),
      poisonExecution: this.internalpoisonExecution.bind(this),
      publishDerivedRange: this.internalpublishDerivedRange.bind(this),
      preflightComponentData: this.preflightComponentData.bind(this),
      readRow: this.readRow.bind(this),
      recordIsLive: this.recordIsLive.bind(this),
      routeError: this.routeError.bind(this),
      restoreMutationEpoch: this.internalrestoreMutationEpoch.bind(this),
      setFixedAccumulator: (value) => {
        this.fixedAccumulator = value;
      },
      setQueryRow: this.internalsetQueryRow.bind(this),
    };
  }

  /** Immutable integrity state for execution coordinators and headless callers. */
  get execution(): WorldExecutionState {
    return this.executionState;
  }

  /** Resolve a schedule token owned by this World realm without package singleton identity. */
  scheduleToken(
    name: import('./schedule-token').ScheduleName,
  ): import('./schedule-token').ScheduleToken {
    if (name === 'Update') return Update;
    if (name === 'FixedUpdate') return FixedUpdate;
    return FixedUpdate;
  }

  /** Seal the first execution fault; application code recovers with a new World. */
  private internalpoisonExecution(fault: WorldExecutionFault): void {
    if (this.executionState.health === 'healthy') {
      this.executionState = poisonedWorldExecutionState(this.identity, fault);
    }
  }

  query<
    const R extends readonly Component[] = readonly [],
    const W extends readonly Component[] = readonly [],
    const O extends readonly Component[] = readonly [],
  >(descriptor: QueryDescriptor<R, W, O>): Result<Query<R, W, O>, QueryCreationError> {
    return createQuery(this, descriptor);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal access — query engine
  // ──────────────────────────────────────────────────────────────────────────

  private componentIsInUse(component: Component): boolean {
    if (
      this.graph.archetypes.some(
        (archetype) =>
          archetype.size > 0 && archetype.components.some((candidate) => candidate === component),
      )
    ) {
      return true;
    }
    return worldScheduleUsesComponent(this, component);
  }

  private liveEntityRecord(entity: EntityHandle): EntityRecord | undefined {
    const record = this.records[entityIndex(entity)];
    return this.recordIsLive(record, entityGeneration(entity)) ? record : undefined;
  }

  /** Resolve current logical identity for a packed entity handle. */
  private internalgetEntityArchetype(entity: EntityHandle): Archetype | undefined {
    const record = this.liveEntityRecord(entity);
    return record === undefined ? undefined : this.graph.archetypes[record.archetypeId];
  }

  /** Component change state for query filters. */
  private internalgetComponentChange(
    entity: EntityHandle,
    componentId: number,
  ): ChangeTicks | undefined {
    const record = this.records[entityIndex(entity)];
    if (!this.recordIsLive(record, entityGeneration(entity))) return undefined;
    return readComponentChange(this.graph, record, entity, componentId);
  }

  /** Allocate one epoch after a mutation has succeeded. */
  private internalnextMutationEpoch(): number {
    if (this.mutationEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new ChangeEpochExhaustedError(this.mutationEpoch);
    }
    this.mutationEpoch += 1;
    return this.mutationEpoch;
  }

  private internalrestoreMutationEpoch(epoch: number): void {
    this.mutationEpoch = epoch;
  }

  private internalpublishDerivedRange(
    table: ArchetypeGraph['tables'][number],
    componentId: number,
    rowStart: number,
    rowCount: number,
    epoch: number,
  ): void {
    const epochs = table.storage.get(componentId)?.epochs;
    if (epochs === undefined) {
      throw new Error(`Derived component ${componentId} is not in the table.`);
    }
    publishComponentRange(epochs, rowStart, rowCount, epoch);
    this.componentMutationEpochs[componentId] = epoch;
  }

  /** Record one successful structural mutation. */
  private advanceStructureEpoch(): void {
    this.structureEpoch += 1;
  }

  /** Current structural revision for mounted World projections. */
  getStructureEpoch(): number {
    return this.structureEpoch;
  }

  /** Mark one mutation's component instances with a shared epoch. */
  private internalmarkComponentsAdded(entity: EntityHandle, componentIds: readonly number[]): void {
    const record = this.records[entityIndex(entity)];
    if (!this.recordIsLive(record, entityGeneration(entity))) return;
    const epoch = this.internalnextMutationEpoch();
    markComponentsAdded(this.graph, record, entity, componentIds, epoch);
    for (const componentId of componentIds) {
      this.componentMutationEpochs[componentId] = epoch;
    }
  }

  /** Mark an existing component as changed at the current tick. */
  private internalmarkComponentChanged(entity: EntityHandle, componentId: number): void {
    const record = this.records[entityIndex(entity)];
    if (!this.recordIsLive(record, entityGeneration(entity))) return;
    let epoch: number | undefined;
    markComponentChanged(this.graph, record, entity, componentId, () => {
      epoch = this.internalnextMutationEpoch();
      return epoch;
    });
    if (epoch !== undefined) {
      this.componentMutationEpochs[componentId] = epoch;
    }
  }

  /** Mark one contiguous component range with a single epoch. */
  private internalmarkComponentRangeChanged(
    table: ArchetypeGraph['tables'][number],
    componentId: number,
    rowStart: number,
    rowCount: number,
  ): void {
    const epochs = table.storage.get(componentId)?.epochs;
    if (epochs === undefined || rowCount === 0) return;
    const epoch = this.internalnextMutationEpoch();
    publishComponentRange(epochs, rowStart, rowCount, epoch);
    this.componentMutationEpochs[componentId] = epoch;
  }

  /** Query facade write after the facade has already marked evidence. */
  private internalsetQueryRow(
    entity: EntityHandle,
    component: Component,
    value: Record<string, unknown>,
  ): Result<void, EcsError> {
    const result = this.set(entity, component, value as never, false);
    if (result.ok && relationshipRole(component)?.kind === 'source') {
      this.markComponentChanged(entity, component);
    }
    return result;
  }

  /** Return resource change ticks for diagnostics and resource-driven systems. */
  getResourceChange(name: string): ChangeTicks | undefined {
    const entry = this.resources.entries.get(name);
    return entry === undefined ? undefined : { added: entry.added, changed: entry.changed };
  }

  /** Route an expected internal failure through the host-owned error channel. */
  private routeError(err: unknown, ctx?: ErrorContext): void {
    // Internal expected failures are reported without becoming a second
    // schedule or terminal hook. The host owns fatal frame policy.
    console.error(`[${ctx?.systemName ?? 'World'}]`, err);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // System registration + update (M3)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register a system with query descriptor and optional ordering constraints.
   *
   * `const Qs` mirrors the free `addSystem` signature so the call-site
   * `queries` tuple is locked literal-form, letting `descriptor.fn`'s first
   * parameter recover per-query row access shapes (S-5, KD-3 — class method
   * generic, not free function double track).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * world.addSystem(Update, {
   *   name: 'read-pos',
   *   queries: [{ with: [Position] }],
   *   fn: (world, queries) => { void world; for (const row of queries[0]) { void row.entity; } },
   * });
   * ```
   */
  addSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
    schedule: import('./schedule-token').ScheduleToken,
    descriptor: SystemDescriptor<Qs>,
  ): Result<void, ScheduleScopeMismatchError> {
    return worldAddSystem(this, schedule, descriptor);
  }

  /**
   * Remove a registered system by name (M2 — plan-strategy D-3).
   *
   * Returns `Result<void, ScheduleMutationError>`:
   * - ok branch: the slot is dropped and the schedule will rebuild on the
   *   next `update()`.
   * - err branch with `.code === 'system-before-unknown'`: no system carries
   *   this name; `.detail.candidates` lists the registered names.
   *
   * Designed to support `@forgeax/engine-remote`'s typed `injectSystem` /
   * `removeSystem` channel and the WS-disconnect reverse-remove path.
   *
   * @example
   * ```ts
   * const r = world.removeSystem(Update, 'movement');
   * if (!r.ok) console.error(r.error.code, r.error.detail.candidates);
   * ```
   */
  removeSystem(
    schedule: import('./schedule-token').ScheduleToken,
    name: string,
  ): Result<void, ScheduleMutationError | ScheduleScopeMismatchError> {
    return worldRemoveSystem(this, schedule, name);
  }

  /**
   * Replace a registered system in-place (M2 — plan-strategy D-3 atomic semantics).
   *
   * Overwrites the descriptor stored under `name` while preserving the
   * registration slot — `before / after` references that target this name
   * remain bound.
   *
   * Returns `Result<void, ScheduleMutationError>`:
   * - ok branch: descriptor swapped, schedule marked dirty.
   * - err branch with `.code === 'system-before-unknown'`: no system carries
   *   this name; use `addSystem(descriptor)` to register a new one instead.
   *
   * @example
   * ```ts
   * const r = world.replaceSystem(Update, 'movement', {
   *   name: 'movement',
   *   queries: [{ with: [Position] }],
   *   fn: (world, queryResults) => { ... },
   * });
   * ```
   */
  replaceSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
    schedule: import('./schedule-token').ScheduleToken,
    name: string,
    descriptor: SystemDescriptor<Qs>,
  ): Result<void, ScheduleMutationError | ScheduleScopeMismatchError> {
    return worldReplaceSystem(this, schedule, name, descriptor);
  }

  /**
   * Batch-register systems to a set. Validates the set token before writing.
   *
   * - First call for a system name: registers it via the existing `addSystem` path.
   * - Subsequent calls: only adds the system name to the set's members (dedup).
   *
   * Returns `Result.err` with `SystemSetNotRegisteredError` if the set token
   * fails identity validation.
   *
   * @example
   * ```ts
   * const GameplaySet = defineSystemSet({ name: 'gameplay' });
   * const world = new World();
   * const r = world.addSystems(Update, GameplaySet, [movement, collision]);
   * if (!r.ok) console.error(r.error.code, r.error.hint);
   * ```
   */
  addSystems<const Qs extends ReadonlyArray<QueryDescriptor>>(
    schedule: import('./schedule-token').ScheduleToken,
    set: SystemSet,
    systems: ReadonlyArray<SystemDescriptor<Qs>>,
  ): Result<void, SystemSetNotRegisteredError | ScheduleScopeMismatchError> {
    return worldAddSystems(this, schedule, set, systems);
  }

  /**
   * Execute one frame: run all systems in DAG order, then flush deferred commands.
   * Empty world (no systems) completes silently (E-09).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * world.update(); // run all systems + flush commands
   * ```
   */
  update(
    deltaSeconds = 0,
  ): Result<
    void,
    | TimeDeltaInvalidError
    | TimeConfigInvalidError
    | ScheduleScopeMismatchError
    | WorldPoisonedError
    | CommandFailedError
    | SystemFailedError
    | import('./errors').CyclicDependencyError
    | SharedKernelFailureError
  > {
    return worldUpdate(this, deltaSeconds);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Resource CRUD (M3)
  // ──────────────────────────────────────────────────────────────────────────

  /** Insert or overwrite a resource (idempotent, E-13). */
  insertResource<T>(key: string | { readonly name: string }, value: T): void {
    worldInsertResource(this, key, value);
  }

  /**
   * Get a resource by key.
   * @throws ResourceNotFoundError if key not found (E-14).
   */
  getResource(key: typeof import('./time').Time): import('./time').TimeResource;
  getResource(key: typeof import('./time').FixedTime): import('./time').FixedTimeResource;
  getResource<T>(key: string | { readonly name: string }): T;
  getResource<T>(key: string | { readonly name: string }): T {
    return worldGetResource<T>(this, key);
  }

  /** Check if a resource exists. */
  hasResource(key: string | { readonly name: string }): boolean {
    return worldHasResource(this, key);
  }

  /** Remove a resource by key. */
  removeResource(key: string | { readonly name: string }): void {
    worldRemoveResource(this, key);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Inspection / diagnostics (M4)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Return a typed diagnostic snapshot of the World state.
   * All fields are non-undefined. Useful for AI users to programmatically
   * introspect entity count, archetypes, registered components, systems,
   * and resources without console.log or a debugger.
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * const snap = world.inspect();
   * console.log(snap.entityCount, snap.activeComponents);
   * ```
   */
  inspect(): WorldInspection {
    return detachWorldInspection(worldInspect(this));
  }

  /** Read the actual component vocabulary of one live entity, including sparse tags. */
  componentsOf(entity: EntityHandle): Result<readonly Component[], EcsError> {
    const record = this.lookupAlive(entity, 'componentsOf');
    if (!record.ok) return record;
    return ok([...(this.graph.archetypes[record.value.archetypeId]?.components ?? [])]);
  }

  /** Return the registered schedule graphs and their declared access metadata. */
  scheduleData(): ReadonlyArray<WorldScheduleData> {
    return worldScheduleData(this);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Managed-ref public API (feat-20260528-rapier-physics M1 / t4)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Allocate a standalone managed reference handle with an optional release
   * callback. Returns a branded {@link Handle}<Target, 'unique'> that can be
   * stored in schema-vocab `ref<T>` fields or resolved through
   * {@link UniqueRefStore.resolve} (via `world.get` on a component with
   * `ref<T>` fields).
   *
   * When the handle is released (despawn / removeComponent / set-overwrite),
   * the `onRelease` callback fires with the payload (captured on the stack);
   * by then the slot's bookkeeping (callback table, payload map, freelist) is
   * already cleared, so a *throwing* `onRelease` re-propagates from the first
   * `release` call without leaving the store inconsistent — a second `release`
   * of the same handle returns `UniqueRefDoubleReleaseError` as expected. RAII
   * cleanup semantics preserved (plan-strategy D-5; throw-safety AC-01/02).
   *
   * Handles are *operational, not persistent*: caching them across release
   * boundaries (despawn / removeComponent / set-overwrite) is undefined
   * behavior — the same `u32` may silently resolve to a freshly allocated
   * payload after slot reuse. See `packages/ecs/README.md` § "Managed handles
   * are operational, not persistent" and `docs/specs/2026-06-14-ecs-managed-
   * lifecycle-ssot-design.md` § 3.3.
   *
   * @typeParam Target - phantom string branding the handle (type-level only).
   * @typeParam T - the payload type stored alongside the handle.
   * @param target - phantom target string (type-level discriminant).
   * @param payload - the value to store. Identity-stable until release.
   * @param onRelease - optional cleanup hook called with the payload on release.
   * @returns a branded `Handle<Target, 'unique'>` u32.
   *
   * @example
   * ```ts
   * const world = new World();
   * const handle = world.allocUniqueRef<'PhysicsBody', RigidBodyHandle>(
   *   'PhysicsBody',
   *   rapierHandle,
   *   (h) => rapierWorld.removeRigidBody(h),
   * );
   * const Holder = defineComponent('Holder', { body: 'unique<PhysicsBody>' });
   * world.spawn(Holder, { body: handle });
   * // Despawn triggers onRelease -> Rapier body is cleaned up.
   * ```
   */
  allocUniqueRef<Target extends string, T>(
    target: Target,
    payload: T,
    onRelease?: (payload: T) => void,
  ): Handle<Target, 'unique'> {
    return this.uniqueRefs.alloc(target, payload, onRelease);
  }

  /** Resolve a live managed payload without exposing its release or mutation owner. */
  resolveUniqueRef<T>(
    handle: Handle<string, 'unique'>,
  ): Result<T, UniqueRefReleasedError | UniqueRefStaleError> {
    return this.uniqueRefs.resolve<string, T>(handle);
  }

  /**
   * Allocate a shared (refcount-tracked) handle through the per-World
   * {@link SharedRefStore}. Returns a `Handle<Target, 'shared'>` u32 with
   * rc=1 (the alloc-grant). Consumers retain/release via `world.sharedRefs`.
   *
   * Final release publishes structured evidence through the owning
   * {@link SharedRefStore}; payload disposal remains with the
   * renderer/assets/plugin owner and is not a user callback.
   *
   * Intended for asset-registry-style producers — anything whose lifecycle
   * is shared across multiple holders (ECS components + external systems).
   * The single-holder one-shot release pattern stays on
   * {@link World.allocUniqueRef} (`Handle<T, 'unique'>`).
   *
   * @typeParam Target - phantom string branding the handle (type-level only).
   * @typeParam T - the payload type stored alongside the handle.
   * @param target - phantom target string (type-level discriminant).
   * @param payload - the value to store. Identity-stable until final release.
   * @returns a branded `Handle<Target, 'shared'>` u32 with rc=1.
   *
   * @example
   * ```ts
   * const world = new World();
   * const handle = world.allocSharedRef<'MaterialAsset', MaterialPayload>(
   *   'MaterialAsset',
   *   payload,
   * );
   * const M = defineComponent('M', { asset: 'shared<MaterialAsset>' });
   * world.spawn({ component: M, data: { asset: handle } });
   * // The write-barrier dispatch retains/releases automatically on spawn / despawn.
   * ```
   */
  allocSharedRef<Target extends string, T>(target: Target, payload: T): Handle<Target, 'shared'> {
    return this.sharedRefs.alloc(target, payload);
  }

  /**
   * Return one producer-owned shared handle per `(target, payload object)` in
   * this World. Repeated discovery does not retain; ECS holders still retain
   * and release through the normal write barrier. Asset catalogues use this
   * when repeated scene instantiation resolves the same catalogued payload.
   * Use {@link World.allocSharedRef} for independent resources or deleters.
   */
  internSharedRef<Target extends string, T extends object>(
    target: Target,
    payload: T,
  ): Handle<Target, 'shared'> {
    return this.sharedRefs.intern(target, payload);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────────────
  // Component access and storage — World owns mutation state and coordination.
  // Independent table/column algorithms remain private methods so all mutation
  // paths share one state owner and publication boundary.
  // ──────────────────────────────────────────────────────────────────────────

  private relationshipTargetWriteError(
    component: Component,
    operation: string,
  ): Result<never, EcsError> {
    return err(new RelationshipTargetReadonlyError(component.name, operation));
  }

  private relationshipTargetPayloadWrites(data: Readonly<Record<string, unknown>>): boolean {
    return Object.values(data).some((value) => {
      if (Array.isArray(value)) return value.length > 0;
      if (ArrayBuffer.isView(value)) return value.byteLength > 0;
      return true;
    });
  }

  /** Test live component presence without constructing a Result error. */
  hasComponent(entity: EntityHandle, component: Component): boolean {
    const archetype = this.internalgetEntityArchetype(entity);
    return (
      archetype !== undefined &&
      archetype.components.length > 0 &&
      archetypeHasComponent(archetype, componentId(component))
    );
  }

  private table(archetype: Archetype): Table {
    return getTable(this.graph, archetype.tableId);
  }

  private tableRow(record: EntityRecord): number {
    return this.graph.archetypes[record.archetypeId]?.rows[record.archetypeRow] ?? -1;
  }

  private markComponentChanged(entity: EntityHandle, component: Component): void {
    this.internalmarkComponentChanged(entity, componentId(component));
  }

  private relationshipIndex(component: Component): RelationshipIndex | undefined {
    if (relationshipRole(component)?.kind !== 'source') return undefined;
    let index = this.relationshipIndexes.get(componentId(component));
    if (index === undefined) {
      index = new RelationshipIndex();
      this.relationshipIndexes.set(componentId(component), index);
    }
    return index;
  }

  /** Read the World-owned materialized target array; never consults a shadow list. */
  private relationshipTargetEntries(
    source: Component,
    target: EntityHandle,
  ): readonly EntityHandle[] {
    const role = relationshipRole(source);
    if (role?.kind !== 'source') return [];
    const mirror = relationshipMirror(source);
    if (mirror === undefined) return [];
    // Internal relationship maintenance may read the live mirror view
    // directly; the public `get` path clones target arrays to keep them
    // read-only. Avoid allocating a component snapshot on every append or
    // removal while retaining the same World-owned storage authority.
    return (
      (this.getArrayView(target, mirror, role.targetField) as EntityHandle[] | undefined) ?? []
    );
  }

  /** Read a relationship target length without materialising its array view. */
  private relationshipTargetLength(source: Component, target: EntityHandle): number {
    const role = relationshipRole(source);
    if (role?.kind !== 'source') return 0;
    const mirror = relationshipMirror(source);
    if (mirror === undefined) return 0;
    return this.internalgetArrayLength(target, mirror, role.targetField) ?? 0;
  }

  private relationshipTargetEntity(
    component: Component,
    value: Record<string, unknown>,
  ): EntityHandle | null {
    for (const [fieldName, fieldType] of Object.entries(componentSchema(component))) {
      if (isEntityField(fieldType)) {
        const raw = value[fieldName];
        if (raw === null || raw === undefined) return null;
        const asNum = raw as number;
        if (asNum === ENTITY_NULL_RAW) return null;
        return asNum as EntityHandle;
      }
    }
    return null;
  }

  private preflightComponentFieldValues(
    holder: EntityHandle | null,
    componentData: ComponentData,
  ): Result<void, EcsError> {
    const data = componentData.data as Record<string, unknown>;
    const arrayError = validateManagedArrayValues(componentData.component, data);
    if (arrayError !== null) return err(arrayError as unknown as EcsError);
    const sharedError = validateSharedFieldValues(componentData.component, data);
    if (sharedError !== null) return err(sharedError as unknown as EcsError);
    const numericError = validateNumericFieldValues(
      componentData.component,
      data,
      holder === null ? undefined : (holder as number),
    );
    if (numericError !== null) return err(numericError as unknown as EcsError);
    return ok(undefined);
  }

  /**
   * Validate one structural component payload without touching archetypes,
   * columns, relationship mirrors, epochs, or managed-reference stores.
   * CommandBuffer uses this same owner-level gate as the direct World facade;
   * the optional pending set lets a batch refer to an entity reserved earlier
   * in that batch without mistaking it for a stale live handle.
   */
  private preflightComponentData(
    holder: EntityHandle | null,
    componentData: ComponentData,
    pendingEntities?: ReadonlySet<number>,
    unavailableEntities?: ReadonlySet<number>,
  ): Result<void, EcsError> {
    const data = componentData.data as Record<string, unknown>;
    const keyError = validateComponentDataKeys(componentData.component, data);
    if (keyError !== null) return err(keyError as unknown as EcsError);
    const valuePreflight = this.preflightComponentFieldValues(holder, componentData);
    if (!valuePreflight.ok) return valuePreflight;
    if (
      isRelationshipTarget(componentData.component) &&
      this.relationshipTargetPayloadWrites(data)
    ) {
      return err(new RelationshipTargetReadonlyError(componentData.component.name, 'command'));
    }

    const filled = fillComponentDefaults(componentData.component, data);
    const enumError = validateEnumFieldValues(
      componentData.component,
      filled,
      holder === null ? undefined : (holder as number),
    );
    if (enumError !== null) return err(enumError as unknown as EcsError);

    const role = relationshipRole(componentData.component as Component);
    if (role?.kind !== 'source') return ok(undefined);
    const target = this.relationshipTargetEntity(componentData.component as Component, filled);
    if (target === null) return ok(undefined);

    const targetRaw = target as unknown as number;
    if (unavailableEntities?.has(targetRaw) === true) {
      const targetRecord = this.records[entityIndex(target)];
      return err(
        new StaleEntityError(target as number, entityIndex(target), entityGeneration(target), {
          operation: 'relationship-insert',
          component: componentData.component.name,
          expectedGeneration: entityGeneration(target),
          actualGeneration: targetRecord?.generation ?? -1,
        }),
      );
    }
    const targetIsPending = pendingEntities?.has(targetRaw) === true;
    const targetRecord = this.records[entityIndex(target)];
    const actualGeneration = targetRecord?.generation ?? -1;
    const targetLive = this.recordIsLive(targetRecord, entityGeneration(target));
    const holderIsPending =
      holder === null || pendingEntities?.has(holder as unknown as number) === true;
    if (!targetIsPending && !targetLive && !holderIsPending) {
      return err(
        new StaleEntityError(target as number, entityIndex(target), entityGeneration(target), {
          operation: 'relationship-insert',
          component: componentData.component.name,
          expectedGeneration: entityGeneration(target),
          actualGeneration,
        }),
      );
    }

    // A pending holder has no row to walk yet. Once materialized, its target
    // is still checked by the same source-side relationship callback.
    if (holder === null || pendingEntities?.has(holder as unknown as number) === true) {
      return ok(undefined);
    }
    const roleAllowsSelf = role?.kind === 'source' && role.allowSelf;
    if (holder === target && !roleAllowsSelf) {
      return err(
        new RelationshipSelfCycleError(
          componentData.component.name,
          holder as number,
          target as number,
        ),
      );
    }

    const cycleHit =
      holder === target && roleAllowsSelf
        ? null
        : this.relationshipCycleHit(componentData.component as Component, target, holder);
    if (cycleHit !== null) {
      return err(
        new RelationshipSelfCycleError(
          componentData.component.name,
          holder as number,
          cycleHit as number,
        ),
      );
    }
    return ok(undefined);
  }

  private relationshipCycleHit(
    holderComponent: Component,
    start: EntityHandle,
    holder: EntityHandle,
  ): EntityHandle | null {
    const visited = new Set<number>();
    let current = start;
    while (true) {
      if (current === holder) return current;
      const raw = current as unknown as number;
      if (visited.has(raw)) return null;
      visited.add(raw);
      const record = this.records[entityIndex(current)];
      if (!this.recordIsLive(record, entityGeneration(current))) return null;
      const archetype = this.graph.archetypes[record.archetypeId];
      if (
        archetype === undefined ||
        !archetypeHasComponent(archetype, componentId(holderComponent))
      ) {
        return null;
      }
      const value = this.readRow(archetype, holderComponent, this.tableRow(record)) as Record<
        string,
        unknown
      >;
      const next = this.relationshipTargetEntity(holderComponent, value);
      if (next === null) return null;
      current = next;
    }
  }

  /**
   * Commit a relationship source through its owner-specific write path.
   * Relationship sources have one entity field, so dispatching before the
   * generic field loop avoids paying the ordinary component-field traversal on
   * every hierarchy reparent while keeping mirror/index publication here.
   */
  private setRelationshipSource(
    entity: EntityHandle,
    component: Component,
    value: Record<string, unknown>,
    record: EntityRecord,
    arch: Archetype,
    markChanged: boolean,
  ): Result<void, EcsError> {
    const role = relationshipRole(component);
    if (role?.kind !== 'source') return ok(undefined);

    const row = this.tableRow(record);
    const currentValue = this.readRow(arch, component, row) as Record<string, unknown>;
    const valuePreflight = this.preflightComponentFieldValues(entity, {
      component,
      data: value as Partial<InputShapeOf<ComponentSchema>>,
    });
    if (!valuePreflight.ok) return valuePreflight;

    const mergedValue = {
      ...currentValue,
      ...value,
    };
    const enumError = validateEnumFieldValues(component, mergedValue, entity as number);
    if (enumError !== null) return err(enumError as unknown as EcsError);

    const oldRelationshipTarget = this.relationshipTargetEntity(component, currentValue);
    const nextRelationshipTarget = this.relationshipTargetEntity(component, mergedValue);
    const relationshipChanged = oldRelationshipTarget !== nextRelationshipTarget;
    let preparedMirrorAdded: boolean | undefined;

    if (relationshipChanged && nextRelationshipTarget !== null) {
      // Keep the hot source-write path equivalent to the public relationship
      // preflight, without re-running the generic component-data validator
      // over the already-read/merged source row.
      const targetRecord = this.records[entityIndex(nextRelationshipTarget)];
      const actualGeneration = targetRecord?.generation ?? -1;
      if (!this.recordIsLive(targetRecord, entityGeneration(nextRelationshipTarget))) {
        return err(
          new StaleEntityError(
            nextRelationshipTarget as number,
            entityIndex(nextRelationshipTarget),
            entityGeneration(nextRelationshipTarget),
            {
              operation: 'relationship-insert',
              component: component.name,
              expectedGeneration: entityGeneration(nextRelationshipTarget),
              actualGeneration,
            },
          ),
        );
      }
      if (entity === nextRelationshipTarget && !role.allowSelf) {
        return err(
          new RelationshipSelfCycleError(
            component.name,
            entity as number,
            nextRelationshipTarget as number,
          ),
        );
      }
      const cycleHit =
        entity === nextRelationshipTarget
          ? null
          : this.relationshipCycleHit(component, nextRelationshipTarget, entity);
      if (cycleHit !== null) {
        return err(
          new RelationshipSelfCycleError(component.name, entity as number, cycleHit as number),
        );
      }
      const prepared = this.prepareRelationshipInsert(component, mergedValue);
      if (!prepared.ok) return prepared;
      preparedMirrorAdded = prepared.value;
    }

    // Prepare first, then detach/attach the mirror, and only then publish the
    // source scalar. A later relationship error can therefore poison the same
    // World without exposing a source value that disagrees with its mirror.
    if (relationshipChanged && oldRelationshipTarget !== null) {
      const removed = this.relationshipOnRemove(entity, component, currentValue);
      if (!removed.ok) {
        this.poisonAfterEntityMutation('World.set', removed.error);
        return removed;
      }
    }
    if (relationshipChanged && nextRelationshipTarget !== null) {
      const inserted = this.relationshipOnInsert(
        entity,
        component,
        mergedValue,
        preparedMirrorAdded,
      );
      if (!inserted.ok) {
        this.poisonAfterEntityMutation('World.set', inserted.error);
        return inserted;
      }
    }

    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    const sourceColumn = fieldCols?.get(role.sourceField);
    if (sourceColumn === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    sourceColumn.view[row] =
      nextRelationshipTarget === null ? ENTITY_NULL_RAW : (nextRelationshipTarget as number);
    if (markChanged) this.markComponentChanged(entity, component);
    return ok(undefined);
  }

  /** Prepare the target side before a source archetype mutation commits. */
  private prepareRelationshipInsert(
    component: Component,
    value: Record<string, unknown>,
  ): Result<boolean, EcsError> {
    const role = relationshipRole(component);
    if (role?.kind !== 'source') return ok(false);
    const target = this.relationshipTargetEntity(component, value);
    if (target === null) return ok(false);
    const mirror = relationshipMirror(component);
    if (mirror === undefined) return ok(false);
    const targetRec = this.records[entityIndex(target)];
    const actualGeneration = targetRec?.generation ?? -1;
    if (!this.recordIsLive(targetRec, entityGeneration(target))) {
      return err(
        new StaleEntityError(target as number, entityIndex(target), entityGeneration(target), {
          operation: 'relationship-insert',
          component: component.name,
          expectedGeneration: entityGeneration(target),
          actualGeneration,
        }),
      );
    }
    const targetArch = this.graph.archetypes[targetRec.archetypeId];
    const hasMirror =
      targetArch !== undefined && archetypeHasComponent(targetArch, componentId(mirror));
    let mirrorAdded = false;
    if (!hasMirror) {
      const added = this.addComponentCore(
        target,
        { component: mirror, data: {} as Partial<ShapeOf<ComponentSchema>> },
        true,
        false,
      );
      if (!added.ok) return added;
      mirrorAdded = true;
    }
    const length = this.relationshipTargetLength(component, target);
    const capacity = this.ensureArrayCapacity(target, mirror, role.targetField, length + 1);
    if (capacity.ok) return ok(mirrorAdded);
    if (mirrorAdded) {
      // Mirror creation is part of preparation, not publication. If capacity
      // reservation fails, remove the newly-created target component through
      // the silent internal path so the caller sees no target, epoch, or
      // structural evidence side effect.
      const rolledBack = this.removeComponentCore(target, mirror, true);
      if (!rolledBack.ok) {
        this.poisonAfterEntityMutation('World.prepareRelationshipInsert', rolledBack.error);
        return rolledBack;
      }
    }
    return capacity;
  }

  /** Append `holder` to the materialized target list. */
  private relationshipOnInsert(
    holder: EntityHandle,
    component: Component,
    value: Record<string, unknown>,
    // addComponentCore may have prepared the target before migrating the
    // source. Carry that one-shot fact so the final commit can publish a
    // newly-created mirror exactly once instead of preparing a second time.
    preparedMirrorAdded?: boolean,
  ): Result<void, EcsError> {
    const role = relationshipRole(component);
    if (role?.kind !== 'source') return ok(undefined);
    const target = this.relationshipTargetEntity(component, value);
    if (target === null) return ok(undefined);
    const mirror = relationshipMirror(component);
    /* istanbul ignore next -- defineComponent relationship validation guarantees mirror exists */
    if (mirror === undefined) return ok(undefined);

    let mirrorAdded = preparedMirrorAdded ?? false;
    if (preparedMirrorAdded === undefined) {
      const prepared = this.prepareRelationshipInsert(component, value);
      if (!prepared.ok) {
        // A dangling source edge is still useful state: hierarchy/animation
        // projections report the missing target. The target mirror cannot be
        // updated, but insertion itself remains atomic and successful.
        if (prepared.error.code === 'stale-entity') return ok(undefined);
        return prepared;
      }
      mirrorAdded = prepared.value;
    }

    // Lazy-create the mirror component on the target when absent (D-3c).
    const targetSlot = entityIndex(target);
    const targetRec = this.records[targetSlot];
    if (!this.recordIsLive(targetRec, entityGeneration(target))) return ok(undefined);
    const targetArch = this.graph.archetypes[targetRec.archetypeId];
    const mirrorLocalId = componentId(mirror);
    const hasMirror = targetArch !== undefined && archetypeHasComponent(targetArch, mirrorLocalId);
    if (!hasMirror) {
      const added = this.addComponentCore(
        target,
        {
          component: mirror,
          data: {} as Partial<ShapeOf<ComponentSchema>>,
        },
        true,
        false,
      );
      if (!added.ok) return added;
      mirrorAdded = true;
    }
    const slot = this.relationshipTargetLength(component, target);
    const mirrored = this.appendArrayElement(target, mirror, role.targetField, holder);
    if (!mirrored.ok) return mirrored;
    this.relationshipIndex(component)?.attach(holder, target, slot);
    if (mirrorAdded) {
      this.internalmarkComponentsAdded(target, [mirrorLocalId]);
      this.advanceStructureEpoch();
    }
    return ok(undefined);
  }

  /** Remove `holder` from the materialized target list. */
  private relationshipOnRemove(
    holder: EntityHandle,
    component: Component,
    oldValue: Record<string, unknown>,
  ): Result<void, EcsError> {
    const role = relationshipRole(component);
    if (role?.kind !== 'source') return ok(undefined);
    const target = this.relationshipTargetEntity(component, oldValue);
    if (target === null) return ok(undefined);
    const mirror = relationshipMirror(component);
    /* istanbul ignore next -- defineComponent relationship validation guarantees mirror exists */
    if (mirror === undefined) return ok(undefined);
    const targetSlot = entityIndex(target);
    const targetRec = this.records[targetSlot];
    if (!this.recordIsLive(targetRec, entityGeneration(target))) return ok(undefined);

    const index = this.relationshipIndex(component);
    if (index === undefined) return ok(undefined);
    const slot = index.slotOf(holder);
    if (slot === undefined || index.targetOf(holder) !== target) return ok(undefined);
    const mirrored = this.removeArrayElementAt(target, mirror, role.targetField, slot);
    if (!mirrored.ok) return mirrored;
    index.detach(holder);
    if (mirrored.value !== undefined) index.updateSlot(mirrored.value, target, slot);
    return ok(undefined);
  }

  private linkedSpawnMirrorField(mirror: Component): string | undefined {
    const source = relationshipSource(mirror);
    const role = source === undefined ? undefined : relationshipRole(source);
    return role?.kind === 'source' && role.linkedSpawn ? role.targetField : undefined;
  }

  private relationshipLinkedSpawnChildren(
    entity: EntityHandle,
    archetype: Archetype,
  ): EntityHandle[] {
    const record = this.records[entityIndex(entity)];
    const row = record === undefined ? -1 : this.tableRow(record);
    const collected: EntityHandle[] = [];
    for (const component of archetype.components) {
      const mirrorField = this.linkedSpawnMirrorField(component);
      if (mirrorField === undefined) continue;
      const snapshot = this.readRow(archetype, component, row) as Record<string, unknown>;
      const list = snapshot[mirrorField];
      if (!(list instanceof Uint32Array)) continue;
      for (const raw of list) {
        if (raw !== ENTITY_NULL_RAW) collected.push(raw as EntityHandle);
      }
    }
    return collected;
  }

  /**
   * Read component data from an entity.
   *
   * **Transient view contract (feat-20260602):** for fixed-capacity
   * `array<T,N>` and `buffer<N>` fields, the returned `TypedArray` (and any
   * subarray of it) aliases the archetype column buffer directly. The view is
   * valid only until the next structural change (`spawn` / `despawn` /
   * `addComponent` / `removeComponent`). Holding a view across a structural
   * change is undefined behaviour -- the backing `ArrayBuffer` is detached on
   * column growth, and swap-remove at the same row index points to the wrong
   * entity. **Re-fetch `world.get(e, C)` on every access.** See
   * `packages/ecs/README.md` Transient view contract section.
   *
   * @returns `Result<ShapeOf<S>, EcsError>` —
   *   `ok(ShapeOf<S>)` on success;
   *   `err(StaleEntityError)` (`.code = 'stale-entity'`) if entity is dead;
   *   `err(ComponentNotPresentError)` (`.code = 'component-not-present'`) if
   *   the entity does not have the component (a never-present component on
   *   this entity degrades to the same `component-not-present` path — there is
   *   no separate "not registered" failure; components are global at
   *   `defineComponent` time).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * const e = world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
   * const r = world.get(e, Position);
   * if (!r.ok) { return; } // r.error.code === 'stale-entity' on dead handle
   * const pos = r.value;
   * ```
   */
  get<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): Result<ShapeOf<S>, EcsError> {
    const componentName = component.name;
    const rec = this.liveEntityRecord(entity);
    if (rec === undefined) return this.staleEntityFailure(entity, 'get', componentName);
    const arch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'get',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }

    // Check if this archetype has the component (using World-local ID).
    const localId = componentId(component);
    if (!archetypeHasComponent(arch, localId)) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }

    return ok(this.readRow(arch, component, this.tableRow(rec)));
  }

  /**
   * Column-level zero-copy view of an `array<T, N>` / `array<T>` field.
   *
   * Resolves the live byte region for `(entity, component, fieldName)`
   * directly at the column level and returns the element-typed TypedArray
   * aliasing it (`view.buffer` is the SSOT byte region; mutations route
   * through `world.set`). Unlike `get`, this does NOT build the
   * `{}` whole-component object nor walk every schema field. Per-frame
   * consumers that need one column (the resolved world mat4) take this path to
   * avoid the `get` overhead (1 `{}` alloc + N-field readRow walk).
   *
   * Fixed `array<T,N>` columns (feat-20260602) store their elements inline, so
   * the view aliases the archetype column buffer directly (no BufferPool
   * indirection); variable `array<T>` columns still alias the BufferPool slot.
   * The returned view's element type follows the schema element type
   * (`array<entity,N>` -> `Uint32Array`, `array<f32,N>` -> `Float32Array`,
   * etc.) -- the prior f32-only early-return gate is removed.
   *
   * **Transient view contract:** the returned `TypedArray` aliases the column
   * buffer and is valid only until the next structural change (`spawn` /
   * `despawn` / `addComponent` / `removeComponent`). Column growth
   * (`growColumn`) detaches the old `ArrayBuffer` via `transfer()`; a
   * swap-remove at the same row index leaves the view pointing to the wrong
   * entity. **Callers must re-fetch `getArrayView` on every access** and must
   * not hold the view across any operation that may cause archetype migration.
   * All existing per-frame consumers (`propagateTransforms` / `render-extract`
   * / `pick`) already conform -- they fetch the view inside a single pass with
   * no intervening structural changes.
   *
   * Returns `undefined` when the entity is dead, the component is absent, the
   * field does not exist, or the field is not an `array<...>` column.
   *
   * Engine-internal fast path; AI users read the typed view through
   * `world.get(e, GlobalTransform).world`. The accessor is the zero-materialization
   * route the propagate kernel and render walk use.
   */
  private getArrayView(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): FieldView | undefined {
    const record = this.lookupAlive(entity, 'getArrayView', component.name);
    if (!record.ok) return undefined;

    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    if (!arch) return undefined;
    return this.readArrayView(arch, component, this.tableRow(rec), fieldName);
  }

  /**
   * Overwrite `values.length` elements of a numeric `array<T>` / `array<T,N>`
   * field in place, starting at element `offset`. The array keeps its length
   * and storage; only the written window changes. The component is marked
   * changed and the window is recorded so render projections can upload just
   * the dirty rows instead of the whole array.
   *
   * @returns `Result<void, EcsError>` —
   *   `err(StaleEntityError)` for a dead handle;
   *   `err(ComponentNotPresentError)` when the entity lacks the component;
   *   `err(ArrayRangeOutOfBoundsError)` (`.code = 'array-range-out-of-bounds'`)
   *   when the window leaves `[0, length)` or the field is not a numeric array
   *   (`.detail.size === -1`). Use `set` to resize.
   *
   * @example
   * ```ts
   * // Move instance row 7 of a 64k-row Instances collection: 16 floats written.
   * world.setArrayRange(entity, Instances, 'transforms', 7 * 16, rowMatrix).unwrap();
   * ```
   */
  setArrayRange<S extends ComponentSchema, C extends Component<string, S>>(
    entity: EntityHandle,
    component: C & WritableComponent<C>,
    fieldName: keyof S & string,
    offset: number,
    values: ArrayLike<number>,
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    if (isRelationshipTarget(component)) {
      return this.relationshipTargetWriteError(component, 'setArrayRange');
    }
    const record = this.lookupAlive(entity, 'setArrayRange', component.name);
    if (!record.ok) return record;
    const arch = this.graph.archetypes[record.value.archetypeId];
    const localId = componentId(component);
    if (arch === undefined || !archetypeHasComponent(arch, localId)) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const elementType = componentDefinition(component).fields[fieldName]?.arrayMeta?.elementType;
    const numeric =
      elementType !== undefined && elementType !== 'entity' && !elementType.startsWith('shared<');
    const view =
      numeric && component.storage !== 'sparse'
        ? this.readArrayView(arch, component, this.tableRow(record.value), fieldName)
        : undefined;
    if (view === undefined) {
      return err(
        new ArrayRangeOutOfBoundsError(component.name, fieldName, offset, values.length, -1),
      );
    }
    if (!Number.isInteger(offset) || offset < 0 || offset + values.length > view.length) {
      return err(
        new ArrayRangeOutOfBoundsError(
          component.name,
          fieldName,
          offset,
          values.length,
          view.length,
        ),
      );
    }
    if (values.length === 0) return ok(undefined);
    const previous = this.internalgetComponentChange(entity, localId)?.changed ?? 0;
    (view as Float32Array).set(values, offset);
    this.internalmarkComponentChanged(entity, localId);
    const epoch = this.internalgetComponentChange(entity, localId)?.changed ?? previous;
    this.arrayRangeLog.record(
      entity as number,
      localId,
      fieldName,
      previous,
      epoch,
      offset,
      offset + values.length,
    );
    return ok(undefined);
  }

  /** Element ranges of one array field written after `since`, or `'whole'`. */
  private internalgetArrayRangesChangedSince(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
    since: number,
  ): ArrayRangesChange {
    const localId = componentId(component);
    const current = this.internalgetComponentChange(entity, localId);
    if (current === undefined) return 'whole';
    return this.arrayRangeLog.changedSince(
      entity as number,
      localId,
      fieldName,
      since,
      current.changed,
    );
  }

  /**
   * Write (partial) component data to an entity.
   * Equal stored scalar values do not advance change evidence. Array, buffer
   * and managed writes remain explicit publications, including mutable aliases.
   *
   * @returns `Result<void, EcsError>` —
   *   `ok(void)` on success;
   *   `err(StaleEntityError)` (`.code = 'stale-entity'`) if entity is dead;
   *   `err(ComponentNotPresentError)` (`.code = 'component-not-present'`) if
   *   entity does not have the component (F-02: no longer silently ignores).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * const r = world.set(e, Position, { x: 10 });
   * if (!r.ok) { return; } // r.error.code === 'stale-entity' on dead handle
   * r.unwrap();
   * ```
   */
  set<S extends ComponentSchema, C extends Component<string, S>>(
    entity: EntityHandle,
    component: C & WritableComponent<C>,
    value: Partial<InputShapeOf<S>>,
    markChanged = true,
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    if (isRelationshipTarget(component)) return this.relationshipTargetWriteError(component, 'set');
    const record = this.lookupAlive(entity, 'set', component.name);
    if (!record.ok) return record;

    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'set',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }
    const row = this.tableRow(rec);
    const localId = componentId(component);
    if (!archetypeHasComponent(arch, localId)) {
      // F-02: set on missing component returns err instead of silent ignore
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const relationship = relationshipRole(component);
    if (relationship?.kind === 'source') {
      return this.setRelationshipSource(
        entity,
        component,
        value as Record<string, unknown>,
        rec,
        arch,
        markChanged,
      );
    }
    const valuePreflight = this.preflightComponentFieldValues(entity, {
      component,
      data: value,
    });
    if (!valuePreflight.ok) return valuePreflight;
    // Enum constraints are field-local; untouched fields are already validated.
    const enumError = validateEnumFieldValues(component, value, entity as number);
    if (enumError !== null) return err(enumError as unknown as EcsError);

    if (component.storage === 'sparse') {
      if (markChanged) this.markComponentChanged(entity, component);
      return ok(undefined);
    }
    const fieldCols = this.table(arch).storage.get(localId)?.fields;
    if (fieldCols === undefined) {
      throw new Error(`Table storage for ${component.name} does not exist.`);
    }
    let changed = false;
    const definition = componentDefinition(component);
    for (const fieldName of Object.keys(value)) {
      const col = fieldCols.get(fieldName);
      if (!col) {
        continue;
      }
      const fieldType = (componentSchema(component) as Record<string, string>)[fieldName] ?? '';
      const arrayMeta = definition.fields[fieldName]?.arrayMeta;
      const managed = isManagedField(fieldType);
      const previous = col.view[row];
      // Payload writes remain explicit publications: aliases may already have
      // changed, and managed allocation/release paths own lifecycle effects.
      changed ||= managed || arrayMeta !== undefined || isManagedBufferField(fieldType);
      // M1/M2 release loop (set path): release the prior managed value
      // BEFORE writing the new one. Single SSOT helper `releaseManagedFieldOnRow`
      // (feat-20260614 D-2) covers every managed-field family (`ref<T>` /
      // `string` / `buffer` / variable `array<T>`); it self-skips fields that
      // do not match `isManagedField` here, but for set-ref/string we already
      // gated on it so the call is hot. Zeroes the column when applicable.
      if (managed) {
        this.releaseManagedFieldOnRow(arch, component, row, fieldName);
      }
      const raw = (value as Record<string, unknown>)[fieldName];
      if (fieldType === 'bool') {
        col.view[row] = raw ? 1 : 0;
      } else if (isEntityField(fieldType)) {
        // M3 entity field overwrite: encode null as ENTITY_NULL_RAW;
        // otherwise store the Entity bit pattern (slot+gen).
        col.view[row] = raw === null || raw === undefined ? ENTITY_NULL_RAW : (raw as number);
      } else if (isManagedBufferField(fieldType)) {
        // M2 set path: collapsed-vocab keyword family `'buffer'` (variable) +
        // `'buffer<N>'` (fixed). The two shapes diverge here:
        //   - `buffer<N>` — schema-declared byteLength is fixed; raw must be a
        //     `Uint8Array` whose `byteLength === N`. Mismatched payloads route
        //     `FixedSizeMismatchError` via Result.err so AI users observe an
        //     explicit failure instead of silent truncation (verify round 1
        //     B1 fix; charter P3 — explicit failure > silent acceptance).
        //   - `'buffer'`  — variable capacity; release the prior slot then
        //     alloc a fresh one sized to the new payload's byteLength (mirrors
        //     the `array<T>` set path's release-then-alloc D-5 ordering).
        //   raw is normalized from any AllowSharedBufferSource view to a
        //   Uint8Array over its bytes (feat-20260621 V2 / AC-A4). Non-buffer
        //   raw (a forced cast feeding e.g. a number) normalizes to null and
        //   is treated as a no-op (column slot stays unchanged).
        const isFixedBuffer = fieldType !== 'buffer';
        const bytes = normalizeBufferWrite(raw);
        if (bytes !== null) {
          if (isFixedBuffer) {
            // feat-20260602: fixed `buffer<N>` lives inline as a stride-N u8
            // column (arity = N bytes). Write the payload straight into the
            // row window -- no BufferPool slot.
            const expected = bufferFieldByteLength(fieldType);
            if (bytes.byteLength !== expected) {
              return err(new FixedSizeMismatchError(fieldName, expected, bytes.byteLength));
            }
            const arity = col.arity;
            (col.view as Uint8Array).set(bytes.subarray(0, arity), row * arity);
          } else {
            // Variable `'buffer'` set: release prior slot via SSOT helper
            // (feat-20260614 D-2) then alloc fresh sized to the new payload
            // (verify round 1 B2 fix path). The helper zeroes the column on
            // release; sentinel slot id 0 is a no-op.
            this.releaseManagedFieldOnRow(arch, component, row, fieldName);
            const allocR = this.bufferPool.alloc(bytes.byteLength);
            if (!allocR.ok) {
              const ctx: ErrorContext = {
                systemName: `World.set (${component.name}.${fieldName})`,
              };
              this.routeError(allocR.error as EcsError, ctx);
              col.view[row] = 0;
              continue;
            }
            const slot = allocR.value;
            slot.view.set(bytes);
            col.view[row] = slot.id;
          }
        }
      } else if (fieldType === 'string') {
        // M1 string-field set path (AC-05 path 3): the prior handle was
        // already released by the unified `isManagedField` pre-write block
        // above (D-R3) -- here we just alloc the new handle and store the
        // u32. Mirrors the array<T> release-then-alloc pattern (D-5) so AI
        // users observe the UniqueRefStore _liveCount net-zero invariant
        // on field overwrite. Missing / non-string raw -> '' fallback
        // (AC-06).
        const text = typeof raw === 'string' ? raw : '';
        const handle = this.uniqueRefs.alloc<'String'>('String', text);
        col.view[row] = unwrapHandle(handle);
      } else {
        if (arrayMeta !== undefined) {
          // M1 set path for array<T> / array<T,N> fields (feat-20260614 D-3
          // calling convention). The set semantics mirror spawn: release the
          // prior slot via the SSOT helper, then alloc a fresh one sized to
          // the new value, copy bytes verbatim, store slot id (+ count for
          // variable). Fixed `array<T,N>` is inline — the helper short-
          // circuits and writeArrayField writes directly into the row's
          // stride window with no pool traffic.
          this.releaseManagedFieldOnRow(arch, component, row, fieldName);
          this.writeArrayField(arch, component, row, fieldName, fieldType, arrayMeta, raw);
        } else {
          // The pre-write `releaseManagedFieldOnRow` block above already
          // released the prior `'shared<T>'` rc via SharedRefStore.release;
          // here we retain the new value so net rc delta is +1 / 0 / -1 per
          // M4 invariant (set: -1+1=0; spawn: 0+1=+1; despawn: -1).
          col.view[row] = raw as number;
          if (fieldType.startsWith('shared<') && (raw as number) !== 0) {
            this.retainSharedScalarHandle(raw as number, component.name, fieldName);
          }
        }
      }
      // Scalars are owned column values: compare the stored representation,
      // including f32 rounding and integer conversion.
      changed ||= !Object.is(previous, col.view[row]);
    }
    if (markChanged && changed) this.markComponentChanged(entity, component);
    return ok(undefined);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal relationship array maintenance. Public array mutation is always
  // expressed as one `world.set` payload; these helpers only implement the
  // engine-owned target projection and backpointer swap-remove path.
  //
  // Append/remove are engine-owned relationship maintenance only.
  //
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Append `value` to the variable `array<T>` field `fieldName` on `entity`.
   *
   * BufferPool grow is amortized O(1) via the size-class freelist (research
   * Finding 5). Relationship target arrays grow byte-wise.
   *
   * @returns `Result<void, EcsError>` with the normal stale/component errors.
   *
   * The helper is called only by relationship synchronization.
   */
  private appendArrayElement(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
    value: EntityHandle,
  ): Result<void, EcsError> {
    const record = this.lookupAlive(entity, 'relationship-append', component.name);
    if (!record.ok) return record;
    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- alive record always has a valid archetype */
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'relationship-append',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }
    const row = this.tableRow(rec);
    const localId = componentId(component);
    const fieldCols = this.table(arch).storage.get(localId)?.fields;
    if (!fieldCols) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const col = fieldCols.get(fieldName);
    if (!col) return err(new ComponentNotPresentError(entity as number, component.name));
    const arrayMeta = componentDefinition(component).fields[fieldName]?.arrayMeta;
    if (arrayMeta === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const meta = TYPE_METADATA[arrayMeta.elementType];
    /* istanbul ignore next -- arrayMeta.elementType is guaranteed in TYPE_METADATA */
    if (!meta) return err(new ComponentNotPresentError(entity as number, component.name));
    // biome-ignore lint/style/noNonNullAssertion: every array element type has a byte size
    const elementBytes = meta.byteSize!;
    const slotId = col.view[row] as number;

    const countCol = fieldCols.get(arrayCountColumnName(fieldName));
    /* istanbul ignore next -- variable arrays always allocate the count column */
    if (countCol === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const count = countCol.view[row] as number;
    const newCount = count + 1;
    const newByteLength = newCount * elementBytes;

    let liveSlotId = slotId;
    if (liveSlotId === 0) {
      // Empty/unallocated slot — alloc fresh.
      const allocR = this.bufferPool.alloc(newByteLength);
      if (!allocR.ok) return err(allocR.error);
      liveSlotId = allocR.value.id;
      col.view[row] = liveSlotId;
    } else {
      // A previously-allocated slot may have drained below its high-water
      // mark: swap-remove (`_removeArrayElementByValue`) and `pop` only lower
      // the count column, never shrink the managed buffer. When the refilled
      // length still fits inside the slot's current logical length, reuse the
      // buffer in place -- routing through `grow` would hit the (correct, but
      // here irrelevant) shrink-not-supported guard and strand the field
      // (e.g. `Children.entities` never repopulating after a full drain).
      if (newByteLength > this.bufferPool.view(liveSlotId).byteLength) {
        const growR = this.bufferPool.grow(liveSlotId, newByteLength);
        if (!growR.ok) return err(growR.error);
      }
    }
    const liveBytes = this.bufferPool.view(liveSlotId);
    // Reinterpret the slot bytes as the element-typed view and write at the
    // tail index. Entity values are stored as their u32 bit pattern.
    writeArrayElementAt(liveBytes, count, arrayMeta.elementType, value as number);
    countCol.view[row] = newCount;
    this.markComponentChanged(entity, component);
    return ok(undefined);
  }

  private ensureArrayCapacity(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
    minimum: number,
  ): Result<void, EcsError> {
    const record = this.lookupAlive(entity, 'relationship-capacity', component.name);
    if (!record.ok) return record;
    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    if (!arch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'relationship-capacity',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }
    const row = this.tableRow(rec);
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    if (!fieldCols) return err(new ComponentNotPresentError(entity as number, component.name));
    const col = fieldCols.get(fieldName);
    if (!col) return err(new ComponentNotPresentError(entity as number, component.name));
    const arrayMeta = componentDefinition(component).fields[fieldName]?.arrayMeta;
    if (arrayMeta === undefined) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const meta = TYPE_METADATA[arrayMeta.elementType];
    if (!meta?.byteSize) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const maximum = Math.floor(262_144 / meta.byteSize);
    if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > maximum) {
      return err(new ManagedBufferOutOfBoundsError(minimum, maximum));
    }

    const byteLength = minimum * meta.byteSize;
    const slotId = col.view[row] as number;
    if (slotId === 0) {
      if (minimum === 0) return ok(undefined);
      const allocated = this.bufferPool.alloc(byteLength);
      if (!allocated.ok) return allocated;
      col.view[row] = allocated.value.id;
      return ok(undefined);
    }
    if (this.bufferPool.view(slotId).byteLength >= byteLength) return ok(undefined);
    const grown = this.bufferPool.grow(slotId, byteLength);
    return grown.ok ? ok(undefined) : grown;
  }

  /**
   * Remove one variable-array element at a known slot. Relationship holders
   * supply the slot from their backpointer, so this is O(1) and never scans
   * the materialized target array.
   */
  private removeArrayElementAt(
    entity: EntityHandle,
    component: Component<string, ComponentSchema>,
    fieldName: string,
    slot: number,
  ): Result<EntityHandle | undefined, EcsError> {
    const record = this.lookupAlive(entity, 'removeArrayElementAt', component.name);
    if (!record.ok) return record;
    const rec = record.value;
    const arch = this.graph.archetypes[rec.archetypeId];
    if (!arch) return err(new ComponentNotPresentError(entity as number, component.name));
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    if (!fieldCols) return err(new ComponentNotPresentError(entity as number, component.name));
    const col = fieldCols.get(fieldName);
    const arrayMeta = componentDefinition(component).fields[fieldName]?.arrayMeta;
    const countCol = fieldCols.get(arrayCountColumnName(fieldName));
    if (!col || !arrayMeta || arrayMeta.length !== undefined || !countCol) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const row = this.tableRow(rec);
    const count = countCol.view[row] as number;
    if (slot < 0 || slot >= count) return ok(undefined);
    const slotId = col.view[row] as number;
    if (slotId === 0) return ok(undefined);
    const liveBytes = this.bufferPool.view(slotId);
    const last = count - 1;
    const moved =
      slot === last
        ? undefined
        : (readArrayElementAt(liveBytes, last, arrayMeta.elementType) as EntityHandle);
    if (slot !== last) {
      writeArrayElementAt(liveBytes, slot, arrayMeta.elementType, moved as number);
    }
    countCol.view[row] = last;
    this.markComponentChanged(entity, component);
    return ok(moved);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // addComponent / removeComponent (archetype migration via edges, AC-07)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Add a component to an existing entity, triggering archetype migration.
   *
   * @returns `Result<void, EcsError>` —
   *   `ok(void)` on success;
   *   `err(StaleEntityError)` (`.code = 'stale-entity'`) if entity is dead;
   *   `err(ComponentAlreadyPresentError)` (`.code = 'component-already-present'`)
   *   if entity already has the component (E-03).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const Velocity = defineComponent('Velocity', { dx: 'f32', dy: 'f32' });
   * const world = new World();
   * const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * const r = world.addComponent(e, { component: Velocity, data: { dx: 1, dy: 0 } });
   * if (!r.ok) { return; } // r.error.code === 'stale-entity' on dead handle
   * r.unwrap();
   * ```
   */
  addComponent<S extends ComponentSchema, C extends Component<string, S>>(
    entity: EntityHandle,
    componentData: ComponentData<S> & { component: C & WritableComponent<C> },
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    if (
      isRelationshipTarget(componentData.component) &&
      this.relationshipTargetPayloadWrites(componentData.data as Record<string, unknown>)
    )
      return this.relationshipTargetWriteError(componentData.component, 'addComponent');
    return this.addComponentCore(entity, componentData, false);
  }

  /**
   * Core implementation of `addComponent` with reentry guard.
   *
   * @param internal — `true` when called from relationship maintenance
   *   (lazy mirror create or exclusive reparent).
   */
  private addComponentCore<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
    internal: boolean,
    resolveRequirements = true,
    // A relationship preflight can create a target mirror before the source
    // migration. Preserve whether that preflight created it through the
    // exclusive-reparent recursion.
    preparedMirrorAdded?: boolean,
  ): Result<void, EcsError> {
    const record = this.lookupAlive(entity, 'addComponent', componentData.component.name);
    if (!record.ok) return record;

    const rec = record.value;
    let srcArch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!srcArch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'addComponent',
          component: componentData.component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }

    const preflight = this.preflightComponentData(entity, componentData);
    if (!preflight.ok) return preflight;

    const filled = fillComponentDefaults(
      componentData.component,
      componentData.data as Record<string, unknown>,
    );

    // Reserve a source relationship's target before adding any required
    // components. A capacity failure must not leave a required component on
    // the holder, nor a lazily-created mirror on the target. Existing
    // exclusive sources keep their dedicated reparent path below.
    let relationshipMirrorAdded = preparedMirrorAdded;
    const componentAlreadyPresent = archetypeHasComponent(
      srcArch,
      componentId(componentData.component),
    );
    if (
      !componentAlreadyPresent &&
      !internal &&
      relationshipRole(componentData.component as Component)?.kind === 'source' &&
      relationshipMirrorAdded === undefined
    ) {
      const prepared = this.prepareRelationshipInsert(
        componentData.component as Component,
        filled as Record<string, unknown>,
      );
      if (!prepared.ok) return prepared;
      relationshipMirrorAdded = prepared.value;
      // Preparing a relationship may materialize the mirror on the same
      // entity (self-targeting relationships are valid when `allowSelf` is
      // enabled). That nested add migrates `rec`, so the source archetype
      // captured above is no longer authoritative. Refresh it before the
      // requested component migration instead of removing a row from the
      // stale, already-empty table.
      srcArch = this.graph.archetypes[rec.archetypeId];
      if (srcArch === undefined) {
        return err(
          new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
            operation: 'addComponent',
            component: componentData.component.name,
            expectedGeneration: rec.generation,
            actualGeneration: rec.generation,
          }),
        );
      }
    }

    // Generic component requirements are resolved once at the structural
    // boundary. Explicit data remains authoritative; only missing required
    // identities are added before the requested component is migrated.
    if (resolveRequirements) {
      const required = expandComponentRequirements([componentData]).slice(1);
      for (const requirement of required) {
        if (archetypeHasComponent(srcArch, componentId(requirement.component))) {
          continue;
        }
        // The closure is expanded once above. Bypass requirement expansion for
        // each member so malformed dependency cycles remain finite and the
        // structural work still happens in one deterministic sequence.
        const added = this.addComponentCore(entity, requirement as ComponentData, internal, false);
        if (!added.ok) return added;
        srcArch = this.graph.archetypes[rec.archetypeId];
        if (!srcArch) {
          return err(
            new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
              operation: 'addComponent',
              component: componentData.component.name,
              expectedGeneration: rec.generation,
              actualGeneration: rec.generation,
            }),
          );
        }
      }
    }

    // Check if entity already has this component (using World-local ID).
    const localId = componentId(componentData.component);
    if (archetypeHasComponent(srcArch, localId)) {
      // M2 exclusive relationship: re-adding the holder with a (possibly new)
      // target auto-reparents instead of failing (AC-12). Prune the old side
      // first (removeComponent prunes the old target), then fall through to
      // the normal add (which appends the new target). The two steps keep the
      // materialized target list consistent (AC-13);
      // removeComponent + addComponent each touch the mirror exactly once and
      // the mirror component carries no relationship of its own, so there is
      // no recursion. Reparent only fires for top-level user calls
      // (!internal); engine-internal lazy create / append
      // never re-add an existing relationship component.
      const role = relationshipRole(componentData.component as Component);
      if (role?.kind === 'source' && role.exclusive && !internal) {
        const prepared = this.prepareRelationshipInsert(
          componentData.component as Component,
          filled as Record<string, unknown>,
        );
        if (!prepared.ok) return prepared;
        const removeR = this.removeComponentCore(
          entity,
          componentData.component as Component,
          false,
        );
        if (!removeR.ok) return removeR;
        return this.addComponentCore(entity, componentData, false, true, prepared.value);
      }
      return err(new ComponentAlreadyPresentError(entity as number, componentData.component.name));
    }

    // Get target archetype via edge cache.
    const targetArch = getAddEdge(
      this.graph,
      srcArch,
      localId,
      componentData.component as Component,
    );

    if (componentData.component.storage === 'sparse') {
      this.moveEntityArchetype(rec, srcArch, targetArch);
    } else {
      this.migrateEntity(rec, srcArch, targetArch);
    }

    // Write the new component's data. Apply layer-2 + layer-3 silent
    // fallback so addComponent shares the SAME default-resolution path
    // as spawn / SceneAsset.instantiate (feat-20260517 / M2 / AC-04
    // research §F4 auto-symmetry; ComponentData<S>['data'] is the
    // physical bridge).
    if (componentData.component.storage === 'table') {
      this.writeRow(targetArch, componentData.component, this.tableRow(rec), filled as ShapeOf<S>);
    }
    // Relationship sync: append to the materialized target list.
    if (!internal && relationshipRole(componentData.component as Component)?.kind === 'source') {
      const relationshipResult = this.relationshipOnInsert(
        entity,
        componentData.component as Component,
        filled as Record<string, unknown>,
        relationshipMirrorAdded,
      );
      if (!relationshipResult.ok) {
        this.poisonAfterEntityMutation('World.addComponent', relationshipResult.error);
        return relationshipResult;
      }
    }

    if (!internal) {
      // Relationship insertion is part of the same publication boundary. A
      // target-side storage failure poisons the World; it must not leave a
      // components-added epoch/evidence record that claims the edge exists.
      this.internalmarkComponentsAdded(entity, [componentId(componentData.component)]);
      this.advanceStructureEpoch();
    }
    return ok(undefined);
  }

  /**
   * Remove a component from an existing entity, triggering archetype migration.
   *
   * @returns `Result<void, EcsError>` —
   *   `ok(void)` on success;
   *   `err(StaleEntityError)` (`.code = 'stale-entity'`) if entity is dead;
   *   `err(ComponentNotPresentError)` (`.code = 'component-not-present'`)
   *   if entity doesn't have the component (E-04).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * const r = world.removeComponent(e, Position);
   * if (!r.ok) { return; } // r.error.code === 'stale-entity' on dead handle
   * r.unwrap();
   * ```
   */
  removeComponent<S extends ComponentSchema, C extends Component<string, S>>(
    entity: EntityHandle,
    component: C & WritableComponent<C>,
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    if (isRelationshipTarget(component))
      return this.relationshipTargetWriteError(component, 'removeComponent');
    return this.removeComponentCore(entity, component, false);
  }

  /**
   * Core implementation of `removeComponent` with reentry guard.
   *
   * @param internal — `true` when called from relationship maintenance
   *   (exclusive reparent).
   */
  private removeComponentCore<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
    internal: boolean,
  ): Result<void, EcsError> {
    // Essential-component hard reject (feat-20260602 / plan-strategy D-3): the
    // id=0 `Entity` component is carried by every archetype unconditionally (it
    // is the row's own packed handle) and cannot be removed. Reject before any
    // liveness lookup so the rejection is structural, not entity-state-dependent.
    if (componentId(component) === componentId(EntityComponent)) {
      return err(new RemoveEssentialComponentError(component.name));
    }

    const record = this.lookupAlive(entity, 'removeComponent', component.name);
    if (!record.ok) return record;

    const rec = record.value;
    const srcArch = this.graph.archetypes[rec.archetypeId];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!srcArch) {
      return err(
        new StaleEntityError(entity as number, entityIndex(entity), entityGeneration(entity), {
          operation: 'removeComponent',
          component: component.name,
          expectedGeneration: entityGeneration(entity),
          actualGeneration: rec.generation,
        }),
      );
    }

    // Check if entity has this component (using World-local ID).
    const localId = componentId(component);
    if (!archetypeHasComponent(srcArch, localId)) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }

    // Capture the old relationship value before column removal so the
    // materialized target list can be pruned.
    const role = relationshipRole(component as Component);
    const needsOldValue = role?.kind === 'source' && !internal;
    if (needsOldValue) {
      const oldValue = this.readRow(srcArch, component as Component, this.tableRow(rec)) as Record<
        string,
        unknown
      >;
      // Relationship sync: prune the holder from the target's materialized list.
      if (role?.kind === 'source' && !internal) {
        const relation = this.relationshipOnRemove(entity, component as Component, oldValue);
        if (!relation.ok) {
          this.poisonAfterEntityMutation('World.removeComponent', relation.error);
          return relation;
        }
      }
    }

    // M1 release loop (removeComponent path): release every `ref<T>` field
    // on the component being removed before migration drops the row.
    if (component.storage === 'table') {
      this.releaseManagedRefsOnRow(srcArch, component as Component, this.tableRow(rec));
    }

    // Get target archetype via edge cache.
    const targetArch = getRemoveEdge(this.graph, srcArch, localId);

    if (component.storage === 'sparse') {
      this.moveEntityArchetype(rec, srcArch, targetArch);
      const set = this.graph.sparseTags.get(componentId(component));
      if (set !== undefined) removeSparseTag(set, entity);
    } else {
      this.migrateEntity(rec, srcArch, targetArch);
    }
    if (!internal) {
      this.internalnextMutationEpoch();
      this.advanceStructureEpoch();
    }
    return ok(undefined);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — deferred command support (CommandBuffer interface)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Allocate a pending entity for deferred spawn.
   * Returns an Entity handle. The entity is "pending" because
   * archetypeId === -1 (set by allocateIndex); no separate flag needed.
   */
  private allocatePendingEntity(): EntityHandle {
    const indexSlot = this.allocateIndex();
    // biome-ignore lint/style/noNonNullAssertion: allocateIndex guarantees a valid slot with an initialized record
    return encodeEntity(indexSlot, this.records[indexSlot]!.generation);
  }

  /**
   * Return a deferred-spawn reservation to the free-list without publishing a
   * row or advancing an epoch.  CommandBuffer.abort is the sole caller; a
   * materialized entity is intentionally left untouched so an unexpected
   * post-write failure poisons the World instead of attempting an unsafe undo.
   */
  private cancelPendingEntity(entity: EntityHandle): void {
    const slot = entityIndex(entity);
    const record = this.records[slot];
    if (record === undefined || record.generation !== entityGeneration(entity)) return;
    if (record.archetypeId !== -1 || record.archetypeRow !== -1) return;
    record.generation += 1;
    if (!isRetiredSlot(record.generation)) this.freeIndices.push(slot);
  }

  /**
   * Materialize one already-reserved entity. Synchronous spawn and deferred
   * command flush share this exact insertion/publication path; only the
   * caller's validation and reservation boundary differs.
   *
   */
  private materializeEntity(
    entity: EntityHandle,
    componentDatas: ComponentData[],
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    const slot = entityIndex(entity);
    const record = this.records[slot];
    if (!record || record.archetypeId !== -1) return ok(undefined);

    let storageTouched = false;
    try {
      // Find or create target archetype (using World-local IDs).
      const componentIds = componentDatas.map((cd) => componentId(cd.component));
      const components = componentDatas.map((cd) => cd.component);
      const arch = getOrCreateArchetype(this.graph, componentIds, components);

      // Mark the reservation as mutation-owned before either append can write.
      // If appendTableRow succeeds and appendArchetypeRow fails, command abort
      // must not reclaim an entity whose table storage may already be touched.
      // A poisoned World is the recovery boundary for that partial state.
      record.archetypeId = arch.id;
      storageTouched = true;
      const table = this.table(arch);
      const tableRow = appendTableRow(table, entity, this.mutationEpoch + 1);
      const archetypeRow = appendArchetypeRow(arch, tableRow);
      record.archetypeRow = archetypeRow;

      // Write initial data. Apply the same default-resolution path as the
      // synchronous World.spawn / addComponent operations.
      for (const cd of componentDatas) {
        const filled = fillComponentDefaults(cd.component, cd.data as Record<string, unknown>);
        this.writeRow(arch, cd.component, tableRow, filled as ShapeOf<ComponentSchema>);
      }

      // The reserved handle is the source of truth for the essential Entity
      // self column. Relationship maintenance is part of the write boundary;
      // component/epoch publication waits until it has completed.
      this.writeEntitySelf(arch, tableRow, entity);

      // Publish relationship targets after all rows and managed writes are
      // ready. A non-stale error here is a possible partial write. No
      // components-added epoch or structural evidence has been published yet.
      for (const cd of componentDatas) {
        if (relationshipRole(cd.component as Component)?.kind !== 'source') continue;
        const filled = fillComponentDefaults(cd.component, cd.data as Record<string, unknown>);
        const relationshipResult = this.relationshipOnInsert(
          entity,
          cd.component as Component,
          filled as Record<string, unknown>,
        );
        if (!relationshipResult.ok) {
          this.poisonAfterEntityMutation('World.materializeEntity', relationshipResult.error);
          return relationshipResult;
        }
      }
      this.internalmarkComponentsAdded(entity, [
        componentId(EntityComponent),
        ...componentDatas.map((cd) => componentId(cd.component)),
      ]);
      this.advanceStructureEpoch();
      return ok(undefined);
    } catch (error) {
      if (storageTouched) this.poisonAfterEntityMutation('World.materializeEntity', error);
      throw error;
    }
  }

  private poisonAfterEntityMutation(kernelName: string, cause: unknown): void {
    this.internalpoisonExecution({
      code: 'shared-kernel-failed',
      kernelName,
      cause,
      partialWrite: true,
      retryable: false,
    });
  }

  /** Deferred commands use the common materialization owner. */
  private materializePendingEntity(
    entity: EntityHandle,
    componentDatas: ComponentData[],
  ): Result<void, EcsError> {
    return this.materializeEntity(entity, expandComponentRequirements(componentDatas));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — entity index allocation
  // ──────────────────────────────────────────────────────────────────────────

  private allocateIndex(): number {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) throw poisoned;
    const recycled = this.freeIndices.pop();
    if (recycled !== undefined) {
      return recycled;
    }
    const slot = this.records.length;
    if (slot > ENTITY_MAX_INDEX) {
      throw new EntityIndexOverflowError(slot);
    }
    this.records.push({ generation: 0, archetypeId: -1, archetypeRow: -1 });
    return slot;
  }

  /**
   * Single liveness predicate (feat-20260602 / plan-strategy D-4): a slot is
   * live for a given handle generation iff the record exists, its generation
   * still matches the handle (despawn bumps generation, so a stale or recycled
   * handle fails here), and the slot is materialized into an archetype
   * (archetypeId !== -1). Replaces the former `record.alive && record.generation
   * === gen` conjunction and the intermediate `!record.pending` clause. An
   * append in progress keeps `archetypeRow === -1` until both storage indexes
   * exist.
   */
  private recordIsLive(record: EntityRecord | undefined, gen: number): record is EntityRecord {
    return (
      record !== undefined &&
      record.generation === gen &&
      record.archetypeId !== -1 &&
      record.archetypeRow !== -1
    );
  }

  private staleEntityFailure(
    entity: EntityHandle,
    operation: string,
    component?: string,
  ): Result<never, EcsError> {
    const slot = entityIndex(entity),
      gen = entityGeneration(entity);
    return err(
      new StaleEntityError(entity as number, slot, gen, {
        operation,
        ...(component !== undefined ? { component } : {}),
        expectedGeneration: gen,
        actualGeneration: this.records[slot]?.generation ?? -1,
      }),
    );
  }

  private lookupAlive(
    entity: EntityHandle,
    operation: string,
    component?: string,
  ): Result<EntityRecord, EcsError> {
    const record = this.liveEntityRecord(entity);
    return record === undefined
      ? this.staleEntityFailure(entity, operation, component)
      : ok(record);
  }

  private readArrayView(
    arch: Archetype,
    component: Component,
    row: number,
    fieldName: string,
  ): FieldView | undefined {
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    if (!fieldCols) return undefined;

    const fieldType = componentSchema(component)[fieldName];
    if (fieldType === undefined) return undefined;
    // Component reflection already parses and freezes array metadata at
    // registration time. Reusing it here keeps the per-entity zero-copy path
    // parse-free; this accessor is called once for every renderable every
    // frame. The field lookup also preserves the existing undefined result
    // for non-array fields without reparsing arbitrary schema strings.
    const arrayMeta = componentDefinition(component).fields[fieldName]?.arrayMeta;
    if (arrayMeta === undefined) return undefined;

    const col = fieldCols.get(fieldName);
    if (!col) return undefined;

    const elementCount =
      arrayMeta.length ??
      (fieldCols.get(arrayCountColumnName(fieldName))?.view[row] as number | undefined) ??
      0;
    return this.materializeArrayView(col, row, arrayMeta, elementCount);
  }

  /** Read one scalar column without constructing a component snapshot. */
  private internalgetFieldValue(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): number | undefined {
    const record = this.records[entityIndex(entity)];
    if (!this.recordIsLive(record, entityGeneration(entity))) return undefined;
    const arch = this.graph.archetypes[record.archetypeId];
    if (arch === undefined) return undefined;
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    return fieldCols?.get(fieldName)?.view[this.tableRow(record)] as number | undefined;
  }

  /** Read an array's live logical length without allocating a TypedArray. */
  private internalgetArrayLength(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): number | undefined {
    const record = this.records[entityIndex(entity)];
    if (!this.recordIsLive(record, entityGeneration(entity))) return undefined;
    const arch = this.graph.archetypes[record.archetypeId];
    if (arch === undefined) return undefined;
    const row = this.tableRow(record);
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    if (fieldCols === undefined) return undefined;
    const arrayMeta = componentDefinition(component).fields[fieldName]?.arrayMeta;
    if (arrayMeta === undefined) return undefined;
    if (arrayMeta.length !== undefined) return arrayMeta.length;
    const count = fieldCols.get(arrayCountColumnName(fieldName))?.view[row];
    return typeof count === 'number' ? count : 0;
  }

  /** Read one array element directly from its column or BufferPool slot. */
  private internalgetArrayElement(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
    index: number,
  ): number | undefined {
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    const record = this.records[entityIndex(entity)];
    if (!this.recordIsLive(record, entityGeneration(entity))) return undefined;
    const arch = this.graph.archetypes[record.archetypeId];
    if (arch === undefined) return undefined;
    const row = this.tableRow(record);
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    if (fieldCols === undefined) return undefined;
    const arrayMeta = componentDefinition(component).fields[fieldName]?.arrayMeta;
    if (arrayMeta === undefined) return undefined;
    const length =
      arrayMeta.length ??
      (fieldCols.get(arrayCountColumnName(fieldName))?.view[row] as number | undefined);
    if (length === undefined || index >= length) return undefined;
    const col = fieldCols.get(fieldName);
    if (col === undefined) return undefined;
    if (arrayMeta.length !== undefined) return col.view[row * col.arity + index] as number;

    const slotId = col.view[row] as number;
    const bytes = this.bufferPool.view(slotId);
    if (arrayMeta.elementType === 'entity') {
      const byteOffset = index * 4;
      if (byteOffset + 4 > bytes.byteLength) return undefined;
      return (
        ((bytes[byteOffset] ?? 0) |
          ((bytes[byteOffset + 1] ?? 0) << 8) |
          ((bytes[byteOffset + 2] ?? 0) << 16) |
          ((bytes[byteOffset + 3] ?? 0) << 24)) >>>
        0
      );
    }
    return readArrayElementAt(bytes, index, arrayMeta.elementType);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — archetype data read/write
  // ──────────────────────────────────────────────────────────────────────────

  private readRow<S extends ComponentSchema>(
    arch: Archetype,
    component: Component<string, S>,
    row: number,
  ): ShapeOf<S> {
    const localId = componentId(component);
    const fieldCols = this.table(arch).storage.get(localId)?.fields;
    const out = {} as ShapeOf<S>;
    /* istanbul ignore next -- defensive: component is registered and arch has it */
    if (!fieldCols) {
      return out;
    }
    const definition = componentDefinition(component);
    const fields = definition.fields;
    for (const fieldName of definition.fieldNames) {
      const field = fields[fieldName];
      if (field === undefined) continue;
      const fieldType = field.type;
      const col = fieldCols.get(fieldName);
      if (!col) {
        continue;
      }
      const raw = col.view[row];
      if (fieldType === 'bool') {
        (out as Record<string, unknown>)[fieldName] = raw === 1;
      } else if (isEntityField(fieldType)) {
        // Entity field: decode the stored raw u32 verbatim back to Entity
        // (or null when the slot carries the ENTITY_NULL_RAW sentinel). No
        // liveness validation happens here -- a slot referencing a despawned
        // target returns its original raw encoding unchanged; the consumer is
        // responsible for checking liveness (e.g. `world.get(ref, Entity)`).
        (out as Record<string, unknown>)[fieldName] = raw === ENTITY_NULL_RAW ? null : raw;
      } else if (isManagedBufferField(fieldType)) {
        if (fieldType !== 'buffer') {
          // feat-20260602: fixed `buffer<N>` lives inline (stride-N u8 column,
          // arity = N). Return the row's byte window directly -- no pool slot.
          const arity = col.arity;
          (out as Record<string, unknown>)[fieldName] = (col.view as Uint8Array).subarray(
            row * arity,
            row * arity + arity,
          );
        } else {
          // Variable `'buffer'`: column stores slot id; the live view is
          // resolved on demand so post-grow callers always see the refreshed
          // Uint8Array.
          (out as Record<string, unknown>)[fieldName] = this.bufferPool.view(raw as number);
        }
      } else if (fieldType === 'string') {
        // M1 string-field read path (AC-03 / AC-09): resolve the column
        // u32 handle through UniqueRefStore -- same dispatch arm as the
        // 'unique<T>' read (D-R3). Returns the native JS string payload by
        // strong reference; identity is stable across reads until the
        // next set or release (AC-03 read-side identity contract).
        // Released / sentinel handles surface as unique-ref-released via
        // resolve; we fall back to '' rather than propagate the error so
        // the read shape (`out.value: string`) stays total -- AI users
        // never see undefined or wrapper objects.
        const resolveR = this.uniqueRefs.resolve<'String'>(toUnique<'String'>(raw as number));
        (out as Record<string, unknown>)[fieldName] = resolveR.ok ? resolveR.value : '';
      } else {
        const arrayMeta = field.arrayMeta;
        if (arrayMeta !== undefined) {
          // M1 read path: materialise a fresh TypedArray snapshot each call
          // (D-4 no cache; plan-strategy §2.2 read-only contract). The
          // snapshot aliases the BufferPool slot bytes; mutations route
          // through the World mutation API.
          const elementCount =
            arrayMeta.length ??
            (fieldCols.get(arrayCountColumnName(fieldName))?.view[row] as number | undefined) ??
            0;
          const materialized = this.materializeArrayView(col, row, arrayMeta, elementCount);
          // Relationship target arrays are a read-only projection. Keep the
          // public component snapshot detached so mutating the returned view
          // cannot bypass the World-owned mirror/index path.
          (out as Record<string, unknown>)[fieldName] = isRelationshipTarget(component)
            ? materialized.slice()
            : materialized;
        } else {
          (out as Record<string, unknown>)[fieldName] = raw;
        }
      }
    }
    return out;
  }

  /**
   * Write the full packed entity handle into the row's essential id=0 `Entity`
   * column (`self` field). Called by `spawn` / `materializePendingEntity`
   * after the row is appended (feat-20260602 / plan-strategy D-3). The column
   * always exists -- `createArchetype` folds the Entity column into every
   * archetype -- so this is a direct u32 store, no readRow/writeRow walk.
   */
  private writeEntitySelf(arch: Archetype, row: number, handle: EntityHandle): void {
    const col = this.table(arch).storage.get(componentId(EntityComponent))?.fields.get('self');
    /* istanbul ignore next -- defensive: Entity column is folded into every archetype */
    if (!col) return;
    col.view[row] = handle as unknown as number;
  }

  private writeRow<S extends ComponentSchema>(
    arch: Archetype,
    component: Component<string, S>,
    row: number,
    value: ShapeOf<S>,
  ): void {
    const localId = componentId(component);
    const fieldCols = this.table(arch).storage.get(localId)?.fields;
    /* istanbul ignore next -- defensive: component is registered and arch has it */
    if (!fieldCols) {
      return;
    }
    for (const [fieldName, fieldType] of Object.entries(componentSchema(component))) {
      const col = fieldCols.get(fieldName);
      /* istanbul ignore next -- defensive: schema fields always have columns */
      if (!col) {
        continue;
      }
      const raw = (value as Record<string, unknown>)[fieldName];
      if (fieldType === 'bool') {
        col.view[row] = raw ? 1 : 0;
      } else if (isEntityField(fieldType)) {
        // M3 entity field: encode (slot, gen) into u32 column. `null`
        // / undefined map to ENTITY_NULL_RAW sentinel.
        col.view[row] = raw === null || raw === undefined ? ENTITY_NULL_RAW : (raw as number);
      } else if (isManagedBufferField(fieldType)) {
        // M2 spawn path: collapsed-vocab keyword family `'buffer'` (variable)
        // + `'buffer<N>'` (fixed):
        //   - `buffer<N>` (feat-20260602) — lives inline as a stride-N u8
        //     column (arity = N). Copy any provided payload straight into the
        //     row window (truncate to N); no BufferPool slot.
        //   - `'buffer'`  — variable capacity; alloc one BufferPool slot sized
        //     to the provided payload's byteLength. Missing / non-buffer raw
        //     -> alloc(0) zero-length live view (verify round 1 B2 fix path;
        //     pre-fix the bare keyword routed `bufferFieldByteLength('buffer')`
        //     -> NaN -> alloc(NaN) -> managed-buffer-out-of-bounds, dropping
        //     the payload bytes silently). Failures route to Layer 3
        //     error channel; column slot stays at 0 (sentinel) so subsequent
        //     release short-circuits.
        //   raw is normalized from any AllowSharedBufferSource view to a
        //   Uint8Array over its bytes (feat-20260621 V2 / AC-A4).
        const bytes = normalizeBufferWrite(raw);
        if (fieldType !== 'buffer') {
          const arity = col.arity;
          if (bytes !== null) {
            const copyLen = Math.min(bytes.byteLength, arity);
            (col.view as Uint8Array).set(bytes.subarray(0, copyLen), row * arity);
          }
        } else {
          const allocBytes = bytes !== null ? bytes.byteLength : 0;
          const allocR = this.bufferPool.alloc(allocBytes);
          if (!allocR.ok) {
            const ctx: ErrorContext = {
              systemName: `World.spawn (${component.name}.${fieldName})`,
            };
            this.routeError(allocR.error, ctx);
            col.view[row] = 0;
            continue;
          }
          const slot = allocR.value;
          if (bytes !== null) {
            // allocBytes is the payload's exact byteLength so no truncation.
            const copyLen = Math.min(bytes.byteLength, slot.view.byteLength);
            slot.view.set(bytes.subarray(0, copyLen));
          }
          col.view[row] = slot.id;
        }
      } else if (fieldType === 'string') {
        // M1 string-field spawn path (AC-04 / AC-06): route the JS string
        // payload through `uniqueRefs.alloc('String', text)` -- the same
        // UniqueRefStore the `ref<T>` arm uses (D-R3 single-arm dispatch).
        // The store holds the immutable string by strong reference so
        // identity is stable across reads (AC-03). Missing / non-string raw
        // falls back to '' so AI users always see a readable string on
        // get (no nullable handling).
        const text = typeof raw === 'string' ? raw : '';
        const handle = this.uniqueRefs.alloc<'String'>('String', text);
        col.view[row] = unwrapHandle(handle);
      } else {
        const arrayMeta = componentDefinition(component).fields[fieldName]?.arrayMeta;
        if (arrayMeta !== undefined) {
          // M1 spawn path for array<T> / array<T,N> fields (D-3 double-
          // column for variable; single column for fixed).
          // Spawn path: no prior-slot release (fresh rows carry stale debris
          // owned by the migrated entity in the new archetype) — feat-20260614
          // D-3 calling convention.
          this.writeArrayField(arch, component, row, fieldName, fieldType, arrayMeta, raw);
        } else {
          col.view[row] = raw as number;
          // feat-20260614 M5 / D-5: scalar 'shared<T>' spawn retain. The
          // alloc-grant rc=1 stays held by the producer (e.g. AssetRegistry);
          // each ECS holder bumps rc via this retain so despawn / overwrite
          // releases bring rc back symmetrically. Sentinel slot 0 is a no-op.
          if (fieldType.startsWith('shared<') && (raw as number) !== 0) {
            this.retainSharedScalarHandle(raw as number, component.name, fieldName);
          }
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — managed-ref + managed-buffer release loop (M1 / M2)
  // ──────────────────────────────────────────────────────────────────────────

  /** Release all ECS-owned field handles before a row is removed or overwritten. */
  private releaseManagedRefsOnRow(arch: Archetype, component: Component, row: number): void {
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    if (!fieldCols) return;
    for (const fieldName of Object.keys(componentSchema(component))) {
      this.releaseManagedFieldOnRow(arch, component, row, fieldName);
    }
  }

  /**
   * Release one ECS-owned field according to its schema. Inline buffers have
   * no pool slot; shared-array elements still release their handles. Store
   * failures use the host error channel so row cleanup remains total.
   */
  private releaseManagedFieldOnRow(
    arch: Archetype,
    component: Component,
    row: number,
    fieldName: string,
  ): void {
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    if (!fieldCols) return;
    const col = fieldCols.get(fieldName);
    if (!col) return;
    const fieldType = (componentSchema(component) as Record<string, string>)[fieldName] ?? '';
    if (isManagedField(fieldType)) {
      // Sub-dispatch by the schema-vocab keyword (feat-20260614 M4 / AC-08):
      //   - 'shared<T>' scalar    -> SharedRefStore.release (rc--; drop on rc=0)
      //   - 'unique<T>' / 'string' -> UniqueRefStore.release (direct slot drop)
      // Both column shapes are u32 handles; the lookup store differs.
      // Keeping both arms inside the unified `isManagedField` block is
      // intentional: meta key (TYPE_METADATA `'shared'` vs `'ref'`) decides
      // the store, not a separate top-level branch (architecture-principles
      // §1 SSOT — meta key = release semantics).
      const handleU32 = col.view[row] as number;
      if (fieldType.startsWith('shared<')) {
        this.releaseSharedRefHandle(handleU32, component.name, fieldName);
        return;
      }
      this.releaseManagedRefHandle(handleU32, component.name, fieldName);
      return;
    }
    if (isManagedBufferField(fieldType)) {
      if (fieldType === 'buffer') {
        const slotId = col.view[row] as number;
        this.releaseManagedBufferSlot(slotId);
        col.view[row] = 0;
      }
      return;
    }
    if (isManagedArrayField(fieldType)) {
      // Use the pre-parsed arrayMeta cached on the component descriptor at
      // registration (AC-03c parse-free hot path); reaching for
      // `parseManagedArraySchema` here would violate the parse-free
      // invariant exercised by hierarchy.unit.test.ts §w5 AC-03(a).
      const arrayMeta = componentDefinition(component).fields[fieldName]?.arrayMeta;
      if (arrayMeta === undefined) return;
      const isSharedElement = arrayMeta.elementType.startsWith('shared<');
      if (arrayMeta.length === undefined) {
        // Variable `array<T>`: BufferPool slot id in primary column + live
        // count in `<fieldName>:count` sidecar. For `array<shared<T>>`,
        // walk live elements and release each shared handle BEFORE
        // releasing the slot bytes (feat-20260614 M4 / D-3 — slot bytes
        // are only valid until the slot is recycled).
        const slotId = col.view[row] as number;
        const countCol = fieldCols.get(arrayCountColumnName(fieldName));
        if (isSharedElement && slotId !== 0) {
          const liveCount = countCol !== undefined ? (countCol.view[row] as number) : 0;
          const slotView = liveCount > 0 ? this.bufferPool.view(slotId) : null;
          if (slotView !== null && slotView.byteLength > 0) {
            this.releaseSharedArrayElements(slotView, liveCount);
          }
        }
        this.releaseManagedBufferSlot(slotId);
        col.view[row] = 0;
        if (countCol !== undefined) countCol.view[row] = 0;
        return;
      }
      // Fixed `array<T,N>` (feat-20260602): inline stride-N column, no
      // BufferPool slot to release. For `array<shared<T>,N>`, walk the N
      // inline elements and release each shared handle. Zero the row
      // window so subsequent writes do not double-release.
      if (isSharedElement) {
        const arity = col.arity;
        const elementBytes = (TYPE_METADATA.shared?.byteSize ?? 4) as number;
        const rowByteOffset = col.view.byteOffset + row * arity * elementBytes;
        const rowBytes = new Uint8Array(col.view.buffer, rowByteOffset, arity * elementBytes);
        this.releaseSharedArrayElements(rowBytes, arity);
        rowBytes.fill(0);
      }
    }
  }

  /** Release one unique-ref handle; sentinel 0 is ignored. */
  private releaseManagedRefHandle(
    handleU32: number,
    componentName: string,
    fieldName: string,
  ): void {
    if (handleU32 === 0) return; // sentinel: skip silently.
    const r = this.uniqueRefs.release(handleU32 as Handle<string, 'unique'>);
    if (r.ok) return;
    // Layer 3 routing: surface double-release as a structured error so AI
    // users see {code, hint, expected, detail} on their handler. Severity
    // defaults to Error so the chain continues; matchSeverity prints to
    // console.error rather than throw.
    const ctx: ErrorContext = {
      systemName: `World.release (${componentName}.${fieldName})`,
    };
    this.routeError(r.error, ctx);
  }

  /** Release one shared-ref handle, preserving builtin slots and refcounts. */
  private releaseSharedRefHandle(
    handleU32: number,
    componentName: string,
    fieldName: string,
  ): void {
    // feat-20260614 M6 D-15 / R-14: builtin slots (< BUILTIN_BASE, including the
    // sentinel 0) are process-static and never reference-counted -> short-circuit
    // before touching SharedRefStore. This single guard is the SSOT for both the
    // scalar arm (here) and the array-element arm (releaseSharedArrayElements).
    if (handleU32 < BUILTIN_BASE) return;
    const r = this.sharedRefs.release(toShared<string>(handleU32));
    if (r.ok) return;
    const ctx: ErrorContext = {
      systemName: `World.release (${componentName}.${fieldName})`,
    };
    this.routeError(r.error, ctx);
  }

  /** Retain one shared-ref scalar handle for a World-owned field. */
  private retainSharedScalarHandle(
    handleU32: number,
    componentName: string,
    fieldName: string,
  ): void {
    // feat-20260614 M6 D-15 / R-14: builtin slots (< BUILTIN_BASE, including the
    // sentinel 0) short-circuit — process-static, never reference-counted. SSOT
    // guard shared with the array-element arm (retainSharedArrayElements).
    if (handleU32 < BUILTIN_BASE) return;
    const r = this.sharedRefs.retain(toShared<string>(handleU32));
    if (r.ok) return;
    const ctx: ErrorContext = {
      systemName: `World.write (${componentName}.${fieldName} shared scalar retain)`,
    };
    this.routeError(r.error, ctx);
  }

  /** Release one variable-buffer slot; id 0 is the unallocated sentinel. */
  private releaseManagedBufferSlot(slotId: number): void {
    if (slotId === 0) return; // sentinel: skip silently.
    this.bufferPool.release(slotId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — array<T> / array<T,N> spawn / set helpers (M1 / w7)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Attach field context to a `ManagedArrayErrorEnvelope`.
   * The envelope shape (`code / hint / expected / detail`) already mirrors
   * the EcsError contract; this helper only attaches the systemName context
   * so AI users can correlate the error with the holder component / field.
   */
  private routeArrayError(
    err: ManagedArrayErrorEnvelope,
    componentName: string,
    fieldName: string,
  ): void {
    const ctx: ErrorContext = {
      systemName: `World.write (${componentName}.${fieldName})`,
    };
    this.routeError(err, ctx);
  }

  /**
   * Write an array field for spawn or set. Fixed arrays stay inline; variable
   * arrays use one BufferPool slot plus a live-count sidecar.
   */
  private writeArrayField(
    arch: Archetype,
    component: Component,
    row: number,
    fieldName: string,
    _fieldType: string,
    arrayMeta: ArrayMeta,
    raw: unknown,
  ): void {
    const fieldCols = this.table(arch).storage.get(componentId(component))?.fields;
    /* istanbul ignore next -- writeArrayField caller validated the column map */
    if (!fieldCols) return;
    const col = fieldCols.get(fieldName);
    /* istanbul ignore next -- writeArrayField caller validated the column */
    if (!col) return;

    const elementType = arrayMeta.elementType;
    // Normalize parametrised element-type template literals to the family
    // key for TYPE_METADATA lookup; the column stores plain u32 handles
    // either way:
    //   - `shared<X>` -> 'shared' (feat-20260614 M4 / D-3 -- element-level
    //     retain/release semantics route via the dedicated `'shared'` arm
    //     below)
    const metaKey = elementType.startsWith('shared<') ? 'shared' : (elementType as string);
    const meta = TYPE_METADATA[metaKey];
    /* istanbul ignore next -- arrayMeta.elementType is guaranteed in TYPE_METADATA */
    if (!meta) return;
    // biome-ignore lint/style/noNonNullAssertion: every array element type has a byte size
    const elementBytes = meta.byteSize!;

    const isVariable = arrayMeta.length === undefined;
    const fixedLength = arrayMeta.length ?? 0;

    // Same-typed inline storage can copy elements without packing temporary bytes.
    // TypedArray.set preserves overlapping source views; different element types
    // retain the byte-copy contract below.
    if (
      !isVariable &&
      metaKey !== 'shared' &&
      meta.viewCtor !== undefined &&
      col.view instanceof meta.viewCtor &&
      (raw == null || Array.isArray(raw) || raw instanceof meta.viewCtor)
    ) {
      const start = row * col.arity;
      const count = raw == null ? 0 : Math.min(raw.length, col.arity);
      if (Array.isArray(raw)) {
        for (let i = 0; i < count; i++)
          col.view[start + i] = typeof raw[i] === 'number' ? raw[i] : 0;
      } else if (raw != null) {
        col.view.set(raw.length <= col.arity ? raw : raw.subarray(0, count), start);
      }
      col.view.fill(0, start + count, start + col.arity);
      return;
    }

    // Determine the payload's logical element count. Accept any TypedArray
    // (Float32Array / Uint32Array / etc.) plus plain numeric arrays; an
    // undefined / missing payload is treated as a length-0 init. Bytes are
    // copied from the source's underlying ArrayBuffer when present.
    let payloadCount = 0;
    let payloadBytes: Uint8Array | null = null;
    if (raw !== null && raw !== undefined) {
      if (
        raw instanceof Float32Array ||
        raw instanceof Float64Array ||
        raw instanceof Int32Array ||
        raw instanceof Uint32Array ||
        raw instanceof Int16Array ||
        raw instanceof Uint16Array ||
        raw instanceof Int8Array ||
        raw instanceof Uint8Array
      ) {
        payloadCount = raw.length;
        payloadBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      } else if (Array.isArray(raw)) {
        payloadCount = raw.length;
        // Plain JS array: pack each element through the declared element
        // type's TypedArray constructor (`meta.viewCtor`) so the numeric
        // VALUE is encoded, not its integer bit pattern. Dispatching on
        // `viewCtor` (the type SSOT) rather than byte size is what keeps
        // `array<f32,N>` distinct from `array<u32,N>` -- both are 4 bytes,
        // so a size-keyed setter would store an f32 `1.0` as the u32 bits
        // `0x00000001` (reads back ~1.4e-45). The TypedArray then exposes
        // its little-endian bytes for the shared copy path below.
        if (payloadCount > 0 && meta.viewCtor !== undefined) {
          const typed = new meta.viewCtor(payloadCount);
          for (let i = 0; i < payloadCount; i++) {
            const val = raw[i];
            typed[i] = typeof val === 'number' ? val : 0;
          }
          payloadBytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
        }
      }
    }

    // Effective count for variable arrays = payload count; for fixed
    // arrays = schema-declared N (the payload's length is advisory — we
    // copy up to N elements and pad the rest with zero).
    const effectiveCount = isVariable ? payloadCount : fixedLength;

    // Fixed `array<T,N>` (feat-20260602): the column is an inline stride-N
    // view (`col.arity === N`), so write the payload bytes directly into the
    // row's stride window — no BufferPool slot, no slot-id store, no
    // prior-slot release. The byte window starts at `row * arity * elementBytes`
    // and spans N elements; payloads shorter than N copy a prefix and leave
    // the tail at its current value (spawn rows are zero-initialised by the
    // fresh column buffer; the swap-pop migration copies the whole block).
    if (!isVariable) {
      const arity = col.arity;
      const rowByteOffset = col.view.byteOffset + row * arity * elementBytes;
      const rowBytes = new Uint8Array(col.view.buffer, rowByteOffset, arity * elementBytes);
      const copyLen =
        payloadBytes === null ? 0 : Math.min(payloadBytes.byteLength, rowBytes.byteLength);
      if (copyLen > 0 && payloadBytes !== null) {
        rowBytes.set(payloadBytes.subarray(0, copyLen));
      }
      // Zero the tail past the copied prefix so a short / missing payload
      // matches the prior fresh-slot semantics (the old pool path always
      // alloc'd a zeroed slot, so unwritten elements read back as 0).
      if (copyLen < rowBytes.byteLength) {
        rowBytes.fill(0, copyLen);
      }
      // feat-20260614 M4 / D-3: `array<shared<T>,N>` element-level retain.
      // Walk the copied prefix as u32 handles and retain each non-sentinel
      // element. Caller releases priors via `releaseManagedFieldOnRow` on
      // the set path (D-3 calling convention); the spawn path's fresh row
      // is zero-initialised so no priors exist.
      if (metaKey === 'shared' && copyLen > 0) {
        this.retainSharedArrayElements(rowBytes, copyLen >>> 2);
      }
      return;
    }

    // Variable `array<T>`: prior-slot release lives at the caller (set path)
    // — D-3 calling convention. Spawn path's fresh rows carry stale swap-pop
    // debris which MUST NOT be released here.
    const byteLength = effectiveCount * elementBytes;
    const allocR = this.bufferPool.alloc(byteLength);
    if (!allocR.ok) {
      this.routeArrayError(
        {
          code: allocR.error.code,
          hint: allocR.error.hint,
          expected: allocR.error.expected,
          detail: allocR.error.detail,
        } as ManagedArrayErrorEnvelope,
        component.name,
        fieldName,
      );
      col.view[row] = 0;
      if (isVariable) {
        const countCol = fieldCols.get(arrayCountColumnName(fieldName));
        if (countCol !== undefined) countCol.view[row] = 0;
      }
      return;
    }
    const slot = allocR.value;
    if (payloadBytes !== null) {
      const copyLen = Math.min(payloadBytes.byteLength, slot.view.byteLength);
      slot.view.set(payloadBytes.subarray(0, copyLen));
    }
    col.view[row] = slot.id;
    if (isVariable) {
      const countCol = fieldCols.get(arrayCountColumnName(fieldName));
      /* istanbul ignore else -- count column allocated by createArchetype */
      if (countCol !== undefined) countCol.view[row] = effectiveCount;
    }
    // feat-20260614 M4 / D-3: variable `array<shared<T>>` element-level
    // retain. Walk the live element prefix (effectiveCount u32 handles) and
    // retain each non-sentinel handle. Prior elements were released by the
    // caller via `releaseManagedFieldOnRow` on the set path (D-3 calling
    // convention); the spawn path has no priors.
    if (metaKey === 'shared' && effectiveCount > 0) {
      this.retainSharedArrayElements(slot.view, effectiveCount);
    }
  }

  /**
   * Walk the first `count` u32 handles in `bytes` and call
   * `SharedRefStore.retain` on each non-sentinel slot id (feat-20260614 M4 /
   * D-3). Failures route via the error channel so the write chain stays
   * total; charter explicit-failure boundary lets AI users see structured
   * `shared-ref-released` payloads when retaining a stale handle.
   *
   * Helper-internal -- only called from `writeArrayField`'s `'shared'` arm.
   */
  private retainSharedArrayElements(bytes: Uint8Array, count: number): void {
    const view = new Uint32Array(bytes.buffer, bytes.byteOffset, count);
    for (let i = 0; i < count; i++) {
      const raw = view[i];
      if (raw === undefined) continue;
      // R-14: route through the scalar SSOT helper so the `< BUILTIN_BASE`
      // short-circuit (builtin slots + sentinel 0) lives in exactly one place.
      this.retainSharedScalarHandle(raw, 'array<shared<T>>', 'element');
    }
  }

  /**
   * Walk the first `count` u32 handles in `bytes` and call
   * `SharedRefStore.release` on each non-sentinel slot id (feat-20260614 M4 /
   * D-3). Mirrors `retainSharedArrayElements`; called from
   * `releaseManagedFieldOnRow`'s array arm BEFORE the BufferPool slot is
   * released so the underlying bytes are still valid.
   */
  private releaseSharedArrayElements(bytes: Uint8Array, count: number): void {
    const view = new Uint32Array(bytes.buffer, bytes.byteOffset, count);
    for (let i = 0; i < count; i++) {
      const raw = view[i];
      if (raw === undefined) continue;
      // R-14: route through the scalar SSOT helper so the `< BUILTIN_BASE`
      // short-circuit (builtin slots + sentinel 0) lives in exactly one place.
      this.releaseSharedRefHandle(raw, 'array<shared<T>>', 'element');
    }
  }

  /**
   * Materialize an array snapshot. Fixed arrays alias their inline column;
   * variable arrays alias the live BufferPool slot and use the count sidecar.
   * Both views are transient and must not be held across structural changes.
   */
  private materializeArrayView(
    col: Column,
    row: number,
    arrayMeta: ArrayMeta,
    elementCount: number,
  ): FieldView {
    if (arrayMeta.length !== undefined) {
      // Fixed `array<T,N>` (feat-20260602): the elements live INLINE in the
      // stride-N column. Reinterpret the row's byte window directly — no
      // BufferPool indirection.
      const elementBytes = elementByteSize(arrayMeta.elementType);
      const arity = col.arity;
      const rowByteOffset = col.view.byteOffset + row * arity * elementBytes;
      return reinterpretBufferRegion(
        col.view.buffer,
        rowByteOffset,
        arrayMeta.elementType,
        arrayMeta.length,
      );
    }
    return reinterpretSlotBytes(
      this.bufferPool.view(col.view[row] as number),
      arrayMeta.elementType,
      elementCount,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal — archetype migration
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Copy surviving component columns into the target row, then swap-remove
   * the source row. Managed handles and variable-array sidecars are copied
   * verbatim; release remains the responsibility of remove/despawn paths.
   */
  private migrateEntity(record: EntityRecord, srcArch: Archetype, targetArch: Archetype): void {
    const oldArchetypeRow = record.archetypeRow;
    const oldTableRow = srcArch.rows[oldArchetypeRow] ?? 0;
    const srcTable = this.table(srcArch);
    const targetTable = this.table(targetArch);
    const entity = (srcTable.storage.get(componentId(EntityComponent))?.fields.get('self')?.view[
      oldTableRow
    ] ?? 0) as EntityHandle;
    const newTableRow = appendTableRow(targetTable, entity, this.mutationEpoch + 1);
    const newArchetypeRow = appendArchetypeRow(targetArch, newTableRow);

    // Copy shared component data.
    for (const [compId, srcComponentStorage] of srcTable.storage) {
      const srcFieldCols = srcComponentStorage.fields;
      const targetComponentStorage = targetTable.storage.get(compId);
      const targetFieldCols = targetComponentStorage?.fields;
      if (!targetFieldCols) {
        continue; // Component was removed — skip.
      }
      for (const [fieldName, srcCol] of srcFieldCols) {
        const targetCol = targetFieldCols.get(fieldName);
        if (!targetCol) {
          continue;
        }
        // Copy the whole stride-N block per row. Scalar / variable / `:count`
        // columns have arity 1 (single-element copy, byte-identical to the
        // prior `view[newRow] = view[oldRow]` form); fixed inline
        // `array<T,N>` / `buffer<N>` columns carry their N elements inline and
        // must migrate the entire block (feat-20260602).
        const arity = srcCol.arity;
        targetCol.view.set(
          srcCol.view.subarray(oldTableRow * arity, oldTableRow * arity + arity),
          newTableRow * arity,
        );
      }
      if (targetComponentStorage !== undefined) {
        copyComponentEpoch(
          srcComponentStorage.epochs,
          oldTableRow,
          targetComponentStorage.epochs,
          newTableRow,
        );
      }
    }

    const archetypeSwap = removeArchetypeRow(srcArch, oldArchetypeRow);
    if (archetypeSwap !== null) {
      const movedEntity = (srcTable.storage.get(componentId(EntityComponent))?.fields.get('self')
        ?.view[archetypeSwap.movedTableRow] ?? 0) as EntityHandle;
      const movedRecord = this.records[entityIndex(movedEntity)];
      if (movedRecord?.generation === entityGeneration(movedEntity)) {
        movedRecord.archetypeRow = archetypeSwap.newRow;
      }
    }
    const tableSwap = removeTableRow(srcTable, oldTableRow, this.mutationEpoch + 1);
    if (tableSwap !== null) {
      const movedRecord = this.records[entityIndex(tableSwap.movedEntity)];
      if (movedRecord?.generation === entityGeneration(tableSwap.movedEntity)) {
        const movedArchetype = this.graph.archetypes[movedRecord.archetypeId];
        if (movedArchetype !== undefined) {
          movedArchetype.rows[movedRecord.archetypeRow] = tableSwap.newRow;
        }
      }
    }

    record.archetypeId = targetArch.id;
    record.archetypeRow = newArchetypeRow;
  }

  private moveEntityArchetype(
    record: EntityRecord,
    srcArch: Archetype,
    targetArch: Archetype,
  ): void {
    const table = this.table(srcArch);
    if (srcArch.tableId !== targetArch.tableId) {
      throw new Error('Logical archetype move requires a shared Table.');
    }
    const oldArchetypeRow = record.archetypeRow;
    const tableRow = srcArch.rows[oldArchetypeRow] ?? 0;
    const archetypeSwap = removeArchetypeRow(srcArch, oldArchetypeRow);
    if (archetypeSwap !== null) {
      const movedEntity = (table.storage.get(componentId(EntityComponent))?.fields.get('self')
        ?.view[archetypeSwap.movedTableRow] ?? 0) as EntityHandle;
      const movedRecord = this.records[entityIndex(movedEntity)];
      if (movedRecord?.generation === entityGeneration(movedEntity)) {
        movedRecord.archetypeRow = archetypeSwap.newRow;
      }
    }
    record.archetypeId = targetArch.id;
    record.archetypeRow = appendArchetypeRow(targetArch, tableRow);
    markTableMembership(table, tableRow, this.mutationEpoch + 1);
  }

  /**
   * Retire one live entity and any linked-spawn descendants. The complete
   * row/relationship/managed-data mutation stays on World so a failure after
   * the first write can poison this identity instead of crossing an extraction
   * owner boundary.
   */
  private despawnEntity(entity: EntityHandle, internal: boolean): Result<void, EcsError> {
    const slot = entityIndex(entity);
    const generation = entityGeneration(entity);
    const record = this.records[slot];
    if (!this.recordIsLive(record, generation)) return ok(undefined);
    this.arrayRangeLog.forget(entity as number);

    const archetype = this.graph.archetypes[record.archetypeId];
    const linkedChildren =
      archetype === undefined ? [] : this.relationshipLinkedSpawnChildren(entity, archetype);
    let mutationStarted = false;
    try {
      if (archetype !== undefined) {
        const table = this.table(archetype);
        const archetypeRow = record.archetypeRow;
        const tableRow = archetype.rows[archetypeRow] ?? 0;
        mutationStarted = true;
        for (const component of archetype.components) {
          const role = relationshipRole(component);
          if (role?.kind === 'source' && !internal) {
            const oldValue = this.readRow(archetype, component, tableRow) as Record<
              string,
              unknown
            >;
            const relation = this.relationshipOnRemove(entity, component, oldValue);
            if (!relation.ok) {
              this.poisonAfterEntityMutation('World.despawn', relation.error);
              return relation;
            }
          }
          this.releaseManagedRefsOnRow(archetype, component, tableRow);
        }
        for (const component of archetype.components) {
          if (component.storage !== 'sparse') continue;
          const sparse = this.graph.sparseTags.get(componentId(component));
          if (sparse !== undefined) removeSparseTag(sparse, entity);
        }
        const archetypeSwap = removeArchetypeRow(archetype, archetypeRow);
        if (archetypeSwap !== null) {
          const movedEntity = (table.storage.get(componentId(EntityComponent))?.fields.get('self')
            ?.view[archetypeSwap.movedTableRow] ?? 0) as EntityHandle;
          const movedRecord = this.records[entityIndex(movedEntity)];
          if (movedRecord?.generation === entityGeneration(movedEntity)) {
            movedRecord.archetypeRow = archetypeSwap.newRow;
          }
        }
        const tableSwap = removeTableRow(table, tableRow, this.mutationEpoch + 1);
        if (tableSwap !== null) {
          const movedRecord = this.records[entityIndex(tableSwap.movedEntity)];
          if (movedRecord?.generation === entityGeneration(tableSwap.movedEntity)) {
            const movedArchetype = this.graph.archetypes[movedRecord.archetypeId];
            if (movedArchetype !== undefined) {
              movedArchetype.rows[movedRecord.archetypeRow] = tableSwap.newRow;
            }
          }
        }
      }
      record.archetypeId = -1;
      record.archetypeRow = -1;
      record.generation += 1;
      if (!isRetiredSlot(record.generation)) this.freeIndices.push(slot);
      for (const child of linkedChildren) {
        const childResult = this.despawnEntity(child, true);
        if (!childResult.ok) return childResult;
      }
      this.internalnextMutationEpoch();
      this.advanceStructureEpoch();
      return ok(undefined);
    } catch (error) {
      if (mutationStarted) this.poisonAfterEntityMutation('World.despawn', error);
      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Spawn
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Spawn an entity with one or more components.
   * Multi-component spawn directly targets the correct archetype (AC-06).
   *
   * @returns `Result<Entity, EcsError>` — `ok(Entity)` on success.
   *   EntityIndexOverflowError still throws (build-time / infrastructure failure).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * const r = world.spawn({ component: Position, data: { x: 0, y: 0 } });
   * if (!r.ok) { console.error(r.error.code); return; }
   * const entity = r.value;
   * ```
   */
  spawn<const SArr extends readonly ComponentSchema[]>(
    ...componentDatas: {
      [K in keyof SArr]: {
        component: Component<string, SArr[K]>;
        data: Partial<InputShapeOf<SArr[K]>>;
      };
    }
  ): Result<EntityHandle, EcsError>;
  spawn(...componentDatas: ComponentData[]): Result<EntityHandle, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    const target = componentDatas.find(
      (data) =>
        isRelationshipTarget(data.component) &&
        this.relationshipTargetPayloadWrites(data.data as Record<string, unknown>),
    );
    if (target !== undefined) return this.relationshipTargetWriteError(target.component, 'spawn');
    return spawnCore(this, componentDatas);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Despawn (D-08: generation retirement)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Despawn an entity. Stale handles are silently ignored (E-01, AC-17).
   * Generation retirement: gen=255 → index permanently retired (D-08/E-08).
   *
   * @returns `Result<void, EcsError>` — `ok(void)` always (idempotent on stale handles).
   *
   * @example
   * ```ts
   * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
   * const world = new World();
   * const e = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
   * const r = world.despawn(e);
   * r.unwrap(); // idempotent: ok(void) even on stale handle
   * ```
   */
  despawn(entity: EntityHandle): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    return this.despawnEntity(entity, false);
  }

  /** Despawn every live entity through the normal lifecycle and ref cleanup path. */
  despawnAll(): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    const entities: EntityHandle[] = [];
    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index];
      if (record !== undefined && record.archetypeId >= 0) {
        entities.push(encodeEntity(index, record.generation));
      }
    }
    for (const entity of entities) {
      const result = this.despawn(entity);
      if (!result.ok) return result;
    }
    return ok(undefined);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hierarchy facade — lifecycle orchestration lives in world-entity-lifecycle.
  // World owns the component storage and relationship mutation primitives.
  // ──────────────────────────────────────────────────────────────────────────

  addChild<S extends ComponentSchema>(
    parent: EntityHandle,
    child: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    return worldAddChild(this, parent, child, component, data);
  }

  removeChild<S extends ComponentSchema>(
    parent: EntityHandle,
    child: EntityHandle,
    component: Component<string, S>,
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    return worldRemoveChild(this, parent, child, component);
  }

  reparent<S extends ComponentSchema>(
    child: EntityHandle,
    newParent: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    return worldReparent(this, child, newParent, component, data);
  }

  iterAncestors(entity: EntityHandle): Iterable<EntityHandle> {
    return worldIterAncestors(this, entity);
  }

  iterDescendants(entity: EntityHandle): Iterable<EntityHandle> {
    return worldIterDescendants(this, entity);
  }
}
