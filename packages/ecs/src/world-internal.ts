/**
 * ECS package-internal World seam.
 *
 * This module is intentionally not re-exported by the package entry points.
 * It keeps implementation access out of World's discoverable API while
 * retaining stable owner references and bound mutation calls.
 */
// Bundled ECS entry points (`index` and `projection`) each include this module
// in their own closure. A plain Symbol() therefore gives World and projection
// different property keys at runtime even though their source imports agree.
// The registry is package-private by convention: no root/advanced export
// exposes this key, while Symbol.for keeps source/dist and split bundles on
// one identity.
import type { Handle, Result } from '@forgeax/engine-types';
import type { Component, ComponentData, ComponentSchema, ShapeOf } from './component';
import type { EntityHandle } from './entity-handle';
import type { EcsError, RelationshipSelfCycleError } from './errors';
import type { WorldExecutionFault } from './execution/shared-kernel';
import type { RelationshipOverlay, RelationshipRole } from './relationship-index';
import type { Schedule } from './schedule';
import type { ScheduleToken } from './schedule-token';
import type { Archetype } from './storage/archetype';
import type { ArchetypeGraph } from './storage/archetype-graph';
import type { ArrayRangesChange } from './storage/array-range-log';
import type { ArrayStore } from './storage/array-store';
import type { ChangeTicks } from './storage/change-detection';
import type { ChangeIndex } from './storage/change-index';
import type { EntityRecords } from './storage/entity-records';
import type { Table } from './storage/table';
import type { ClockWriter } from './time';

/** @internal Package-private identity; absent from the public export map. */
export const worldInternal: unique symbol = Symbol.for(
  'forgeax.ecs.worldInternal',
) as unknown as typeof worldInternal;

/**
 * The one package-internal capability surface owned by World.
 *
 * Every member is explicit so an extraction cannot silently widen the seam or
 * leak an untyped state bag. The symbol itself remains package-private and is
 * the only route used by query, commands, and lifecycle helpers.
 */
/** @internal Raw ECS owner seam; source-relative consumers only. */
export interface WorldInternal {
  readonly releaseUnadoptedUniqueRef: (handle: Handle<string, 'unique'>) => Result<void, EcsError>;
  readonly beginDerivedWrite: () => boolean;
  readonly endDerivedWrite: () => void;
  readonly isDerivedWriteActive: () => boolean;
  readonly allocatePendingEntity: () => EntityHandle;
  readonly cancelPendingEntity: (entity: EntityHandle) => void;
  readonly getArrayRangesChangedSince: (
    entity: EntityHandle,
    component: Component,
    fieldName: string,
    since: number,
  ) => ArrayRangesChange;
  readonly getArrayView: (
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ) => ArrayLike<number> | undefined;
  readonly arrayStore: ArrayStore;
  readonly openScheduleArena: () => boolean;
  readonly closeScheduleArena: () => void;
  readonly resumeFixedStep: () => void;
  /** Rotate removed-component event buffers; called once per `World.update()`. */
  readonly updateRemovedComponents: () => void;
  readonly clockWriter: ClockWriter;
  readonly getComponentChange: (
    entity: EntityHandle,
    componentId: number,
  ) => ChangeTicks | undefined;
  /** Visit slots whose component was written in `(since, upper]`; returns rows examined. */
  readonly visitComponentChanged: (
    componentId: number,
    since: number,
    upper: number,
    visit: (slot: number) => void,
  ) => number;
  readonly structuralChangeIndex: ChangeIndex;
  readonly componentMutationEpochs: readonly number[];
  readonly getEntityArchetype: (entity: EntityHandle) => Archetype | undefined;
  readonly getFixedAccumulator: () => number;
  readonly graph: ArchetypeGraph;
  readonly setDisabledBatch: (
    entities: ReadonlySet<EntityHandle>,
    disabled: boolean,
  ) => Result<void, EcsError>;
  readonly getMutationEpoch: () => number;
  readonly getQueryRow: (
    entity: EntityHandle,
    component: Component,
  ) => Result<Record<string, unknown>, EcsError>;
  readonly records: EntityRecords;
  readonly getSchedule: (token: ScheduleToken) => Schedule | undefined;
  readonly schedules: ReadonlyMap<ScheduleToken, Schedule>;
  readonly getStructureEpoch: () => number;
  readonly lookupAlive: (
    entity: EntityHandle,
    operation: string,
    component?: string,
  ) => Result<number, EcsError>;
  readonly markComponentChanged: (entity: EntityHandle, componentId: number) => boolean;
  /**
   * Index a change the caller already wrote to the entity's `changed` column,
   * at an epoch it reserved with `nextMutationEpoch`.
   */
  readonly publishLocatedChange: (slot: number, componentId: number, epoch: number) => void;
  readonly markComponentRangeChanged: (
    table: Table,
    componentId: number,
    rowStart: number,
    rowCount: number,
  ) => void;
  /** Materialize a reserved slot from the payloads returned by preflight. */
  readonly materializeEntity: (
    entity: EntityHandle,
    componentDatas: ComponentData[],
  ) => Result<void, EcsError>;
  readonly nextMutationEpoch: () => number;
  readonly poisonExecution: (fault: WorldExecutionFault) => void;
  readonly publishDerivedRange: (
    table: Table,
    componentId: number,
    rowStart: number,
    rowCount: number,
    epoch: number,
  ) => void;
  readonly preflightComponentData: (
    operation: 'spawn' | 'addComponent' | 'command',
    holder: EntityHandle | null,
    componentData: ComponentData,
    pendingEntities?: ReadonlySet<number>,
    unavailableEntities?: ReadonlySet<number>,
    relationshipOverlay?: RelationshipOverlay,
  ) => Result<Readonly<ComponentData>, EcsError>;
  readonly relationshipCycleError: (
    component: Component,
    role: Extract<RelationshipRole, { kind: 'source' }>,
    start: EntityHandle | null,
    holder: EntityHandle,
    overlay?: RelationshipOverlay,
  ) => RelationshipSelfCycleError | null;
  readonly readRow: <S extends ComponentSchema>(
    archetype: Archetype,
    component: Component<string, S>,
    row: number,
  ) => ShapeOf<S>;
  readonly routeError: (error: unknown, context?: { readonly systemName: string }) => void;
  readonly restoreMutationEpoch: (epoch: number) => void;
  readonly setFixedAccumulator: (value: number) => void;
  readonly setQueryRow: (
    entity: EntityHandle,
    component: Component,
    value: Record<string, unknown>,
  ) => Result<void, EcsError>;
}
