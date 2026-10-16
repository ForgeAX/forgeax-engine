/**
 * ECS package-internal World seam.
 *
 * This module is intentionally not re-exported by the package entry points.
 * It keeps implementation access out of World's discoverable API while
 * retaining direct bound calls for the hot query and structural paths.
 */
// Bundled ECS entry points (`index` and `projection`) each include this module
// in their own closure. A plain Symbol() therefore gives World and projection
// different property keys at runtime even though their source imports agree.
// The registry is package-private by convention: no root/advanced export
// exposes this key, while Symbol.for keeps source/dist and split bundles on
// one identity.
import type { Result } from '@forgeax/engine-types';
import type { BufferPool } from './buffer-pool';
import type { Component, ComponentSchema, ShapeOf } from './component';
import type { EntityHandle } from './entity-handle';
import type { WorldExecutionFault } from './execution/shared-kernel';
import type { ResourceStore } from './resource';
import type { Schedule } from './schedule';
import type { ScheduleToken } from './schedule-token';
import type { SharedRefStore } from './shared-ref-store';
import type { Archetype } from './storage/archetype';
import type { ArchetypeGraph } from './storage/archetype-graph';
import type { ArrayRangesChange } from './storage/array-range-log';
import type { ChangeTicks } from './storage/change-detection';
import type { Table } from './storage/table';
import type { ClockWriter } from './time';
import type { ComponentData, EcsError, EntityRecord } from './world';

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
  readonly getBufferPool: () => BufferPool;
  readonly getClockWriter: () => ClockWriter;
  readonly getComponentChange: (
    entity: EntityHandle,
    componentId: number,
  ) => ChangeTicks | undefined;
  readonly getComponentMutationEpochs: () => readonly number[];
  readonly getEntityArchetype: (entity: EntityHandle) => Archetype | undefined;
  readonly getFixedAccumulator: () => number;
  readonly getGraph: () => ArchetypeGraph;
  readonly getMutationEpoch: () => number;
  readonly getQueryRow: (
    entity: EntityHandle,
    component: Component,
  ) => Result<Record<string, unknown>, EcsError>;
  readonly getRecords: () => EntityRecord[];
  readonly getRelationshipEpoch: (component: Component) => number;
  readonly getRelationshipTargetEntities: (
    component: Component,
    target: EntityHandle,
  ) => readonly EntityHandle[];
  readonly getResources: () => ResourceStore;
  readonly getSchedule: (token: ScheduleToken) => Schedule | undefined;
  readonly getSchedules: () => ReadonlyMap<ScheduleToken, Schedule>;
  readonly getSharedRefs: () => SharedRefStore;
  readonly getStructureEpoch: () => number;
  readonly lookupAlive: (
    entity: EntityHandle,
    operation: string,
    component?: string,
  ) => Result<EntityRecord, EcsError>;
  readonly markComponentChanged: (entity: EntityHandle, componentId: number) => void;
  readonly markComponentRangeChanged: (
    table: Table,
    componentId: number,
    rowStart: number,
    rowCount: number,
  ) => void;
  readonly materializeEntity: (
    entity: EntityHandle,
    componentDatas: ComponentData[],
  ) => Result<void, EcsError>;
  readonly materializePendingEntity: (
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
    holder: EntityHandle | null,
    componentData: ComponentData,
    pendingEntities?: ReadonlySet<number>,
    unavailableEntities?: ReadonlySet<number>,
  ) => Result<void, EcsError>;
  readonly readRow: <S extends ComponentSchema>(
    archetype: Archetype,
    component: Component<string, S>,
    row: number,
  ) => ShapeOf<S>;
  readonly recordIsLive: (
    record: EntityRecord | undefined,
    generation: number,
  ) => record is EntityRecord;
  readonly routeError: (error: unknown, context?: { readonly systemName: string }) => void;
  readonly restoreMutationEpoch: (epoch: number) => void;
  readonly setFixedAccumulator: (value: number) => void;
  readonly setQueryRow: (
    entity: EntityHandle,
    component: Component,
    value: Record<string, unknown>,
  ) => Result<void, EcsError>;
}
