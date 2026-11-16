/**
 * @module @forgeax/engine-ecs
 *
 * Archetype ECS with Result-based mutation errors and poisoned-frame recovery:
 *
 * 1. **Layer 1 (World methods)** — every mutation (`get`/`set`/`spawn`/`despawn`/
 *    `addComponent`/`removeComponent`) returns `Result<T, EcsError>`.
 *    Use `.unwrap()` for quick-and-dirty or `if (!r.ok) ... r.error ...` for programmatic branching.
 *
 *
 * AI users: import types from this module — `.d.ts` signatures expose
 * `Result<T, EcsError>` on all World methods, making error paths discoverable
 * without reading source. Switch on `.code` for programmatic error branching.
 *
 * **Warning — Result propagation in system bodies**: TypeScript lacks Rust's `?`
 * operator. Handle every Result branch explicitly or return the failure from
 * the system so the frame poison boundary can stop the host.
 */

// Layered exports: core API first (World / defineComponent / Entity / Query),
// then Result + error types, then advanced API (Schedule / CommandBuffer),
// then errors, then constants. AI users reading .d.ts see high-frequency
// APIs at the top of the file (charter V1 proposition 1).

// ────────────────────────────────────────────────────────────────────────────
// Result type — the return type of all World mutation methods
// ────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated union result type: `ResultOk<T>` or `ResultErr<E>`.
 * All World mutation methods return `Result<T, EcsError>`. The discriminant
 * is `.ok: boolean`; the success branch carries `.value: T`, the failure
 * branch carries `.error: E`. Method chain: `.unwrap()` / `.unwrapOr(d)`.
 *
 * @example
 * ```ts
 * // Plain field-access idiom (charter proposition 5 consistent abstraction):
 * const r = world.get(entity, Position);
 * if (!r.ok) { console.error(r.error.code, r.error.hint); return; }
 * const data = r.value; // ShapeOf<S>
 *
 * // Method-chain idiom (`.unwrap()` throws the original EcsError on err):
 * const data2 = world.get(entity, Position).unwrap();
 *
 * // Defaulted-fallback idiom (charter proposition 4 explicit-failure
 * // boundary — `unwrapOr` silently drops the error):
 * const data3 = world.get(entity, Position).unwrapOr({ x: 0, y: 0 });
 * ```
 */

import { componentId, isComponentDefinitionOrderValid } from './component';
// Entity must register before every other component so its storage identity is 0.
// Keep this import ahead of downstream component-defining modules.
import { Disabled, Entity } from './entity';

if (!isComponentDefinitionOrderValid() || componentId(Entity) !== 0) {
  throw new Error(
    'forgeax-engine-ecs: Entity invariant violated ' +
      `(expected id=0, got ${componentId(Entity)}). ` +
      'A defineComponent() call evaluated before the @forgeax/engine-ecs barrel forced the id counter ' +
      'past 0. Ensure no module defines a component at import time before importing from the barrel.',
  );
}

/**
 * Branded-number handle type identifying a row (24-bit index + 8-bit
 * generation). The `Entity` component token (value-space, id=0) and the
 * `EntityHandle` type (type-space) are deliberately separate names since
 * feat-20260611 -- a single shared name caused repeated AI-user confusion in
 * `: Entity` annotations.
 */
export type { EntityHandle } from './entity-handle';
export type { EcsErrorCode } from './errors';
export {
  ArrayRangeOutOfBoundsError,
  SharedRefStaleError,
  UniqueRefStaleError,
} from './errors';
export {
  createWorldContext,
  worldPlugin,
} from './plugin-service';
export {
  defineRelationship,
  type RelationshipTargetComponent,
} from './relationship-index';
export {
  defineSchedule,
  FixedUpdate,
  type ScheduleToken,
  Update,
} from './schedule-token';
export {
  FixedTime,
  type FixedTimeResource,
  Time,
  type TimePolicy,
  type TimeResource,
  type WorldOptions,
} from './time';
/**
 * Union of all EcsError types returned by World methods via Result.
 * Switch on `.code` for programmatic branching (e.g. `error.code === 'stale-entity'`).
 */
export type { EcsError } from './world';
/**
 * The id=0 `Entity` component token. The matching type-space handle
 * type (the branded number returned by `world.spawn` and accepted by every
 * World method that takes an entity argument) is `EntityHandle`, exported
 * separately from this barrel.
 *
 * @example Handle type + spawn:
 * ```ts
 * const e: EntityHandle = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
 * ```
 * @example Read the handle off its own column / probe liveness:
 * ```ts
 * world.get(e, Entity).unwrap().self === e;
 * ```
 */
export { Disabled, Entity };

// ────────────────────────────────────────────────────────────────────────────
// Core API — the 80% surface most users need
// ────────────────────────────────────────────────────────────────────────────

/**
 * Two-axis phantom-branded handle: `Handle<TargetTag, Mode>`.
 *
 * - `Mode = 'unique'` — released by ECS on despawn / removeComponent / set
 *   (e.g. derived from schema vocab `unique<T>`).
 * - `Mode = 'shared'` — external owner manages release; ECS treats as
 *   plain id (e.g. derived from schema vocab `asset<kind>`,
 *   `MeshFilter.assetHandle: Handle<'MeshAsset','shared'>`).
 *
 * Cross-mode and cross-target assignment is a TS error (AC-02).
 *
 * The handle type is owned by `@forgeax/engine-types`; ECS schema fields
 * consume it but the ECS barrel does not forward the type.
 *
 * @example
 * ```ts
 * import type { Handle } from '@forgeax/engine-types';
 *
 * declare const mesh: Handle<'MeshAsset', 'shared'>;
 * // const mat: Handle<'MaterialAsset', 'shared'> = mesh; // TS error
 * ```
 */
/**
 * Opaque component token carrying name + schema type information.
 *
 * Prefer letting `defineComponent` infer the type — both the literal name `N`
 * and schema `S` flow through, enabling typed `QueryRow.get` / `QueryRow.mut`
 * access without `as` assertions.
 *
 * @example
 * ```ts
 * // Recommended — infer both N and S:
 * const Pos = defineComponent('Pos', { x: 'f32', y: 'f32' });
 * //    ^? Component<'Pos', { x: 'f32'; y: 'f32' }>
 *
 * // Only annotate when you must — and use both type parameters:
 * const Vel: Component<'Vel', { dx: 'f32'; dy: 'f32' }> =
 *   defineComponent('Vel', { dx: 'f32', dy: 'f32' });
 * ```
 */
export type {
  Component,
  ComponentSchema,
  FieldReflection,
  InputShapeOf,
  SchemaOf,
  ShapeOf,
} from './component';
/**
 * Declare a component schema. Returns a frozen opaque token with `.name`, `.fields`, `.storage`.
 *
 * @example
 * ```ts
 * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
 * ```
 */
export { defineComponent } from './component';
/**
 * Query descriptor for With/Without archetype filtering.
 *
 * @example
 * ```ts
 * const desc: QueryDescriptor = { with: [Position, Velocity], without: [Static] };
 * ```
 */
export type {
  Query,
  QueryCreationError,
  QueryDescriptor,
  QueryRow,
  QuerySpan,
} from './query/query';
export type { ScheduleRunObserver, ScheduleWorkScope } from './schedule-observation.js';
export {
  beginScheduleWork,
  hasScheduleRunObservers,
  registerScheduleWork,
  runScheduleWork,
  scheduleWorkNames,
} from './schedule-observation.js';
/** Non-asset shared ECS values use generation-checked, reference-counted storage.
 * Asset component fields retain the injected asset owner instead.
 */
export { type ComponentData, World } from './world.js';

// ────────────────────────────────────────────────────────────────────────────
// Advanced API — system scheduling, commands, resources, inspection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Deferred command buffer passed to system functions. Queues structural changes
 * (spawn/despawn/addComponent/removeComponent) for end-of-frame flush.
 *
 * @example
 * ```ts
 * fn: (world, results, commands) => {
 *   const e = commands.spawn({ component: Bullet, data: { dmg: 10 } });
 *   commands.despawn(oldEntity);
 * }
 * ```
 */
export type { CommandBuffer } from './commands';
/**
 * System declaration created with `defineSystem`. Declares queries, execution function,
 * and optional before/after ordering constraints.
 *
 * @example
 * ```ts
 * world.addSystem(Update, defineSystem({
 *   name: 'movement',
 *   queries: [{ with: [Position, Velocity] }],
 *   fn: (world, results, commands) => { ... },
 * }));
 * ```
 */
/**
 * SystemSet nominal branded token type. Use {@link defineSystemSet} to create
 * a token; never construct manually. Its private
 * brand prevents plain-object assignment.
 *
 * @example
 * ```ts
 * import type { SystemSet } from '@forgeax/engine-ecs';
 * const set: SystemSet = defineSystemSet({ name: 'gameplay' });
 * ```
 */
export type {
  System,
  SystemDescriptor,
  SystemOrderReference,
  SystemSet,
  SystemToken,
} from './schedule';
/**
 * Define a frozen system token. Executable registration is World-local through
 * `world.addSystem`.
 *
 * @example
 * ```ts
 * const Move = defineSystem({
 *   name: 'movement',
 *   queries: [{ with: [Position, Velocity] }],
 *   fn: (world, results) => { ... },
 * });
 * world.addSystem(Move);
 * ```
 */
/**
 * Define a frozen system-set token. Membership is World-local.
 *
 * @example
 * ```ts
 * const Paused = defineResource<boolean>('paused');
 * const GameplaySet = defineSystemSet({ name: 'gameplay', runIf: (w) => !w.getResource(Paused) });
 * const OrderedSet = defineSystemSet({ name: 'ordered', chained: true });
 * ```
 */
export {
  defineSystem,
  defineSystemSet,
} from './schedule';

/**
 * Inspection snapshot returned by `world.inspect()`. Contains entity count,
 * archetype info, active components, system count, and resource keys.
 *
 * @example
 * ```ts
 * const info = world.inspect();
 * console.log(info.entityCount, info.archetypeCount);
 * ```
 */

// ────────────────────────────────────────────────────────────────────────────
// Entity encoding utilities
// ────────────────────────────────────────────────────────────────────────────

/**
 * Encode/decode entity handles for serialization or debugging.
 *
 * @example
 * ```ts
 * const { index, generation } = decodeEntity(entity);
 * const rebuilt = encodeEntity(index, generation);
 * ```
 */

// ────────────────────────────────────────────────────────────────────────────
// Query engine utilities
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Component internals (for advanced use: custom storage, tooling)
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Layer-3 default-value SSOT helper (feat-20260517-spawn-default-fallback / M1)
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

// Component policy and metadata are an explicit schema projection, not fields
// on the token or a process-global registry. Owners that need these facts must
// receive the token's projection through this seam.
export { componentDefinition } from './component-schema';
export { ENTITY_MAX_GENERATION, ENTITY_MAX_INDEX, ENTITY_NULL_RAW } from './entity-handle';

// w8: Inspector contributor (registerEcsInspector + RegisterEcsInspectorResult)
// deleted — routing layer (Registry / sandbox) is removed; eval is the sole
// command channel.
// w9: ECS_MUTATING_METHODS export deleted — sandbox dismantled; mutating-methods.ts removed.

export { ChangeEpochExhaustedError } from './errors';
export {
  QueryBatchUnavailableError,
  type QueryBatchUnavailableReason,
} from './errors/query-batch-errors';
export { SHARED_KERNEL_EXECUTOR_RESOURCE_KEY } from './execution/shared-kernel';
export { deferFixedStep, fixedStepIsDeferred } from './fixed-step-barrier';
export type { FrameArena, FrameArenaStats } from './frame-arena';
export type {
  MemoryArray,
  MemoryArrayConstructor,
  MemoryBudget,
  MemoryErrorCode,
  MemoryErrorDetail,
  WorldMemoryOptions,
} from './memory-types';
export { MemoryError } from './memory-types';
export type { BufferHandle, BufferLease, OwnedBuffers } from './owned-buffers';
export type { NumericField, QueryBatch, QueryBatchColumns, ReadonlyColumn } from './query/batch';
export { defineResource, type Resource } from './resource';
export type { WorldMemoryStats } from './world-memory';
