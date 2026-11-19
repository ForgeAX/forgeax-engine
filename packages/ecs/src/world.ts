import {
  type AssetError,
  type AssetReferenceOwner,
  err,
  type Handle,
  isRetiredSlot,
  ok,
  pack,
  type Result,
  toShared,
  toUnique,
  unwrapHandle,
} from '@forgeax/engine-types';
import {
  type ArrayFieldPlan,
  type Component,
  ComponentCatalog,
  type ComponentData,
  type ComponentDefinition,
  type ComponentId,
  type ComponentSchema,
  componentDefinition,
  componentEmptyInput,
  componentId,
  expandComponentRequirements,
  type FieldPlan,
  type InputShapeOf,
  implicitComponentInputs,
  type SchemaOf,
  type ShapeOf,
} from './component';
import {
  componentRemovalError,
  holdAssetFields,
  InitializedComponentData,
  invalidAssetBinding,
  releaseAssetReference,
  validateComponentDataKeys,
  validateComponentFieldValues,
  validateEnumFieldValues,
} from './component-input';
import {
  ENTITY_MAX_INDEX,
  ENTITY_NULL_RAW,
  type EntityHandle,
  encodeEntity,
  entityGeneration,
  entityIndex,
} from './entity-handle';
import {
  ArrayRangeOutOfBoundsError,
  ChangeEpochExhaustedError,
  ComponentAlreadyPresentError,
  ComponentNotPresentError,
  createRelationshipDetachMismatchError,
  createRelationshipSelfCycleError,
  createRelationshipTargetReadonlyError,
  type EcsError,
  EntityIndexOverflowError,
  ManagedBufferOutOfBoundsError,
  ProtectedResourceError,
  type RelationshipSelfCycleError,
  ResourceNotFoundError,
  type ScheduleMutationError,
  type ScheduleScopeMismatchError,
  StaleEntityError,
  type SystemSetNotRegisteredError,
  type TimeScaleInvalidError,
  type UniqueRefReleasedError,
  type UniqueRefStaleError,
  worldPoisonedError,
} from './errors';
import {
  createWorldIdentity,
  healthyWorldExecutionState,
  poisonedWorldExecutionState,
  type WorldExecutionFault,
  type WorldExecutionState,
} from './execution/shared-kernel';
import { type FrameArena, WorldFrameArena } from './frame-arena';
import { SharedRefStore, UniqueRefStore } from './managed-ref-store';
import {
  isSuspendedMemoryResult,
  MemoryError,
  WORLD_MEMORY_COVERAGE,
  type WorldMemoryStats,
} from './memory-types';
import { OwnedBuffers } from './owned-buffers';
import {
  createQuery,
  type Query,
  type QueryCreationError,
  type QueryDescriptor,
} from './query/query';
import {
  decodeRelationshipTarget,
  isExclusiveRelationshipSource,
  isRelationshipTarget,
  RelationshipIndex,
  type RelationshipOverlay,
  type RelationshipRole,
  type RelationshipTargetComponent,
  relationshipRole,
  relationshipSource,
  relationshipTarget,
} from './relationship-index';
import { RemovedComponentEvents } from './removed-components';
import { assertResource, type Resource, type ResourceIdentity } from './resource';
import {
  createSchedule,
  isSystemSet,
  type Schedule,
  type System,
  type SystemDescriptor,
  type SystemSet,
  type SystemToken,
} from './schedule';
import {
  observeScheduleRuns as observeWorldScheduleRuns,
  type ScheduleRunObserver,
} from './schedule-observation';
import { FixedUpdate, isDomainSchedule, type ScheduleToken, Update } from './schedule-token';
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
  spawnRosterMatches,
} from './storage/archetype-graph';
import { ArrayRangeLog, type ArrayRangesChange } from './storage/array-range-log';
import { ARRAY_FIELD_ARITY, ArrayStore } from './storage/array-store';
import { CHANGE_CHUNK_SHIFT, stampChange, stampChangeRange } from './storage/change-column';
import {
  type ChangeTicks,
  markComponentsAdded,
  readComponentAdded,
  readComponentChanged,
  removeSparseTag,
  writeComponentChanged,
} from './storage/change-detection';
import { ChangeIndex } from './storage/change-index';
import {
  borrowColumnArray,
  type Column,
  columnArrayElement,
  columnArrayLength,
  copyColumnArray,
  type FieldView,
  isNumericArray,
} from './storage/column';
import { EntityRecords } from './storage/entity-records';
import { appendTableRow, copyColumnRow, removeTableRow, type Table } from './storage/table';
import {
  createWorldClock,
  DEFAULT_TIME_POLICY,
  FixedTime,
  Time,
  type TimeScaleLease,
  type WorldOptions,
} from './time';
import { worldInternal } from './world-internal';
import { type WorldRead, worldRead } from './world-read';
import {
  detachWorldInspection,
  fixedStepIsDeferred,
  resumeWorldFixedStep,
  type ScheduleRunError,
  type ScheduleUpdateError,
  worldAddSystem,
  worldAddSystems,
  worldRemoveSystem,
  worldReplaceSystem,
  worldRun,
  worldScheduleData,
  worldScheduleUsesComponent,
  worldUpdate,
} from './world-scheduling';

export type { ComponentData } from './component';
export type { EcsError } from './errors';

type WritableComponent<C extends Component> = C extends RelationshipTargetComponent ? never : C;

type ErrorContext = { readonly systemName: string };

/**
 * Per-archetype summary returned by `world.inspect()`. Sorted ComponentId key
 * (always prefixed by the id=0 Entity column, e.g. "0+2+5+7"),
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
   * Per-system summary. One entry per
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
export type WorldScheduleQueryData = Readonly<Record<keyof QueryDescriptor, readonly string[]>>;

/** JSON-safe system registration and access metadata. */
export interface WorldScheduleSystemData {
  readonly id: number;
  readonly name: string;
  readonly sets: readonly number[];
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly queries: readonly WorldScheduleQueryData[];
  readonly resources: readonly string[];
}

/** JSON-safe system-set membership and ordering metadata. */
export interface WorldScheduleSetData {
  readonly id: number;
  readonly name: string;
  readonly members: readonly number[];
  readonly chained: boolean;
}

/** JSON-safe projection of one explicit World schedule. */
export interface WorldScheduleData {
  readonly id: number;
  readonly anchors: readonly { readonly id: number; readonly name: string }[];
  readonly name: string;
  readonly systems: readonly WorldScheduleSystemData[];
  readonly systemSets: readonly WorldScheduleSetData[];
  readonly dependencies: readonly (readonly [number, number])[];
}

/** `Object.is` over stored column numbers, inlinable without boxing doubles. */
function sameStoredValue(a: number, b: number): boolean {
  return a === b ? a !== 0 || 1 / a === 1 / b : Number.isNaN(a) && Number.isNaN(b);
}

const NO_LINKED_CHILDREN: readonly EntityHandle[] = Object.freeze([]);

/**
 * The World owns the component registry, archetype graph, entity index table,
 * and recyclable free-list.
 */
export class World {
  readonly [worldRead]: WorldRead = {
    hasRelationshipEdge: (component, source, target) => {
      const role = relationshipRole(component);
      if (role?.kind !== 'source') return false;
      const index = this.relationshipIndexes.get(componentId(component));
      const slot = index?.slotForTarget(source, target);
      return (
        slot !== undefined &&
        this.internalgetFieldValue(source, component, role.sourceField) === target &&
        this.internalgetArrayElement(target, role.target, role.targetField, slot) === source
      );
    },
    getRelationshipEpoch: (component) =>
      this.relationshipIndexes.get(componentId(component))?.epoch ?? 0,
    getChangedEpoch: (entity, component) =>
      this.internalgetChangedEpoch(entity, componentId(component)),
    getComponentEpoch: (component) => this.componentMutationEpochs[componentId(component)] ?? 0,
    getAddedEpoch: (entity, component) =>
      this.internalgetComponentChange(entity, componentId(component))?.added ?? 0,
    getMutationEpoch: () => this.mutationEpoch,
    readRemoved: (component, cursor, visit) =>
      this.removedEventsFor(componentId(component)).read(cursor, visit),
    getFieldValue: this.internalgetFieldValue.bind(this),
    getArrayLength: this.internalgetArrayLength.bind(this),
    getArrayElement: this.internalgetArrayElement.bind(this),
    copyArray: (entity, component, fieldName, target) =>
      this.copyArrayTo(entity, component, fieldName, target),
  };
  // ── Internal state ──

  /** World-local state is kept together so one owner closes each mutation. */
  private executionState: WorldExecutionState = healthyWorldExecutionState(createWorldIdentity());
  private readonly graph: ArchetypeGraph;
  private readonly records = new EntityRecords();
  private readonly freeIndices: number[] = [];
  /** Backing of variable `array<T>` fields; columns hold the location. */
  private readonly arrayStore = new ArrayStore();
  private readonly arenaOwner: WorldFrameArena;
  readonly frameArena: FrameArena;
  readonly buffers: OwnedBuffers;
  private runningSchedule = false;
  /** Per-World managed unique-ref store used by lifecycle mutations. */
  private readonly uniqueRefs = new UniqueRefStore();
  /** Per-World shared-ref store; public read-only for direct handle operations. */
  readonly sharedRefs = new SharedRefStore();
  private readonly componentMutationEpochs: number[] = [];
  private derivedWriteActive = false;
  /** Spawn roster signature -> archetypes whose roster matched it exactly. */
  private readonly spawnArchetypes = new Map<number, Archetype[]>();
  /** Single-component added publication without a per-call id array. */
  private readonly addedScratch: number[] = [0];
  private readonly structuralChangeIndex = new ChangeIndex();
  /** Removal events, created on first read of a component's stream. */
  private readonly removedComponents = new Map<number, RemovedComponentEvents>();
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
  /** DAG schedules: the two built-in scopes, then domain schedules on first registration. */
  private readonly schedules = new Map<ScheduleToken, Schedule>([
    [Update, createSchedule(Update)],
    [FixedUpdate, createSchedule(FixedUpdate, fixedStepIsDeferred)],
  ]);
  /** Resource store: typed key-value global singletons. */
  private readonly resources = new Map<ResourceIdentity, unknown>();
  private readonly clock: ReturnType<typeof createWorldClock>;
  /** Remainder carried between fixed-step runs. */
  private fixedAccumulator = 0;
  private assetOwner: AssetReferenceOwner | undefined;
  get assets(): AssetReferenceOwner | undefined {
    return this.assetOwner;
  }

  /** One owner is attached for the World lifetime; replacement would invalidate live bindings. */
  bindAssets(owner: AssetReferenceOwner): Result<void, AssetError> {
    if (this.assetOwner !== undefined && this.assetOwner !== owner)
      return err(invalidAssetBinding('the asset owner already attached to this World'));
    const attached = owner.attach(this);
    if (!attached.ok) return attached;
    this.assetOwner = owner;
    return ok(undefined);
  }
  constructor(options: WorldOptions = {}) {
    this.arenaOwner = new WorldFrameArena(options.memory?.arena);
    this.frameArena = this.arenaOwner;
    this.buffers = new OwnedBuffers(options.memory?.buffers);
    this.graph = createArchetypeGraph(options.storage === 'shared');
    this.clock = createWorldClock({ ...DEFAULT_TIME_POLICY, ...options.time });
    this.resources.set(Time, this.clock.time);
    this.resources.set(FixedTime, this.clock.fixed);
    this[worldInternal] = {
      allocatePendingEntity: this.allocatePendingEntity.bind(this),
      cancelPendingEntity: this.cancelPendingEntity.bind(this),
      getArrayRangesChangedSince: this.internalgetArrayRangesChangedSince.bind(this),
      getArrayView: this.getArrayView.bind(this),
      arrayStore: this.arrayStore,
      openScheduleArena: () => {
        if (this.arenaOwner.isActive) return false;
        this.arenaOwner.open();
        return true;
      },
      closeScheduleArena: this.closeArena.bind(this),
      resumeFixedStep: () => this.runScheduleScope(resumeWorldFixedStep, undefined),
      updateRemovedComponents: () => {
        for (const events of this.removedComponents.values()) events.update();
      },
      clockWriter: this.clock.writer,
      getComponentChange: this.internalgetComponentChange.bind(this),
      componentMutationEpochs: this.componentMutationEpochs,
      beginDerivedWrite: () => {
        if (this.derivedWriteActive) return false;
        this.derivedWriteActive = true;
        return true;
      },
      endDerivedWrite: () => {
        this.derivedWriteActive = false;
      },
      isDerivedWriteActive: () => this.derivedWriteActive,
      visitComponentChanged: this.internalvisitComponentChanged.bind(this),
      structuralChangeIndex: this.structuralChangeIndex,
      getEntityArchetype: this.internalgetEntityArchetype.bind(this),
      getFixedAccumulator: () => this.fixedAccumulator,
      graph: this.graph,
      getMutationEpoch: () => this.mutationEpoch,
      getQueryRow: (entity, component) =>
        this.get(entity, component) as Result<Record<string, unknown>, EcsError>,
      records: this.records,
      getSchedule: (token) => {
        let schedule = this.schedules.get(token);
        if (schedule === undefined && isDomainSchedule(token)) {
          schedule = createSchedule(token);
          this.schedules.set(token, schedule);
        }
        return schedule;
      },
      schedules: this.schedules,
      getStructureEpoch: this.getStructureEpoch.bind(this),
      lookupAlive: this.lookupAlive.bind(this),
      markComponentChanged: this.internalmarkComponentChanged.bind(this),
      publishLocatedChange: this.internalpublishLocatedChange.bind(this),
      markComponentRangeChanged: this.internalmarkComponentRangeChanged.bind(this),
      materializeEntity: this.materializeEntity.bind(this),
      nextMutationEpoch: this.internalnextMutationEpoch.bind(this),
      poisonExecution: this.internalpoisonExecution.bind(this),
      publishDerivedRange: this.internalpublishDerivedRange.bind(this),
      preflightComponentData: this.preflightComponentData.bind(this),
      relationshipCycleError: this.relationshipCycleError.bind(this),
      readRow: this.readRow.bind(this),
      routeError: this.routeError.bind(this),
      restoreMutationEpoch: this.internalrestoreMutationEpoch.bind(this),
      setFixedAccumulator: (value) => {
        this.fixedAccumulator = value;
      },
      setQueryRow: this.internalsetQueryRow.bind(this),
    };
    if (options.assets !== undefined) this.bindAssets(options.assets).unwrap();
  }

  /** Immutable integrity state for execution coordinators and headless callers. */
  get execution(): WorldExecutionState {
    return this.executionState;
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
  // Internal access — query engine

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

  /** Live entity slot, or -1 for a stale / pending / unknown handle. */
  private liveSlot(entity: EntityHandle): number {
    const slot = entityIndex(entity);
    return this.records.isLive(slot, entityGeneration(entity)) ? slot : -1;
  }

  /** Resolve current logical identity for a packed entity handle. */
  private internalgetEntityArchetype(entity: EntityHandle): Archetype | undefined {
    const slot = this.liveSlot(entity);
    return slot < 0 ? undefined : this.graph.archetypes[this.records.archetypeId[slot] as number];
  }

  /** Component change state for query filters. */
  private internalgetComponentChange(
    entity: EntityHandle,
    componentId: number,
  ): ChangeTicks | undefined {
    const slot = this.liveSlot(entity);
    if (slot < 0) return undefined;
    const added = readComponentAdded(this.graph, this.records, slot, entity, componentId);
    return added === undefined
      ? undefined
      : {
          added,
          changed: this.internalgetChangedEpoch(entity, componentId),
        };
  }

  /** Last write epoch of a live entity's component, or 0. */
  private internalgetChangedEpoch(entity: EntityHandle, componentId: number): number {
    const slot = entityIndex(entity);
    if (!this.records.isLive(slot, entityGeneration(entity))) return 0;
    return readComponentChanged(this.graph, this.records, slot, componentId) ?? 0;
  }

  /**
   * Visit live slots whose component was written in `(since, upper]`, scanning
   * each owning table's chunk summaries; returns the chunks and rows examined.
   */
  private internalvisitComponentChanged(
    componentId: number,
    since: number,
    upper: number,
    visit: (slot: number) => void,
  ): number {
    let examined = 0;
    // Epoch 0 means never written; a negative `since` must not admit it.
    const floor = since < 0 ? 0 : since;
    const sparseSet = this.graph.sparseTags.get(componentId);
    if (sparseSet !== undefined) {
      if (sparseSet.changed.max <= floor) return 1;
      for (let index = 0; index < sparseSet.size; index++) {
        const epoch = sparseSet.changed.epochs[index] as number;
        if (epoch > floor && epoch <= upper)
          visit(entityIndex(sparseSet.dense[index] as EntityHandle));
      }
      return sparseSet.size;
    }
    for (const table of this.graph.tables) {
      const changed = table?.storage.get(componentId)?.changed;
      if (changed === undefined) continue;
      examined++;
      if (changed.max <= floor) continue;
      const entities = table.entities.view;
      for (let chunk = 0; chunk < changed.chunks.length; chunk++) {
        examined++;
        if ((changed.chunks[chunk] as number) <= floor) continue;
        const end = Math.min(table.size, (chunk + 1) << CHANGE_CHUNK_SHIFT);
        for (let row = chunk << CHANGE_CHUNK_SHIFT; row < end; row++) {
          examined++;
          const epoch = changed.epochs[row] as number;
          if (epoch > floor && epoch <= upper) visit(entityIndex(entities[row] as EntityHandle));
        }
      }
    }
    return examined;
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
    if (!table.storage.has(componentId)) {
      throw new Error(`Derived component ${componentId} is not in the table.`);
    }
    this.componentMutationEpochs[componentId] = epoch;
    this.publishRangeChange(table, componentId, rowStart, rowCount, epoch);
  }

  /** Record one successful structural mutation. */
  private advanceStructureEpoch(entity: EntityHandle): void {
    this.recordStructuralChange(entity, this.mutationEpoch);
    this.structureEpoch += 1;
  }

  private recordStructuralChange(entity: EntityHandle, epoch: number): void {
    try {
      this.structuralChangeIndex.set(entityIndex(entity), epoch);
    } catch (cause) {
      this.poisonAfterEntityMutation('World.publishStructureChange', cause);
      throw cause;
    }
  }

  private publishComponentChange(entity: EntityHandle, id: number, epoch: number): void {
    try {
      writeComponentChanged(this.graph, this.records, entityIndex(entity), id, epoch);
    } catch (cause) {
      this.poisonAfterEntityMutation('World.publishComponentChange', cause);
      throw cause;
    }
  }

  private notifyComponentRemoved(entity: EntityHandle, id: number): void {
    this.removedComponents.get(id)?.send(entity);
  }

  private removedEventsFor(id: number): RemovedComponentEvents {
    let events = this.removedComponents.get(id);
    if (events === undefined) {
      events = new RemovedComponentEvents();
      this.removedComponents.set(id, events);
    }
    return events;
  }

  private publishRangeChange(
    table: Table,
    id: number,
    start: number,
    count: number,
    epoch: number,
  ): void {
    const changed = table.storage.get(id)?.changed;
    try {
      if (changed !== undefined) stampChangeRange(changed, start, count, epoch);
    } catch (cause) {
      this.poisonAfterEntityMutation('World.publishComponentChange', cause);
      throw cause;
    }
  }

  /** Current structural revision for mounted World projections. */
  getStructureEpoch(): number {
    return this.structureEpoch;
  }

  /** Mark one mutation's component instances with a shared epoch. */
  private internalmarkComponentsAdded(entity: EntityHandle, componentIds: ArrayLike<number>): void {
    const slot = this.liveSlot(entity);
    if (slot < 0) return;
    const epoch = this.internalnextMutationEpoch();
    markComponentsAdded(
      this.graph,
      this.records,
      slot,
      entity,
      componentIds,
      this.componentMutationEpochs,
      epoch,
    );
  }

  /** Mark an existing component as changed at the current tick. */
  private internalmarkComponentChanged(entity: EntityHandle, componentId: number): boolean {
    const slot = this.liveSlot(entity);
    if (slot < 0) return false;
    if (readComponentAdded(this.graph, this.records, slot, entity, componentId) === undefined)
      return false;
    const epoch = this.internalnextMutationEpoch();
    this.componentMutationEpochs[componentId] = epoch;
    this.publishComponentChange(entity, componentId, epoch);
    return true;
  }

  private internalpublishLocatedChange(_slot: number, componentId: number, epoch: number): void {
    this.componentMutationEpochs[componentId] = epoch;
  }

  /** Mark one contiguous component range with a single epoch. */
  private internalmarkComponentRangeChanged(
    table: ArchetypeGraph['tables'][number],
    componentId: number,
    rowStart: number,
    rowCount: number,
  ): void {
    if (!table.storage.has(componentId) || rowCount === 0) return;
    const epoch = this.internalnextMutationEpoch();
    this.componentMutationEpochs[componentId] = epoch;
    this.publishRangeChange(table, componentId, rowStart, rowCount, epoch);
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

  /** Route an expected internal failure through the host-owned error channel. */
  private routeError(err: unknown, ctx?: ErrorContext): void {
    // Internal expected failures are reported without becoming a second
    // schedule or terminal hook. The host owns fatal frame policy.
    console.error(`[${ctx?.systemName ?? 'World'}]`, err);
  }
  // System registration + update (M3)

  /** Register a system in one schedule. Ordering references and sets must share its scope. */
  addSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
    schedule: import('./schedule-token').ScheduleToken,
    descriptor: System<Qs>,
  ): Result<void, ScheduleScopeMismatchError> {
    return worldAddSystem(this, schedule, descriptor);
  }

  /**
   * Observe synchronous system and command-drain boundaries while subscribed.
   * The callback is a generic diagnostics seam; observer failures are ignored
   * by the scheduler and cannot alter World execution.
   */
  observeScheduleRuns(observer: ScheduleRunObserver): () => void {
    return observeWorldScheduleRuns(this, observer);
  }

  /** Remove this exact registered system identity and its set memberships. */
  removeSystem(
    schedule: import('./schedule-token').ScheduleToken,
    system: SystemToken,
  ): Result<void, ScheduleMutationError | ScheduleScopeMismatchError> {
    return worldRemoveSystem(this, schedule, system);
  }

  /** Replace an implementation while preserving its identity, order and set memberships. */
  replaceSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
    schedule: import('./schedule-token').ScheduleToken,
    system: SystemToken,
    descriptor: SystemDescriptor<Qs>,
  ): Result<void, ScheduleMutationError | ScheduleScopeMismatchError> {
    return worldReplaceSystem(this, schedule, system, descriptor);
  }

  /** Register these system identities as members of this schedule-local set. */
  addSystems<const Qs extends ReadonlyArray<QueryDescriptor>>(
    schedule: import('./schedule-token').ScheduleToken,
    set: SystemSet,
    systems: ReadonlyArray<System<Qs>>,
  ): Result<void, SystemSetNotRegisteredError | ScheduleScopeMismatchError> {
    return worldAddSystems(this, schedule, set, systems);
  }

  /** Test registration by identity without reading an inspection snapshot. */
  hasSystem(
    schedule: import('./schedule-token').ScheduleToken,
    system: SystemToken | SystemSet,
  ): boolean {
    const current = this.schedules.get(schedule);
    if (current === undefined) return false;
    return isSystemSet(system)
      ? (current.sets.get(system)?.members.size ?? 0) > 0
      : current.systems.has(system);
  }

  /** Own a global speed contribution, sampled on the next update. */
  acquireTimeScale(scale = 1): Result<TimeScaleLease, TimeScaleInvalidError> {
    return this.clock.acquireTimeScale(scale);
  }

  /** Advance variable time, run owed fixed steps and the Update schedule, then flush commands.
   * Expected failures return Result; unexpected partial writes poison this World. */
  update(deltaSeconds = 0): Result<void, ScheduleUpdateError | MemoryError> {
    if (this.runningSchedule) return err(new MemoryError({ kind: 'scope', reason: 'reentrant' }));
    return this.runScheduleScope(worldUpdate, deltaSeconds);
  }

  /**
   * Run one domain schedule (see `defineSchedule`) in DAG order and flush its
   * commands. World time does not advance; failures follow `update()`.
   */
  run(schedule: ScheduleToken): Result<void, ScheduleRunError | MemoryError> {
    return this.runScheduleScope(worldRun, schedule);
  }

  /** All synchronous and resumed schedule work enters the same execution scope.
   * Pass static operations so the frame path creates no callback closure. */
  private runScheduleScope<A, R>(run: (world: World, argument: A) => R, argument: A): R {
    const wasRunning = this.runningSchedule;
    this.runningSchedule = true;
    try {
      return run(this, argument);
    } finally {
      this.runningSchedule = wasRunning;
    }
  }

  /** Group synchronously contiguous domain runs under one arena lifetime. */
  withFrameArena<T, E>(run: () => Result<T, E>): Result<T, E | MemoryError> {
    if (this.runningSchedule || this.arenaOwner.isActive || this.execution.health !== 'healthy')
      return err(new MemoryError({ kind: 'scope', reason: 'reentrant' }));
    this.arenaOwner.open();
    try {
      const result = run();
      if (isSuspendedMemoryResult(result)) {
        const error = new MemoryError({ kind: 'scope', reason: 'asynchronous' });
        this[worldInternal].poisonExecution({
          code: 'shared-kernel-failed',
          kernelName: 'memory-scope',
          cause: error,
          partialWrite: true,
          retryable: false,
        });
        return err(error);
      }
      return result;
    } catch (cause) {
      if (cause instanceof MemoryError) return err(cause);
      const error = new MemoryError({ kind: 'scope', reason: 'callback-failed', cause });
      this[worldInternal].poisonExecution({
        code: 'shared-kernel-failed',
        kernelName: 'memory-scope',
        cause,
        partialWrite: true,
        retryable: false,
      });
      return err(error);
    } finally {
      this.closeArena();
    }
  }

  private closeArena(): void {
    this.arenaOwner.close();
    this.buffers.maintain();
  }

  /** Cold observation. Shared backing is counted once; native/domain payloads are excluded. */
  memoryStats(): WorldMemoryStats {
    const graph = this.graph;
    const buffers = new Set<ArrayBufferLike>();
    for (const table of graph.tables) {
      if (table === undefined) continue;
      for (const storage of table.storage.values()) {
        buffers.add(storage.added.buffer);
        for (const column of storage.fields.values()) buffers.add(column.view.buffer);
      }
    }
    let tableBytes = 0;
    for (const buffer of buffers) tableBytes += buffer.byteLength;
    let archetypeBytes = 0;
    for (const archetype of graph.archetypes)
      if (archetype !== undefined) archetypeBytes += archetype.rows.byteLength;
    const records = this.records;
    return {
      arena: this.arenaOwner.stats(),
      buffers: this.buffers.memoryStats(),
      arrays: this.arrayStore.stats(),
      readers: this.buffers.stats(),
      tableBytes,
      archetypeBytes,
      entityRecordBytes:
        records.generation.byteLength +
        records.archetypeId.byteLength +
        records.archetypeRow.byteLength +
        records.tableRow.byteLength,
      coverage: WORLD_MEMORY_COVERAGE,
    };
  }

  /** Explicit cold-memory release; never invalidates live slots or leases. */
  trimMemory(): Result<number, MemoryError> {
    if (this.arenaOwner.isActive)
      return err(new MemoryError({ kind: 'scope', reason: 'reentrant' }));
    return ok(this.arenaOwner.trim() + this.buffers.trim() + this.arrayStore.trim());
  }
  // Resource CRUD (M3)

  /** Insert or overwrite a resource (idempotent, E-13). */
  insertResource<T>(key: Resource<T>, value: NoInfer<T>): void {
    const identity: ResourceIdentity = key;
    if (identity === Time || identity === FixedTime)
      throw new ProtectedResourceError(key.name, 'insert');
    assertResource(key);
    this.internalnextMutationEpoch();
    this.resources.set(key, value);
  }

  /**
   * Get a resource by key.
   * @throws ResourceNotFoundError if key not found (E-14).
   */
  getResource<T>(key: Resource<T>): T {
    assertResource(key);
    const value = this.resources.get(key);
    if (value === undefined && !this.resources.has(key)) throw new ResourceNotFoundError(key.name);
    return value as T;
  }

  /** Check if a resource exists. */
  hasResource(key: ResourceIdentity): boolean {
    assertResource(key);
    return this.resources.has(key);
  }

  /** Remove a resource by key. */
  removeResource(key: ResourceIdentity): void {
    if (key === Time || key === FixedTime) throw new ProtectedResourceError(key.name, 'remove');
    assertResource(key);
    if (this.resources.delete(key)) this.internalnextMutationEpoch();
  }
  // Inspection / diagnostics (M4)

  /** Return a detached diagnostic snapshot of entities, storage, schedules, and resources. */
  inspect(): WorldInspection {
    const graph = this.graph;
    let entityCount = 0;
    const archetypes: WorldInspection['archetypes'] = [];
    const activeComponentSet = new Set<string>();
    for (const arch of graph.archetypes) {
      if (!arch) continue;
      entityCount += arch.size;
      const componentNames = arch.components.map((component) => component.name);
      archetypes.push({
        key: arch.key,
        componentNames,
        entityCount: arch.size,
        tableId: arch.table.id,
      });
      if (arch.size > 0) for (const name of componentNames) activeComponentSet.add(name);
    }

    const schedules = [...this.schedules].map(([token, schedule]) => {
      const systems = [...schedule.systems.entries()].map(([name]) => ({
        id: schedule.systems.get(name)?.registrationIndex ?? -1,
        name: name.name,
        sets: [...schedule.sets].flatMap(([set, record]) =>
          record.members.has(name) ? [set.name] : [],
        ),
      }));
      return { schedule: token, systems };
    });
    const systems = schedules.flatMap((entry) => entry.systems);
    const tables = graph.tables.map((table) => ({
      id: table.id,
      key: table.key,
      componentNames: table.components.map((component) => component.name),
      entityCount: table.size,
      capacity: table.capacity,
    }));
    return detachWorldInspection({
      entityCount,
      archetypeCount: archetypes.length,
      archetypes,
      tableCount: tables.length,
      tables,
      activeComponents: [...activeComponentSet],
      systemCount: systems.length,
      systems,
      resourceKeys: [...this.resources.keys()].map((key) => key.name),
      schedules,
      scheduleSystemCount(token: ScheduleToken): number {
        return schedules.find((entry) => entry.schedule === token)?.systems.length ?? 0;
      },
    });
  }

  /** Read the actual component vocabulary of one live entity, including sparse tags. */
  componentsOf(entity: EntityHandle): Result<readonly Component[], EcsError> {
    const slot = this.lookupAlive(entity, 'componentsOf');
    if (!slot.ok) return slot;
    return ok([
      ...(this.graph.archetypes[this.records.archetypeId[slot.value] as number]?.components ?? []),
    ]);
  }

  /** Return the registered schedule graphs and their declared access metadata. */
  scheduleData(): ReadonlyArray<WorldScheduleData> {
    return worldScheduleData(this);
  }
  // Managed-ref public API (feat-20260528-rapier-physics M1 / t4)

  /** Allocate one non-asset payload owned by a unique handle.
   * ECS fields release it on overwrite/removal/despawn; the optional deleter runs once.
   * A standalone handle must be released explicitly when ownership is not transferred. */
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

  /** Allocate a reference-counted non-asset payload. The caller owns the initial reference;
   * every ECS field retains/releases its own reference. Use asset fields for registry-owned assets. */
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
  // Component access and storage — World owns mutation state and coordination.
  // Independent table/column algorithms remain private methods so all mutation
  // paths share one state owner and publication boundary.

  private relationshipTargetWriteError(
    component: Component,
    operation: string,
  ): Result<never, EcsError> {
    return err(createRelationshipTargetReadonlyError(component.name, operation));
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

  private tableRow(slot: number): number {
    const records = this.records;
    if (slot < 0 || slot >= records.length) return -1;
    return records.tableRow[slot] as number;
  }

  private markComponentChanged(entity: EntityHandle, component: Component): void {
    // These callers already changed owned payload. Query mutable borrows use
    // the internal pre-write entry directly and may still fail without mutation.
    try {
      this.internalmarkComponentChanged(entity, componentId(component));
    } catch (cause) {
      this.poisonAfterEntityMutation('World.publishComponentChange', cause);
      throw cause;
    }
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

  /** One bound validator: write preflight allocates no closure per call. */
  private readonly validateAssetReference = (
    handle: number,
    target: string,
  ): Result<void, AssetError> =>
    this.assets?.validate(handle, target) ??
    err(invalidAssetBinding('an asset owner attached to the World'));

  private preflightComponentFieldValues(
    component: Component,
    data: Readonly<Record<string, unknown>>,
  ): Result<void, EcsError> {
    return validateComponentFieldValues(component, data, this.validateAssetReference);
  }

  /**
   * Validate one structural component payload without touching archetypes,
   * columns, relationship mirrors, epochs, or managed-reference stores.
   * CommandBuffer uses this same owner-level gate as the direct World facade;
   * the optional pending set lets a batch refer to an entity reserved earlier
   * in that batch without mistaking it for a stale live handle.
   * Fieldless components reuse an immutable canonical input binding.
   */
  private preflightComponentData(
    operation: 'spawn' | 'addComponent' | 'command',
    holder: EntityHandle | null,
    componentData: ComponentData,
    pendingEntities?: ReadonlySet<number>,
    unavailableEntities?: ReadonlySet<number>,
    relationshipOverlay?: RelationshipOverlay,
  ): Result<Readonly<ComponentData>, EcsError> {
    const component = componentData.component;
    const data = componentData.data as Record<string, unknown>;
    // Initialization builds an owned record from the schema's field names.
    // Borrowed values and live World references still need admission below.
    const initialized = InitializedComponentData.is(componentData);
    const keyError = initialized ? null : validateComponentDataKeys(component, data);
    if (keyError !== null) return err(keyError);
    const empty = componentEmptyInput(component);
    if (empty !== undefined) return empty;
    const admitted = initialized ? componentData : new InitializedComponentData(component, data);
    const filled = admitted.data as Record<string, unknown>;
    const valuePreflight = this.preflightComponentFieldValues(component, filled);
    if (!valuePreflight.ok) return valuePreflight;
    if (isRelationshipTarget(component) && this.relationshipTargetPayloadWrites(filled)) {
      return err(createRelationshipTargetReadonlyError(component.name, operation));
    }

    const enumError = validateEnumFieldValues(
      component,
      filled,
      holder === null ? undefined : (holder as number),
    );
    if (enumError !== null) return err(enumError);

    const role = relationshipRole(component as Component);
    if (role?.kind !== 'source') return ok(admitted);
    const target = decodeRelationshipTarget(filled[role.sourceField]);
    if (target === null) return ok(admitted);

    const targetRaw = target as unknown as number;
    if (unavailableEntities?.has(targetRaw) === true) {
      return this.staleEntityFailure(target, 'relationship-insert', component.name);
    }
    const targetIsPending = pendingEntities?.has(targetRaw) === true;
    const targetLive = this.liveSlot(target) >= 0;
    const holderIsPending =
      holder === null || pendingEntities?.has(holder as unknown as number) === true;
    if (!targetIsPending && !targetLive && !holderIsPending) {
      return this.staleEntityFailure(target, 'relationship-insert', component.name);
    }

    // A pending holder has no row to walk yet. Once materialized, its target
    // is still checked by the same source-side relationship callback.
    if (holderIsPending) {
      return ok(admitted);
    }
    const cycleError = this.preflightRelationshipCycleError(
      component as Component,
      role,
      target,
      holder,
      relationshipOverlay,
    );
    if (cycleError !== null) return err(cycleError);
    return ok(admitted);
  }

  /** A committed-cycle failure keeps its priority unless an earlier command removed that cycle. */
  private preflightRelationshipCycleError(
    component: Component,
    role: Extract<RelationshipRole, { kind: 'source' }>,
    start: EntityHandle,
    holder: EntityHandle,
    overlay: RelationshipOverlay | undefined,
  ): RelationshipSelfCycleError | null {
    const cycle = this.relationshipCycleError(component, role, start, holder);
    return cycle === null || overlay === undefined
      ? cycle
      : this.relationshipCycleError(component, role, start, holder, overlay);
  }

  private relationshipCycleError(
    component: Component,
    role: Extract<RelationshipRole, { kind: 'source' }>,
    start: EntityHandle | null,
    holder: EntityHandle,
    overlay?: RelationshipOverlay,
  ): RelationshipSelfCycleError | null {
    if (start === null) return null;
    if (start === holder) {
      return role.allowSelf
        ? null
        : createRelationshipSelfCycleError(component.name, holder as number, holder as number);
    }
    const sourceField = role.sourceField;
    let visited: Set<EntityHandle> | undefined;
    let current = start;
    while (true) {
      if (current === holder)
        return createRelationshipSelfCycleError(component.name, holder as number, holder as number);
      if (visited?.has(current)) return null;
      const staged = overlay?.get(current as number)?.get(componentId(component));
      const next =
        staged === undefined ? this.internalgetFieldValue(current, component, sourceField) : staged;
      if (next === null || next === undefined || next === ENTITY_NULL_RAW) return null;
      visited ??= new Set();
      visited.add(current);
      current = next as EntityHandle;
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
    role: Extract<RelationshipRole, { kind: 'source' }>,
    value: Record<string, unknown>,
    slot: number,
    markChanged: boolean,
  ): Result<void, EcsError> {
    const oldRelationshipTarget = decodeRelationshipTarget(
      this.internalgetFieldValue(entity, component, role.sourceField),
    );
    const mergedValue = { [role.sourceField]: oldRelationshipTarget, ...value };
    const nextRelationshipTarget = decodeRelationshipTarget(mergedValue[role.sourceField]);
    const relationshipChanged = oldRelationshipTarget !== nextRelationshipTarget;
    let preparedMirrorAdded: boolean | undefined;

    if (relationshipChanged && nextRelationshipTarget !== null) {
      // Keep the hot source-write path equivalent to the public relationship
      // preflight, without re-running the generic component-data validator
      // over the already-read/merged source row.
      if (this.liveSlot(nextRelationshipTarget) < 0) {
        return this.staleEntityFailure(
          nextRelationshipTarget,
          'relationship-insert',
          component.name,
        );
      }
      const cycleError = this.relationshipCycleError(
        component,
        role,
        nextRelationshipTarget,
        entity,
      );
      if (cycleError !== null) return err(cycleError);
      const prepared = this.prepareRelationshipInsert(component, nextRelationshipTarget);
      if (!prepared.ok) return prepared;
      preparedMirrorAdded = prepared.value;
    }

    // Prepare first, then detach/attach the mirror, and only then publish the
    // source scalar. A later relationship error can therefore poison the same
    // World without exposing a source value that disagrees with its mirror.
    if (relationshipChanged && oldRelationshipTarget !== null) {
      const removed = this.relationshipOnRemove(entity, component, oldRelationshipTarget);
      if (!removed.ok) {
        this.poisonAfterEntityMutation('World.set', removed.error);
        return removed;
      }
    }
    if (relationshipChanged && nextRelationshipTarget !== null) {
      const inserted = this.relationshipOnInsert(
        entity,
        component,
        nextRelationshipTarget,
        preparedMirrorAdded,
      );
      if (!inserted.ok) {
        this.poisonAfterEntityMutation('World.set', inserted.error);
        return inserted;
      }
    }

    // Mirror admission/removal may migrate a table neighbor and swap this
    // source into another row. Resolve the live location after that work.
    const currentArchetype = this.internalgetEntityArchetype(entity);
    const currentRow = this.tableRow(slot);
    const sourceColumn = currentArchetype?.table.storage
      .get(componentId(component))
      ?.fields.get(role.sourceField);
    if (sourceColumn === undefined || currentRow < 0) {
      const error = new ComponentNotPresentError(entity as number, component.name);
      this.poisonAfterEntityMutation('World.set', error);
      return err(error);
    }
    sourceColumn.view[currentRow] =
      nextRelationshipTarget === null ? ENTITY_NULL_RAW : (nextRelationshipTarget as number);
    if (markChanged) this.markComponentChanged(entity, component);
    return ok(undefined);
  }

  /** Prepare the target side before a source archetype mutation commits. */
  private prepareRelationshipInsert(
    component: Component,
    target: EntityHandle | null,
  ): Result<boolean, EcsError> {
    const role = relationshipRole(component);
    if (role?.kind !== 'source') return ok(false);
    if (target === null) return ok(false);
    const mirror = role.target;
    const targetRec = this.liveSlot(target);
    if (targetRec < 0) {
      return this.staleEntityFailure(target, 'relationship-insert', component.name);
    }
    const targetArch = this.graph.archetypes[this.records.archetypeId[targetRec] as number];
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
    const capacity = this.reserveRelationshipCell(target, role);
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
    target: EntityHandle | null,
    // addComponentCore may have prepared the target before migrating the
    // source. Carry that one-shot fact so the final commit can publish a
    // newly-created mirror exactly once instead of preparing a second time.
    preparedMirrorAdded?: boolean,
  ): Result<void, EcsError> {
    const role = relationshipRole(component);
    if (role?.kind !== 'source') return ok(undefined);
    if (target === null) return ok(undefined);
    const mirror = role.target;

    let mirrorAdded = preparedMirrorAdded ?? false;
    if (preparedMirrorAdded === undefined) {
      const prepared = this.prepareRelationshipInsert(component, target);
      if (!prepared.ok) {
        // A dangling source edge is still useful state: hierarchy/animation
        // projections report the missing target. The target mirror cannot be
        // updated, but insertion itself remains atomic and successful.
        if (prepared.error.code === 'stale-entity') return ok(undefined);
        return prepared;
      }
      mirrorAdded = prepared.value;
    }

    // Preparation owns mirror creation; its captured target may have been despawned.
    if (this.liveSlot(target) < 0) return ok(undefined);
    const mirrorLocalId = componentId(mirror);
    const mirrored = this.reserveRelationshipCell(target, role, holder);
    if (!mirrored.ok) return mirrored;
    this.relationshipIndex(component)?.attach(holder, target, mirrored.value);
    if (mirrorAdded) {
      try {
        this.internalmarkComponentsAdded(target, [mirrorLocalId]);
        this.advanceStructureEpoch(target);
      } catch (cause) {
        this.poisonAfterEntityMutation('World.relationshipOnInsert', cause);
        throw cause;
      }
    }
    return ok(undefined);
  }

  /** Remove `holder` from the materialized target list. */
  private relationshipOnRemove(
    holder: EntityHandle,
    component: Component,
    target: EntityHandle | null,
  ): Result<void, EcsError> {
    const role = relationshipRole(component);
    if (role?.kind !== 'source') return ok(undefined);
    if (target === null) return ok(undefined);
    const targetSlot = this.liveSlot(target);
    if (targetSlot < 0) return ok(undefined);

    const index = this.relationshipIndex(component);
    const slot = index?.slotForTarget(holder, target);
    if (index === undefined || slot === undefined) return ok(undefined);
    const mirrored = this.removeRelationshipElement(target, targetSlot, role, slot);
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
  ): readonly EntityHandle[] {
    const row = this.tableRow(entityIndex(entity));
    let collected: EntityHandle[] | undefined;
    const components = archetype.components;
    for (let index = 0; index < components.length; index++) {
      const component = components[index] as Component;
      const mirrorField = this.linkedSpawnMirrorField(component);
      if (mirrorField === undefined) continue;
      const snapshot = this.readRow(archetype, component, row) as Record<string, unknown>;
      const list = snapshot[mirrorField];
      if (!(list instanceof Uint32Array)) continue;
      collected ??= [];
      for (const raw of list) {
        if (raw !== ENTITY_NULL_RAW) collected.push(raw as EntityHandle);
      }
    }
    // Most despawns retire no linked children: share the empty answer.
    return collected ?? NO_LINKED_CHILDREN;
  }

  /** Read a live component. Missing/stale entities return structured errors.
   * Numeric arrays borrow transient storage; relationship targets and asset arrays are detached. */
  get<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): Result<ShapeOf<S>, EcsError> {
    const componentName = component.name;
    const rec = this.liveSlot(entity);
    if (rec < 0) return this.staleEntityFailure(entity, 'get', componentName);
    const arch = this.graph.archetypes[this.records.archetypeId[rec] as number];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!arch) {
      return this.staleEntityFailure(entity, 'get', component.name);
    }

    // Check if this archetype has the component (using World-local ID).
    const localId = componentId(component);
    if (!archetypeHasComponent(arch, localId)) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }

    return ok(this.readRow(arch, component, this.tableRow(rec)));
  }

  /** Internal zero-copy array lookup. The view is valid only until its storage moves
   * or is released; public relationship-target reads detach it. */
  private getArrayView(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): FieldView | undefined {
    const slot = this.liveSlot(entity);
    if (slot < 0) return undefined;
    const column = this.fieldColumn(slot, component, fieldName);
    const plan = column?.layout;
    return column !== undefined && plan?.array !== undefined
      ? borrowColumnArray(this.arrayStore, column, this.tableRow(slot), plan)
      : undefined;
  }

  /** Overwrite a bounded numeric array window without resizing. Invalid offsets/types
   * fail before writing; successful writes publish component and range changes. */
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
    const record = this.liveSlot(entity);
    if (record < 0) return this.staleEntityFailure(entity, 'setArrayRange', component.name);
    const arch = this.graph.archetypes[this.records.archetypeId[record] as number];
    const localId = componentId(component);
    if (arch === undefined || !archetypeHasComponent(arch, localId)) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const column = arch.table.storage.get(localId)?.fields.get(fieldName);
    const plan = column?.layout;
    if (
      column === undefined ||
      plan?.array === undefined ||
      plan.array.elementType === 'entity' ||
      plan.reference !== undefined ||
      component.storage === 'sparse'
    ) {
      return err(
        new ArrayRangeOutOfBoundsError(component.name, fieldName, offset, values.length, -1),
      );
    }
    const row = this.tableRow(record);
    // A variable cell needs its own bounds for native set; fixed rows write
    // directly into the inline column without allocating a row view.
    const variable = plan.kind === 'array';
    const view = variable ? borrowColumnArray(this.arrayStore, column, row, plan) : column.view;
    const size = variable ? view.length : plan.arity;
    if (!Number.isInteger(offset) || offset < 0 || offset + values.length > size) {
      return err(
        new ArrayRangeOutOfBoundsError(component.name, fieldName, offset, values.length, size),
      );
    }
    if (values.length === 0) return ok(undefined);
    const previous =
      readComponentChanged(this.graph, this.records, entityIndex(entity), localId) ?? 0;
    view.set(values, variable ? offset : row * plan.arity + offset);
    try {
      const epoch = this.internalnextMutationEpoch();
      this.componentMutationEpochs[localId] = epoch;
      this.publishComponentChange(entity, localId, epoch);
      if (offset === 0 && values.length === size)
        this.arrayRangeLog.forgetField(entity as number, localId, fieldName);
      else
        this.arrayRangeLog.record(
          entity as number,
          localId,
          fieldName,
          previous,
          epoch,
          offset,
          offset + values.length,
        );
    } catch (cause) {
      this.poisonAfterEntityMutation('World.setArrayRange', cause);
      throw cause;
    }
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

  /** Patch supplied fields and publish actual scalar changes.
   * Preflight validates before mutation; managed fields release prior ownership before replacement. */
  set<C extends Component>(
    entity: EntityHandle,
    component: C & WritableComponent<C>,
    value: NoInfer<Partial<InputShapeOf<SchemaOf<C>>>>,
    markChanged = true,
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    if (isRelationshipTarget(component)) return this.relationshipTargetWriteError(component, 'set');
    // Per-frame writes: resolve the live record without an intermediate Result.
    const rec = this.liveSlot(entity);
    if (rec < 0) return this.staleEntityFailure(entity, 'set', component.name);

    const arch = this.graph.archetypes[this.records.archetypeId[rec] as number];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!arch) {
      return this.staleEntityFailure(entity, 'set', component.name);
    }
    const row = this.tableRow(rec);
    const definition = componentDefinition(component);
    const localId = definition.id;
    if (!archetypeHasComponent(arch, localId)) {
      // F-02: set on missing component returns err instead of silent ignore
      return err(new ComponentNotPresentError(entity as number, component.name));
    }
    const relationship = relationshipRole(component);
    if (relationship?.kind === 'source') {
      return this.setRelationshipSource(
        entity,
        component,
        relationship,
        value as Record<string, unknown>,
        rec,
        markChanged,
      );
    }
    if (definition.plan.scalarOnly && component.storage !== 'sparse') {
      return this.setScalarFields(
        entity,
        component,
        definition,
        arch,
        row,
        value as Record<string, unknown>,
        markChanged,
      );
    }
    const valuePreflight = this.preflightComponentFieldValues(
      component,
      value as Record<string, unknown>,
    );
    if (!valuePreflight.ok) return valuePreflight;
    // Enum constraints are field-local; untouched fields are already validated.
    const enumError = validateEnumFieldValues(component, value, entity as number);
    if (enumError !== null) return err(enumError);

    if (component.storage === 'sparse') {
      if (markChanged) this.internalmarkComponentChanged(entity, localId);
      return ok(undefined);
    }
    const fieldCols = arch.table.storage.get(localId)?.fields;
    if (fieldCols === undefined) {
      throw new Error(`Table storage for ${component.name} does not exist.`);
    }
    const heldAssets = holdAssetFields(this.assets, component, value);
    if (!heldAssets.ok) return heldAssets;
    try {
      let changed = false;
      // for-in over the caller's plain payload: no key array per write.
      const data = value as Record<string, unknown>;
      // Capture only inputs whose storage this patch overwrites. In particular,
      // releasing a variable field lets alloc() reuse and clear its borrowed
      // bytes. Capture before ANY writes so swaps across fields also work.
      // Ordinary scalar writes and unaliased payloads never copy content.
      let captured: Record<string, unknown> | undefined;
      for (const fieldName in data) {
        const raw = data[fieldName];
        const buffer = ArrayBuffer.isView(raw) ? raw.buffer : null;
        if (buffer === null) continue;
        const destination = this.overwrittenDestination(definition, fieldCols, data, row, buffer);
        // Inline TypedArray.set handles its own overlap without a temporary.
        if (destination === undefined || destination === fieldName) continue;
        captured ??= {};
        captured[fieldName] = (raw as FieldView).slice();
      }
      for (const fieldName in data) {
        const col = fieldCols.get(fieldName);
        if (col === undefined) continue;
        const plan = col.layout;
        const kind = plan.kind;
        const previous = col.view[row];
        const scalar = kind === 'number' || kind === 'bool' || kind === 'entity';
        changed ||= !scalar;
        const raw = captured?.[fieldName] ?? data[fieldName];
        if (kind === 'number') col.view[row] = raw as number;
        else if (kind === 'bool') col.view[row] = raw ? 1 : 0;
        else if (kind === 'entity') col.view[row] = raw == null ? ENTITY_NULL_RAW : (raw as number);
        else {
          if (plan.releases)
            this.releaseManagedFieldOnRow(arch, component, localId, row, fieldName);
          this.writeManagedField(col, component, row, fieldName, plan, raw);
        }
        // Scalars are owned column values: compare the stored representation,
        // including f32 rounding and integer conversion.
        if (!changed) changed = !sameStoredValue(previous as number, col.view[row] as number);
      }
      if (markChanged && changed) this.markComponentChanged(entity, component);
      return ok(undefined);
    } finally {
      heldAssets.value?.();
    }
  }

  /**
   * Plain numeric, bool and entity components: validate the whole patch, then
   * write columns. No payload key array, buffer probe or asset hold.
   */
  private setScalarFields(
    entity: EntityHandle,
    component: Component,
    definition: ComponentDefinition,
    arch: Archetype,
    row: number,
    data: Record<string, unknown>,
    markChanged: boolean,
  ): Result<void, EcsError> {
    const plans = definition.plan.fields;
    if (definition.plan.hasLabeledEnum) {
      const enumError = validateEnumFieldValues(component, data, entity as number);
      if (enumError !== null) return err(enumError);
    }
    const fieldCols = arch.table.storage.get(definition.id)?.fields;
    if (fieldCols === undefined) {
      throw new Error(`Table storage for ${component.name} does not exist.`);
    }
    let changed = false;
    for (const fieldName in data) {
      const plan = plans[fieldName];
      const col = plan === undefined ? undefined : fieldCols.get(fieldName);
      if (col === undefined) continue;
      const raw = data[fieldName];
      const view = col.view;
      const previous = view[row];
      if (plan?.kind === 'bool') view[row] = raw ? 1 : 0;
      else if (plan?.kind === 'entity')
        view[row] = raw === null || raw === undefined ? ENTITY_NULL_RAW : (raw as number);
      else view[row] = raw as number;
      if (!changed) changed = !sameStoredValue(previous as number, view[row] as number);
    }
    if (markChanged && changed) this.markComponentChanged(entity, component);
    return ok(undefined);
  }

  /**
   * Which patch field's storage owns `buffer`: the field name for an inline
   * column, `null` for a released slot or reference column, or undefined.
   * The last matching field wins, as for one shared backing buffer.
   */
  private overwrittenDestination(
    definition: ReturnType<typeof componentDefinition>,
    fieldCols: Map<string, Column>,
    data: Readonly<Record<string, unknown>>,
    row: number,
    buffer: ArrayBufferLike,
  ): string | null | undefined {
    let destination: string | null | undefined;
    for (const key in data) {
      const col = fieldCols.get(key);
      const field = definition.plan.fields[key];
      if (col === undefined || field === undefined) continue;
      if (col.view.buffer === buffer) {
        const clearsInline =
          (field.kind === 'array' || field.kind === 'fixed-array') && field.reference !== undefined;
        destination = clearsInline ? null : key;
      }
      if (field.kind === 'array') {
        const block = col.view[row * ARRAY_FIELD_ARITY] as number;
        if (block !== 0 && this.arrayStore.buffer(block) === buffer) destination = null;
      }
    }
    return destination;
  }
  // Internal relationship array maintenance. Public array mutation is always
  // expressed as one `world.set` payload; these helpers only implement the
  // engine-owned target projection and backpointer swap-remove path.
  //
  // Append/remove are engine-owned relationship maintenance only.
  //

  /** Reserve a reverse-list cell and optionally append the source, returning its slot. */
  private reserveRelationshipCell(
    target: EntityHandle,
    role: Extract<RelationshipRole, { kind: 'source' }>,
    holder?: EntityHandle,
  ): Result<number, EcsError> {
    const mirror = role.target;
    const record = this.liveSlot(target);
    if (record < 0) {
      return this.staleEntityFailure(
        target,
        holder === undefined ? 'relationship-capacity' : 'relationship-append',
        mirror.name,
      );
    }
    const column = this.fieldColumn(record, mirror, role.targetField);
    if (column?.layout.kind !== 'array')
      return err(new ComponentNotPresentError(target as number, mirror.name));
    const location = column.view as Uint32Array;
    const base = this.tableRow(record) * ARRAY_FIELD_ARITY;
    const count = location[base + 2] as number;
    const elementBytes = Uint32Array.BYTES_PER_ELEMENT;
    const maximum = 262_144 / elementBytes;
    const bytes = (count + 1) * elementBytes;
    if (holder === undefined && count >= maximum)
      return err(new ManagedBufferOutOfBoundsError(count + 1, maximum));
    if (!this.arrayStore.reserve(location, base, count * elementBytes, bytes))
      return err(this.arrayAllocError(bytes));
    if (holder !== undefined) {
      const elements = this.arrayStore.u32(location[base] as number);
      elements[(location[base + 1] as number) / elementBytes + count] = holder;
      location[base + 2] = count + 1;
      this.markComponentChanged(target, mirror);
    }
    return ok(count);
  }

  /** Swap-remove in O(1) using the source backpointer and report the moved source. */
  private removeRelationshipElement(
    target: EntityHandle,
    record: number,
    role: Extract<RelationshipRole, { kind: 'source' }>,
    slot: number,
  ): Result<EntityHandle | undefined, EcsError> {
    const mirror = role.target;
    const column = this.fieldColumn(record, mirror, role.targetField);
    if (column?.layout.kind !== 'array')
      return err(new ComponentNotPresentError(target as number, mirror.name));
    const location = column.view as Uint32Array;
    const base = this.tableRow(record) * ARRAY_FIELD_ARITY;
    const count = location[base + 2] as number;
    if (slot < 0 || slot >= count) return ok(undefined);
    const last = count - 1;
    let moved: EntityHandle | undefined;
    if (slot !== last) {
      const elements = this.arrayStore.u32(location[base] as number);
      const start = (location[base + 1] as number) / Uint32Array.BYTES_PER_ELEMENT;
      moved = elements[start + last] as EntityHandle;
      elements[start + slot] = moved;
    }
    location[base + 2] = last;
    this.markComponentChanged(target, mirror);
    return ok(moved);
  }

  // addComponent / removeComponent (archetype migration via edges, AC-07)

  /** Add a component and its missing requirements, migrating the entity if needed.
   * Stale or duplicate components return structured errors; relationship admission precedes mutation. */
  addComponent<S extends ComponentSchema, C extends Component<string, S>>(
    entity: EntityHandle,
    componentData: ComponentData<S> & { component: C & WritableComponent<C> },
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    return this.addComponentCore(entity, componentData, false);
  }

  /**
   * Core implementation of `addComponent` with reentry guard.
   *
   * @param internal — `true` when called from relationship maintenance
   *   (lazy mirror creation).
   */
  private addComponentCore(
    entity: EntityHandle,
    componentData: ComponentData,
    internal: boolean,
    resolveRequirements = true,
  ): Result<void, EcsError> {
    const rec = this.liveSlot(entity);
    if (rec < 0)
      return this.staleEntityFailure(entity, 'addComponent', componentData.component.name);
    let srcArch = this.graph.archetypes[this.records.archetypeId[rec] as number];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!srcArch) {
      return this.staleEntityFailure(entity, 'addComponent', componentData.component.name);
    }

    const preflight = this.preflightComponentData('addComponent', entity, componentData);
    if (!preflight.ok) return preflight;

    componentData = preflight.value;
    const { component, data } = componentData;
    const filled = data as Record<string, unknown>;
    const localId = componentId(component);
    const relationship = !internal && relationshipRole(component)?.kind === 'source';

    // Reserve a source relationship's target before adding any required
    // components. A capacity failure must not leave a required component on
    // the holder, nor a lazily-created mirror on the target. Existing
    // exclusive sources keep their dedicated reparent path below.
    let relationshipMirrorAdded: boolean | undefined;
    if (relationship && !archetypeHasComponent(srcArch, localId)) {
      const prepared = this.prepareRelationshipInsert(
        component,
        relationshipTarget(component, filled),
      );
      if (!prepared.ok) return prepared;
      relationshipMirrorAdded = prepared.value;
      // Preparing a relationship may materialize the mirror on the same
      // entity (self-targeting relationships are valid when `allowSelf` is
      // enabled). That nested add migrates `rec`, so the source archetype
      // captured above is no longer authoritative. Refresh it before the
      // requested component migration instead of removing a row from the
      // stale, already-empty table.
      srcArch = this.graph.archetypes[this.records.archetypeId[rec] as number];
      if (srcArch === undefined) {
        return this.staleEntityFailure(
          entity,
          'addComponent',
          component.name,
          this.records.generationOf(rec),
        );
      }
    }

    // Generic component requirements are resolved once at the structural
    // boundary. Explicit data remains authoritative; only missing required
    // identities are added before the requested component is migrated.
    const required = resolveRequirements ? implicitComponentInputs(componentData) : undefined;
    if (required !== undefined) {
      for (const requirement of required) {
        if (archetypeHasComponent(srcArch, componentId(requirement.component))) {
          continue;
        }
        // The closure is expanded once above. Bypass requirement expansion for
        // each member so malformed dependency cycles remain finite and the
        // structural work still happens in one deterministic sequence.
        const added = this.addComponentCore(entity, requirement, internal, false);
        if (!added.ok) return added;
        srcArch = this.graph.archetypes[this.records.archetypeId[rec] as number];
        if (!srcArch) {
          return this.staleEntityFailure(
            entity,
            'addComponent',
            component.name,
            this.records.generationOf(rec),
          );
        }
      }
    }

    if (archetypeHasComponent(srcArch, localId)) {
      if (internal || !isExclusiveRelationshipSource(component))
        return err(new ComponentAlreadyPresentError(entity as number, component.name));

      // Reserve first, then preserve the removal and insertion boundaries even
      // for the same target. The admitted input and requirements are already ready.
      const prepared = this.prepareRelationshipInsert(
        component,
        relationshipTarget(component, filled),
      );
      if (!prepared.ok) return prepared;
      const removed = this.removeComponentCore(entity, component, false);
      if (!removed.ok) return removed;
      relationshipMirrorAdded = prepared.value;
      srcArch = this.graph.archetypes[this.records.archetypeId[rec] as number];
      if (srcArch === undefined)
        return this.staleEntityFailure(entity, 'addComponent', component.name);
    }

    // Get target archetype via edge cache.
    const targetArch = getAddEdge(this.graph, srcArch, localId, component);

    if (component.storage === 'sparse') {
      this.moveEntityArchetype(rec, srcArch, targetArch);
    } else {
      this.migrateEntity(rec, srcArch, targetArch);
    }

    if (component.storage === 'table') {
      this.writeRow(targetArch, component, this.tableRow(rec), filled);
    }
    // Relationship sync: append to the materialized target list.
    if (relationship) {
      const relationshipResult = this.relationshipOnInsert(
        entity,
        component,
        relationshipTarget(component, filled),
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
      try {
        this.addedScratch[0] = localId;
        this.internalmarkComponentsAdded(entity, this.addedScratch);
        this.advanceStructureEpoch(entity);
      } catch (cause) {
        this.poisonAfterEntityMutation('World.addComponent', cause);
        throw cause;
      }
    }
    return ok(undefined);
  }

  /** Remove one component and migrate the live entity; release its managed fields.
   * Missing/stale components return structured errors. Entity itself cannot be removed. */
  removeComponent<S extends ComponentSchema, C extends Component<string, S>>(
    entity: EntityHandle,
    component: C & WritableComponent<C>,
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
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
    // Entity carries the row's identity and cannot be removed. Reject before
    // liveness lookup so the rejection does not depend on entity state.
    const protectedComponent = componentRemovalError(component, internal);
    if (protectedComponent !== undefined) return err(protectedComponent);

    const rec = this.liveSlot(entity);
    if (rec < 0) return this.staleEntityFailure(entity, 'removeComponent', component.name);
    const srcArch = this.graph.archetypes[this.records.archetypeId[rec] as number];
    /* istanbul ignore next -- defensive: alive record always has valid archetypeId */
    if (!srcArch) {
      return this.staleEntityFailure(entity, 'removeComponent', component.name);
    }

    // Check if entity has this component (using World-local ID).
    const localId = componentId(component);
    if (!archetypeHasComponent(srcArch, localId)) {
      return err(new ComponentNotPresentError(entity as number, component.name));
    }

    // Capture the old relationship value before column removal so the
    // materialized target list can be pruned.
    const role = relationshipRole(component as Component);
    if (role?.kind === 'source' && !internal) {
      const target = decodeRelationshipTarget(
        this.internalgetFieldValue(entity, component, role.sourceField),
      );
      const relation = this.relationshipOnRemove(entity, component, target);
      if (!relation.ok) {
        this.poisonAfterEntityMutation('World.removeComponent', relation.error);
        return relation;
      }
    }

    // M1 release loop (removeComponent path): release every `unique<T>` field
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
      try {
        this.internalnextMutationEpoch();
        this.advanceStructureEpoch(entity);
        this.notifyComponentRemoved(entity, localId);
      } catch (cause) {
        this.poisonAfterEntityMutation('World.removeComponent', cause);
        throw cause;
      }
    }
    return ok(undefined);
  }
  // Internal — deferred command support (CommandBuffer interface)

  /**
   * Allocate a pending entity for deferred spawn.
   * Returns an Entity handle. The entity is "pending" because
   * archetypeId === -1 (set by allocateIndex); no separate flag needed.
   */
  private allocatePendingEntity(): EntityHandle {
    const indexSlot = this.allocateIndex();
    return encodeEntity(indexSlot, this.records.generation[indexSlot] as number);
  }

  /**
   * Return a deferred-spawn reservation to the free-list without publishing a
   * row or advancing an epoch. CommandBuffer terminal cleanup owns this call; a
   * materialized entity is intentionally left untouched so an unexpected
   * post-write failure poisons the World instead of attempting an unsafe undo.
   */
  private cancelPendingEntity(entity: EntityHandle): void {
    const slot = entityIndex(entity);
    const records = this.records;
    if (records.generationOf(slot) !== entityGeneration(entity)) return;
    if (records.archetypeId[slot] !== -1 || records.archetypeRow[slot] !== -1) return;
    const next = (records.generation[slot] as number) + 1;
    records.generation[slot] = next;
    if (!isRetiredSlot(next)) this.freeIndices.push(slot);
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
    if (slot >= this.records.length || this.records.archetypeId[slot] !== -1) return ok(undefined);

    let storageTouched = false;
    try {
      const arch = this.spawnArchetype(componentDatas);

      // Mark the reservation as mutation-owned before either append can write.
      // If appendTableRow succeeds and appendArchetypeRow fails, command abort
      // must not reclaim an entity whose table storage may already be touched.
      // A poisoned World is the recovery boundary for that partial state.
      this.records.archetypeId[slot] = arch.id;
      storageTouched = true;
      const table = arch.table;
      const tableRow = appendTableRow(table, entity);
      const archetypeRow = appendArchetypeRow(arch, tableRow);
      this.records.archetypeRow[slot] = archetypeRow;
      this.records.tableRow[slot] = tableRow;

      for (const cd of componentDatas) {
        this.writeRow(arch, cd.component, tableRow, cd.data as Record<string, unknown>);
      }

      // The reserved handle is the source of truth for the Entity
      // self column. Relationship maintenance is part of the write boundary;
      // component/epoch publication waits until it has completed.
      this.writeEntitySelf(arch, tableRow, entity);

      // Publish relationship targets after all rows and managed writes are
      // ready. A non-stale error here is a possible partial write. No
      // components-added epoch or structural evidence has been published yet.
      for (const cd of componentDatas) {
        if (relationshipRole(cd.component as Component)?.kind !== 'source') continue;
        const relationshipResult = this.relationshipOnInsert(
          entity,
          cd.component as Component,
          relationshipTarget(cd.component, cd.data as Record<string, unknown>),
        );
        if (!relationshipResult.ok) {
          this.poisonAfterEntityMutation('World.materializeEntity', relationshipResult.error);
          return relationshipResult;
        }
      }
      // The archetype roster is exactly Entity plus the spawned components.
      this.internalmarkComponentsAdded(entity, arch.ids);
      this.advanceStructureEpoch(entity);
      return ok(undefined);
    } catch (error) {
      if (storageTouched) this.poisonAfterEntityMutation('World.materializeEntity', error);
      throw error;
    }
  }

  /**
   * Spawn rosters repeat, so resolve them through an order-independent id
   * signature instead of building and sorting a string key per spawn. Only
   * rosters that exactly match their archetype (distinct, no Entity) are
   * memoized; anything else takes the canonical path.
   */
  private spawnArchetype(componentDatas: readonly ComponentData[]): Archetype {
    let signature = componentDatas.length;
    for (let index = 0; index < componentDatas.length; index++) {
      const id = componentId((componentDatas[index] as ComponentData).component);
      signature = (signature + Math.imul(id + 1, 0x9e3779b1)) | 0;
    }
    const candidates = this.spawnArchetypes.get(signature);
    if (candidates !== undefined) {
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index] as Archetype;
        if (spawnRosterMatches(candidate, componentDatas)) return candidate;
      }
    }
    const arch = getOrCreateArchetype(
      this.graph,
      componentDatas.map((cd) => cd.component),
    );
    if (spawnRosterMatches(arch, componentDatas)) {
      if (candidates === undefined) this.spawnArchetypes.set(signature, [arch]);
      else candidates.push(arch);
    }
    return arch;
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
  // Internal — entity index allocation

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
    return this.records.push();
  }

  private staleEntityFailure(
    entity: EntityHandle,
    operation: string,
    component?: string,
    expectedGeneration?: number,
  ): Result<never, EcsError> {
    const slot = entityIndex(entity),
      gen = entityGeneration(entity);
    return err(
      new StaleEntityError(entity as number, slot, gen, {
        operation,
        ...(component !== undefined ? { component } : {}),
        expectedGeneration: expectedGeneration ?? gen,
        actualGeneration: this.records.generationOf(slot),
      }),
    );
  }

  private lookupAlive(
    entity: EntityHandle,
    operation: string,
    component?: string,
  ): Result<number, EcsError> {
    const slot = this.liveSlot(entity);
    return slot < 0 ? this.staleEntityFailure(entity, operation, component) : ok(slot);
  }

  private fieldColumn(slot: number, component: Component, fieldName: string): Column | undefined {
    const archetype = this.graph.archetypes[this.records.archetypeId[slot] as number];
    return archetype?.table.storage.get(componentId(component))?.fields.get(fieldName);
  }

  /** Read one scalar column without constructing a component snapshot. */
  private internalgetFieldValue(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): number | undefined {
    const slot = this.liveSlot(entity);
    if (slot < 0) return undefined;
    return this.fieldColumn(slot, component, fieldName)?.view[this.tableRow(slot)];
  }

  /** Read an array's live logical length without allocating a TypedArray. */
  private internalgetArrayLength(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): number | undefined {
    const slot = this.liveSlot(entity);
    if (slot < 0) return undefined;
    const column = this.fieldColumn(slot, component, fieldName);
    return column === undefined ? undefined : columnArrayLength(column, this.tableRow(slot));
  }

  /** Read one array element directly from its inline column or ArrayStore cell. */
  private internalgetArrayElement(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
    index: number,
  ): number | undefined {
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    const slot = this.liveSlot(entity);
    if (slot < 0) return undefined;
    const column = this.fieldColumn(slot, component, fieldName);
    return column === undefined
      ? undefined
      : columnArrayElement(this.arrayStore, column, this.tableRow(slot), index);
  }
  // Internal — archetype data read/write

  private readRow<S extends ComponentSchema>(
    arch: Archetype,
    component: Component<string, S>,
    row: number,
  ): ShapeOf<S> {
    const definition = componentDefinition(component);
    const localId = definition.id;
    const fieldCols = arch.table.storage.get(localId)?.fields;
    const out = {} as ShapeOf<S>;
    /* istanbul ignore next -- defensive: component is registered and arch has it */
    if (!fieldCols) {
      return out;
    }
    const fieldNames = definition.fieldNames;
    for (let index = 0; index < fieldNames.length; index++) {
      const fieldName = fieldNames[index] as string;
      const col = fieldCols.get(fieldName);
      if (!col) {
        continue;
      }
      const plan = col.layout;
      const kind = plan.kind;
      const raw = col.view[row];
      if (kind === 'number') {
        (out as Record<string, unknown>)[fieldName] = raw;
      } else if (kind === 'bool') {
        (out as Record<string, unknown>)[fieldName] = raw === 1;
      } else if (kind === 'entity') {
        // Entity field: decode the stored raw u32 verbatim back to Entity
        // (or null when the slot carries the ENTITY_NULL_RAW sentinel). No
        // liveness validation happens here -- a slot referencing a despawned
        // target returns its original raw encoding unchanged; the consumer is
        // responsible for checking liveness (e.g. `world.get(ref, Entity)`).
        (out as Record<string, unknown>)[fieldName] = raw === ENTITY_NULL_RAW ? null : raw;
      } else if (kind === 'string') {
        // Empty or released string handles read as the total string default.
        const resolveR = this.uniqueRefs.resolve<'String'>(toUnique<'String'>(raw as number));
        (out as Record<string, unknown>)[fieldName] = resolveR.ok ? resolveR.value : '';
      } else {
        if (plan.array !== undefined) {
          // Numeric arrays borrow transient storage; protected projections detach below.
          const materialized = borrowColumnArray(this.arrayStore, col, row, plan);
          // Relationship target arrays are a read-only projection. Keep the
          // public component snapshot detached so mutating the returned view
          // cannot bypass the World-owned mirror/index path.
          (out as Record<string, unknown>)[fieldName] =
            isRelationshipTarget(component) || plan.reference === 'asset'
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
   * Write the full packed entity handle into the row's id=0 `Entity`
   * column (`self` field). Called by `spawn` / deferred command materialization
   * after the row is appended (feat-20260602 / plan-strategy D-3). The column
   * always exists -- `createArchetype` folds the Entity column into every
   * archetype -- so this is a direct u32 store, no readRow/writeRow walk.
   */
  private writeEntitySelf(arch: Archetype, row: number, handle: EntityHandle): void {
    arch.table.entities.view[row] = handle as unknown as number;
  }

  /** Caller owns admission and prior release; byte payloads arrive normalized. */
  private writeManagedField(
    col: Column,
    component: Component,
    row: number,
    fieldName: string,
    plan: FieldPlan,
    raw: unknown,
  ): void {
    const kind = plan.kind;
    if (kind === 'string') {
      col.view[row] = unwrapHandle(
        this.uniqueRefs.alloc<'String'>('String', typeof raw === 'string' ? raw : ''),
      );
    } else if (plan.array !== undefined) {
      this.writeArrayField(col, component, row, fieldName, plan, raw);
    } else {
      col.view[row] = raw as number;
      if (plan.reference === 'asset' && raw != null && raw !== 0)
        this.assets?.retain(raw as number, plan.target).unwrap();
      if (plan.reference === 'shared' && raw !== 0)
        this.retainSharedScalarHandle(raw as number, component.name, fieldName);
    }
  }

  /** Write initialized values from structural admission into a fresh row. */
  private writeRow(
    arch: Archetype,
    component: Component,
    row: number,
    value: Readonly<Record<string, unknown>>,
  ): void {
    const definition = componentDefinition(component);
    const localId = definition.id;
    const fieldCols = arch.table.storage.get(localId)?.fields;
    /* istanbul ignore next -- defensive: component is registered and arch has it */
    if (!fieldCols) {
      return;
    }
    const fieldNames = definition.fieldNames;
    for (let index = 0; index < fieldNames.length; index++) {
      const fieldName = fieldNames[index] as string;
      const col = fieldCols.get(fieldName);
      /* istanbul ignore next -- defensive: schema fields always have columns */
      if (!col) {
        continue;
      }
      const plan = col.layout;
      const kind = plan.kind;
      const raw = value[fieldName];
      if (kind === 'number') {
        col.view[row] = raw as number;
      } else if (kind === 'bool') {
        col.view[row] = raw ? 1 : 0;
      } else if (kind === 'entity') {
        // M3 entity field: encode (slot, gen) into u32 column. `null`
        // / undefined map to ENTITY_NULL_RAW sentinel.
        col.view[row] = raw === null || raw === undefined ? ENTITY_NULL_RAW : (raw as number);
      } else {
        this.writeManagedField(col, component, row, fieldName, plan, raw);
      }
    }
  }
  // Internal — managed-ref + managed-buffer release loop (M1 / M2)

  /** Release all ECS-owned field handles before a row is removed or overwritten. */
  private releaseManagedRefsOnRow(arch: Archetype, component: Component, row: number): void {
    const { id, plan } = componentDefinition(component);
    const releaseFields = plan.releaseFields;
    for (let index = 0; index < releaseFields.length; index++)
      this.releaseManagedFieldOnRow(arch, component, id, row, releaseFields[index] as string);
  }

  /**
   * Release one ECS-owned field according to its schema. Inline buffers have
   * no pool slot; shared-array elements still release their handles. Store
   * failures use the host error channel so row cleanup remains total.
   */
  private releaseManagedFieldOnRow(
    arch: Archetype,
    component: Component,
    localId: ComponentId,
    row: number,
    fieldName: string,
  ): void {
    const col = arch.table.storage.get(localId)?.fields.get(fieldName);
    if (col === undefined) return;
    const plan = col.layout;
    const kind = plan.kind;
    const raw = col.view[row] as number;
    if (kind === 'asset') {
      releaseAssetReference(this.assets, raw);
      return;
    }
    if (kind === 'shared') {
      this.releaseSharedRefHandle(raw, component.name, fieldName);
      return;
    }
    if (kind === 'unique' || kind === 'string') {
      this.releaseManagedRefHandle(raw, component.name, fieldName);
      return;
    }
    if (plan.array !== undefined) {
      if (plan.reference === 'shared' || plan.reference === 'asset') {
        const count = plan.array.length ?? (col.view[row * ARRAY_FIELD_ARITY + 2] as number);
        if (count > 0) {
          // Release handles while their inline row or variable cell is still live.
          const elements = borrowColumnArray(this.arrayStore, col, row, plan);
          if (plan.reference === 'asset') this.releaseAssetArrayElements(elements);
          else this.releaseSharedArrayElements(elements);
          if (plan.array.length !== undefined) elements.fill(0);
        }
      }
      if (plan.array.length === undefined) this.releaseArray(col, row);
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

  /** Release one shared-ref handle; only the empty sentinel is ignored. */
  private releaseSharedRefHandle(
    handleU32: number,
    componentName: string,
    fieldName: string,
  ): void {
    if (handleU32 === 0) return;
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
    if (handleU32 === 0) return;
    const r = this.sharedRefs.retain(toShared<string>(handleU32));
    if (r.ok) return;
    const ctx: ErrorContext = {
      systemName: `World.write (${componentName}.${fieldName} shared scalar retain)`,
    };
    this.routeError(r.error, ctx);
  }

  /** Release a variable array / buffer cell and reset its location to empty. */
  private releaseArray(col: Column, row: number): void {
    const location = col.view as Uint32Array;
    const base = row * ARRAY_FIELD_ARITY;
    this.arrayStore.release(location[base] as number, location[base + 1] as number);
    location[base] = 0;
    location[base + 1] = 0;
    location[base + 2] = 0;
  }

  private arrayAllocError(byteLength: number): ManagedBufferOutOfBoundsError {
    return new ManagedBufferOutOfBoundsError(byteLength, this.arrayStore.committedBytes);
  }
  // Internal — array<T> / array<T,N> spawn / set helpers (M1 / w7)

  /**
   * Write an array field for spawn or set. Fixed arrays stay inline; variable
   * arrays store one ArrayStore cell whose location and count sit on the column.
   */
  private writeArrayField(
    col: Column,
    component: Component,
    row: number,
    fieldName: string,
    plan: ArrayFieldPlan,
    raw: unknown,
  ): void {
    const arrayMeta = plan.array;
    const meta = plan.element;
    const metaKey = plan.reference;
    const elementBytes = meta.byteSize;

    const isVariable = arrayMeta.length === undefined;

    // Same-typed inline storage can copy elements without packing temporary bytes.
    // TypedArray.set preserves overlapping source views.
    if (
      !isVariable &&
      metaKey !== 'shared' &&
      metaKey !== 'asset' &&
      col.view instanceof meta.viewCtor &&
      (raw == null || Array.isArray(raw) || raw instanceof meta.viewCtor)
    ) {
      const start = row * col.layout.arity;
      const count = raw == null ? 0 : Math.min(raw.length, col.layout.arity);
      if (Array.isArray(raw)) {
        for (let i = 0; i < count; i++)
          col.view[start + i] = typeof raw[i] === 'number' ? raw[i] : 0;
      } else if (raw != null) {
        col.view.set(raw.length <= col.layout.arity ? raw : raw.subarray(0, count), start);
      }
      col.view.fill(0, start + count, start + col.layout.arity);
      return;
    }

    // Pack plain arrays before touching storage: their element access may throw.
    // Typed inputs already carry the declared codec and retain their native window.
    let payload: FieldView | Uint8ClampedArray | undefined;
    let payloadCount = 0;
    if (isNumericArray(raw)) {
      payload = raw;
      payloadCount = raw.length;
    } else if (Array.isArray(raw)) {
      payloadCount = raw.length;
      if (payloadCount > 0) {
        const typed = new meta.viewCtor(payloadCount);
        for (let i = 0; i < payloadCount; i++) {
          const value = raw[i];
          typed[i] = typeof value === 'number' ? value : 0;
        }
        payload = typed;
      }
    }

    const count = arrayMeta.length ?? payloadCount;
    const copyCount = Math.min(payloadCount, count);
    let destination = col.view;
    let start = row * col.layout.arity;
    if (isVariable) {
      const location = col.view as Uint32Array;
      const base = row * ARRAY_FIELD_ARITY;
      const byteLength = count * elementBytes;
      if (!this.arrayStore.alloc(location, base, byteLength)) {
        location.fill(0, base, base + ARRAY_FIELD_ARITY);
        this.routeError(this.arrayAllocError(byteLength), {
          systemName: `World.write (${component.name}.${fieldName})`,
        });
        return;
      }
      if (count === 0) {
        location[base + 2] = 0;
        return;
      }
      destination = this.arrayStore.view(location[base] as number, meta.viewCtor);
      start = (location[base + 1] as number) / elementBytes;
    }

    // Same-element native copies preserve bits and overlapping source windows.
    if (payload !== undefined && copyCount > 0) {
      // Prefix construction must not invoke input subarray/species overrides.
      const prefix =
        payloadCount <= count
          ? payload
          : new meta.viewCtor(payload.buffer, payload.byteOffset, copyCount);
      destination.set(prefix, start);
    }
    if (isVariable) col.view[row * ARRAY_FIELD_ARITY + 2] = count;
    else destination.fill(0, start + copyCount, start + count);

    if ((metaKey === 'asset' || metaKey === 'shared') && copyCount > 0) {
      const elements = destination.subarray(start, start + copyCount);
      if (metaKey === 'asset') this.retainAssetArrayElements(elements);
      else this.retainSharedArrayElements(elements);
    }
  }

  private retainAssetArrayElements(elements: FieldView): void {
    for (const handle of elements) if (handle !== 0) this.assets?.retain(handle).unwrap();
  }

  private releaseAssetArrayElements(elements: FieldView): void {
    for (const handle of elements) releaseAssetReference(this.assets, handle);
  }

  private retainSharedArrayElements(elements: FieldView): void {
    for (let i = 0; i < elements.length; i++) {
      const raw = elements[i];
      if (raw !== undefined) this.retainSharedScalarHandle(raw, 'array<shared<T>>', 'element');
    }
  }

  private releaseSharedArrayElements(elements: FieldView): void {
    for (let i = 0; i < elements.length; i++) {
      const raw = elements[i];
      if (raw !== undefined) this.releaseSharedRefHandle(raw, 'array<shared<T>>', 'element');
    }
  }

  // Internal — archetype migration

  // Storage swaps report the moved row; World repairs the corresponding entity
  // or archetype index for every migration, sparse-tag transition and despawn.
  private removeArchetypeMembership(archetype: Archetype, row: number): void {
    const srcTable = archetype.table;
    const archetypeSwap = removeArchetypeRow(archetype, row);
    if (archetypeSwap !== null) {
      const movedEntity = (srcTable.entities.view[archetypeSwap.movedTableRow] ??
        0) as EntityHandle;
      const moved = entityIndex(movedEntity);
      if (this.records.generationOf(moved) === entityGeneration(movedEntity)) {
        this.records.archetypeRow[moved] = archetypeSwap.newRow;
      }
    }
  }

  private removeTableMembership(table: Table, row: number): void {
    const tableSwap = removeTableRow(table, row);
    if (tableSwap !== null) {
      const moved = entityIndex(tableSwap.movedEntity);
      const records = this.records;
      if (records.generationOf(moved) === entityGeneration(tableSwap.movedEntity)) {
        records.tableRow[moved] = tableSwap.newRow;
        const movedArchetype = this.graph.archetypes[records.archetypeId[moved] as number];
        if (movedArchetype !== undefined) {
          movedArchetype.rows[records.archetypeRow[moved] as number] = tableSwap.newRow;
        }
      }
    }
  }

  /**
   * Copy surviving component columns into the target row, then swap-remove
   * the source row. Managed handles and variable-array locations are copied
   * verbatim; release remains the responsibility of remove/despawn paths.
   */
  private migrateEntity(slot: number, srcArch: Archetype, targetArch: Archetype): void {
    const oldArchetypeRow = this.records.archetypeRow[slot] as number;
    const oldTableRow = srcArch.rows[oldArchetypeRow] ?? 0;
    const srcTable = srcArch.table;
    const targetTable = targetArch.table;
    const entity = (srcTable.entities.view[oldTableRow] ?? 0) as EntityHandle;
    const newTableRow = appendTableRow(targetTable, entity);
    const newArchetypeRow = appendArchetypeRow(targetArch, newTableRow);

    // Copy shared component data: the whole stride window per row, including
    // managed handles and variable-array locations.
    for (const [compId, srcComponentStorage] of srcTable.storage) {
      const targetComponentStorage = targetTable.storage.get(compId);
      if (targetComponentStorage === undefined) continue; // Component was removed.
      const targetFieldCols = targetComponentStorage.fields;
      for (const [fieldName, srcCol] of srcComponentStorage.fields) {
        const targetCol = targetFieldCols.get(fieldName);
        if (targetCol !== undefined) copyColumnRow(srcCol, oldTableRow, targetCol, newTableRow);
      }
      targetComponentStorage.added[newTableRow] = srcComponentStorage.added[oldTableRow] ?? 0;
      stampChange(
        targetComponentStorage.changed,
        newTableRow,
        srcComponentStorage.changed.epochs[oldTableRow] ?? 0,
      );
    }

    this.removeArchetypeMembership(srcArch, oldArchetypeRow);
    this.removeTableMembership(srcTable, oldTableRow);

    this.records.archetypeId[slot] = targetArch.id;
    this.records.archetypeRow[slot] = newArchetypeRow;
    this.records.tableRow[slot] = newTableRow;
  }

  private moveEntityArchetype(slot: number, srcArch: Archetype, targetArch: Archetype): void {
    if (srcArch.table !== targetArch.table) {
      throw new Error('Logical archetype move requires a shared Table.');
    }
    const oldArchetypeRow = this.records.archetypeRow[slot] as number;
    const tableRow = srcArch.rows[oldArchetypeRow] ?? 0;
    this.removeArchetypeMembership(srcArch, oldArchetypeRow);
    this.records.archetypeId[slot] = targetArch.id;
    this.records.archetypeRow[slot] = appendArchetypeRow(targetArch, tableRow);
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
    const records = this.records;
    if (!records.isLive(slot, generation)) return ok(undefined);
    this.arrayRangeLog.forget(entity as number);

    const archetype = this.graph.archetypes[records.archetypeId[slot] as number];
    const linkedChildren =
      archetype === undefined
        ? NO_LINKED_CHILDREN
        : this.relationshipLinkedSpawnChildren(entity, archetype);
    let mutationStarted = false;
    try {
      if (archetype !== undefined) {
        const table = archetype.table;
        const archetypeRow = records.archetypeRow[slot] as number;
        const tableRow = archetype.rows[archetypeRow] ?? 0;
        mutationStarted = true;
        for (const component of archetype.components) {
          const role = relationshipRole(component);
          if (role?.kind === 'source' && !internal) {
            const target = decodeRelationshipTarget(
              this.internalgetFieldValue(entity, component, role.sourceField),
            );
            const relation = this.relationshipOnRemove(entity, component, target);
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
        this.removeArchetypeMembership(archetype, archetypeRow);
        this.removeTableMembership(table, tableRow);
      }
      // Publish only an accepted mutation, before this slot can be reused or
      // recursive child retirement advances the World's epoch again.
      this.internalnextMutationEpoch();
      this.advanceStructureEpoch(entity);
      for (const component of archetype?.components ?? [])
        this.notifyComponentRemoved(entity, componentId(component));
      records.archetypeId[slot] = -1;
      records.archetypeRow[slot] = -1;
      records.tableRow[slot] = -1;
      const next = (records.generation[slot] as number) + 1;
      records.generation[slot] = next;
      if (!isRetiredSlot(next)) this.freeIndices.push(slot);
      for (const child of linkedChildren) {
        const childResult = this.despawnEntity(child, true);
        if (!childResult.ok) return childResult;
      }
      return ok(undefined);
    } catch (error) {
      if (mutationStarted) this.poisonAfterEntityMutation('World.despawn', error);
      throw error;
    }
  }
  // Spawn

  /** Spawn one entity with explicit components and missing requirements.
   * Validate payloads before allocating rows; write the full entity handle after materialization. */
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
    componentDatas = expandComponentRequirements(componentDatas);
    for (let index = 0; index < componentDatas.length; index++) {
      const data = componentDatas[index] as ComponentData;
      const preflight = this.preflightComponentData('spawn', null, data);
      if (!preflight.ok) return preflight;
      componentDatas[index] = preflight.value;
    }
    const entity = this.allocatePendingEntity();
    const materialized = this.materializeEntity(entity, componentDatas);
    return materialized.ok ? ok(entity) : materialized;
  }
  // Despawn (D-08: generation retirement)

  /** Despawn a live entity and release owned fields. Stale handles are harmless.
   * Linked relationship children are removed as part of the same lifecycle operation. */
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
      if ((this.records.archetypeId[index] as number) >= 0) {
        entities.push(encodeEntity(index, this.records.generation[index] as number));
      }
    }
    for (const entity of entities) {
      const result = this.despawn(entity);
      if (!result.ok) return result;
    }
    return ok(undefined);
  }
  // Hierarchy operations share World identity and relationship mutation rules.
  // World owns the component storage and relationship mutation primitives.

  /**
   * Attach `child` under `parent` through a source relationship component such
   * as `ChildOf`. The relationship field (`ChildOf.parent`) is written from
   * `parent`, so `world.addChild(root, child, ChildOf, {})` is a complete call;
   * `data` supplies only the component's other fields. Re-adding to a new
   * parent reparents an exclusive relationship.
   *
   * @returns `err(RelationshipSelfCycleError)` when the edge would form a cycle.
   */
  addChild<S extends ComponentSchema>(
    parent: EntityHandle,
    child: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    return this.connectChild('addChild', parent, child, component, data);
  }

  removeChild<S extends ComponentSchema>(
    parent: EntityHandle,
    child: EntityHandle,
    component: Component<string, S>,
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    const childResult = this.lookupAlive(child, 'removeChild', component.name);
    if (!childResult.ok) return childResult;

    const role = relationshipRole(component);
    if (role === undefined) componentId(component);
    const currentTarget =
      role?.kind === 'source'
        ? decodeRelationshipTarget(this.internalgetFieldValue(child, component, role.sourceField))
        : null;
    if (currentTarget !== parent || (parent === null && !this.hasComponent(child, component))) {
      return err(
        createRelationshipDetachMismatchError(
          component.name,
          child as number,
          parent as number,
          currentTarget ?? 0,
        ),
      );
    }

    return this.removeComponent(child, component);
  }

  reparent<S extends ComponentSchema>(
    child: EntityHandle,
    newParent: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    return this.connectChild('reparent', newParent, child, component, data);
  }

  private connectChild<S extends ComponentSchema>(
    operation: 'addChild' | 'reparent',
    parent: EntityHandle,
    child: EntityHandle,
    component: Component<string, S>,
    data: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    const poisoned = worldPoisonedError(this.executionState);
    if (poisoned !== undefined) return err(poisoned);
    const role = relationshipRole(component);
    if (role?.kind !== 'source')
      return err(new ComponentNotPresentError(child as number, component.name));
    if (operation === 'addChild') {
      const parentResult = this.lookupAlive(parent, operation, component.name);
      if (!parentResult.ok) return parentResult;
      const childResult = this.lookupAlive(child, operation, component.name);
      if (!childResult.ok) return childResult;
    }
    const cycle = this.relationshipCycleError(component, role, parent, child);
    if (cycle !== null) return err(cycle);
    let retained = false;
    if (operation === 'reparent') {
      const slot = this.lookupAlive(child, operation, component.name);
      if (!slot.ok) return slot;
      const archetype = this.graph.archetypes[this.records.archetypeId[slot.value] as number];
      if (archetype === undefined) return this.staleEntityFailure(child, operation, component.name);
      // Updating an existing edge leaves its component membership and query spans intact.
      retained = archetypeHasComponent(archetype, componentId(component));
    }
    const payload = { ...data, [role.sourceField]: parent } as Partial<InputShapeOf<S>>;
    return retained
      ? this.set(child, component as never, payload as never)
      : this.addComponent(child, { component, data: payload });
  }

  iterAncestors(entity: EntityHandle): Iterable<EntityHandle> {
    const world = this;
    return {
      *[Symbol.iterator]() {
        const visited = new Set<EntityHandle>();
        let current = entity;
        while (!visited.has(current)) {
          const arch = world.internalgetEntityArchetype(current);
          if (arch === undefined) return;
          visited.add(current);
          let parent: EntityHandle | null = null;
          for (const component of arch.components) {
            const role = relationshipRole(component);
            if (role?.kind !== 'source') continue;
            parent = decodeRelationshipTarget(
              world.internalgetFieldValue(current, component, role.sourceField),
            );
            if (parent !== null) break;
          }
          if (parent === null) return;
          yield parent;
          current = parent;
        }
      },
    };
  }

  iterDescendants(entity: EntityHandle): Iterable<EntityHandle> {
    const world = this;
    return {
      *[Symbol.iterator]() {
        const records = world.records;
        const slot = entityIndex(entity);
        const generation = entityGeneration(entity);
        if (!records.isLive(slot, generation)) return;

        const visited = new Set<number>();
        const stack: number[] = [slot];
        while (stack.length > 0) {
          const currentSlot = stack.pop();
          if (currentSlot === undefined) break;
          if (currentSlot >= records.length || records.archetypeId[currentSlot] === -1) continue;
          const currentArch =
            world.graph.archetypes[world.records.archetypeId[currentSlot] as number];
          if (!currentArch) continue;

          for (const child of world.descendantChildren(currentArch, world.tableRow(currentSlot))) {
            const childSlot = entityIndex(child);
            const childGeneration = entityGeneration(child);
            const key = pack(childSlot, childGeneration);
            if (visited.has(key) || !records.isLive(childSlot, childGeneration)) {
              continue;
            }
            visited.add(key);
            yield child;
            stack.push(childSlot);
          }
        }
      },
    };
  }
  private descendantChildren(arch: Archetype, row: number): EntityHandle[] {
    const children: EntityHandle[] = [];
    for (const component of arch.components) {
      const definition = componentDefinition(component);
      if (!definition.plan.hasArrayField) continue;
      const columns = arch.table.storage.get(definition.id)?.fields;
      if (columns === undefined) continue;
      for (const name of definition.fieldNames) {
        const plan = definition.plan.fields[name];
        if (plan?.kind !== 'array' || plan.array.elementType !== 'entity') continue;
        const column = columns.get(name);
        if (column === undefined) continue;
        const list = borrowColumnArray(this.arrayStore, column, row, plan);
        for (const raw of list) children.push(raw as EntityHandle);
      }
    }
    return children;
  }
  private copyArrayTo(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
    target: Parameters<WorldRead['copyArray']>[3],
  ): number | undefined {
    const slot = this.liveSlot(entity);
    if (slot < 0) return undefined;
    const column = this.fieldColumn(slot, component, fieldName);
    return column === undefined
      ? undefined
      : copyColumnArray(this.arrayStore, column, this.tableRow(slot), target);
  }
}
