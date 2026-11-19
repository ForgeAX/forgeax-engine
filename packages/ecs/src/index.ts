/**
 * Archetype ECS entry: define components, create a World, and register typed systems.
 * World mutations return Result; handle failures or propagate them from systems.
 * Error codes and structured details support recovery; a poisoned World requires replacement.
 * Field values, ownership, and borrowed-view lifetimes are documented by their declaring APIs.
 */
import { componentId } from './component';
import { Disabled, Entity } from './entity';

if (componentId(Entity) !== 0) {
  throw new Error(
    'forgeax-engine-ecs: Entity invariant violated ' +
      `(expected id=0, got ${componentId(Entity)}). ` +
      'Ensure every ECS entry uses a compatible component identity registry.',
  );
}

export type { CommandBuffer } from './commands';
export type {
  Component,
  ComponentSchema,
  FieldReflection,
  InputShapeOf,
  SchemaOf,
  ShapeOf,
} from './component';
export { componentDefinition, defineComponent } from './component';
export type { EntityHandle } from './entity-handle';
export { ENTITY_MAX_GENERATION, ENTITY_MAX_INDEX, ENTITY_NULL_RAW } from './entity-handle';
export type { EcsErrorCode } from './errors';
export {
  ArrayRangeOutOfBoundsError,
  ChangeEpochExhaustedError,
  QueryBatchUnavailableError,
  type QueryBatchUnavailableReason,
  SharedRefStaleError,
  TimeScaleInvalidError,
  TimeScaleLeaseReleasedError,
  UniqueRefStaleError,
} from './errors';
export { SHARED_KERNEL_EXECUTOR_RESOURCE_KEY } from './execution/shared-kernel';
export type { FrameArena, FrameArenaStats } from './frame-arena';
export type {
  MemoryArray,
  MemoryArrayConstructor,
  MemoryBudget,
  MemoryErrorCode,
  MemoryErrorDetail,
  WorldMemoryOptions,
  WorldMemoryStats,
} from './memory-types';
export { MemoryError } from './memory-types';
export type { BufferHandle, BufferLease, OwnedBuffers } from './owned-buffers';
export { createWorldContext, worldPlugin } from './plugin-service';
export type { NumericField, QueryBatch, QueryBatchColumns, ReadonlyColumn } from './query/batch';
export type {
  Query,
  QueryCreationError,
  QueryDescriptor,
  QueryRow,
  QuerySpan,
} from './query/query';
export { defineRelationship, type RelationshipTargetComponent } from './relationship-index';
export { defineResource, type Resource } from './resource';
export type {
  System,
  SystemDescriptor,
  SystemOrderReference,
  SystemSet,
  SystemToken,
} from './schedule';
export { defineSystem, defineSystemSet } from './schedule';
export type { ScheduleRunObserver, ScheduleWorkScope } from './schedule-observation.js';
export {
  beginScheduleWork,
  hasScheduleRunObservers,
  registerScheduleWork,
  runScheduleWork,
  scheduleWorkNames,
} from './schedule-observation.js';
export { defineSchedule, FixedUpdate, type ScheduleToken, Update } from './schedule-token';
export {
  FixedTime,
  type FixedTimeResource,
  Time,
  type TimePolicy,
  type TimeResource,
  type TimeScaleLease,
  type WorldOptions,
} from './time';
export type { EcsError } from './world';
export { type ComponentData, World } from './world.js';
export { deferFixedStep, fixedStepIsDeferred } from './world-scheduling';
export { Disabled, Entity };
