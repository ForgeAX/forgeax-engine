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

import { isComponentDefinitionOrderValid } from './component';
// ────────────────────────────────────────────────────────────────────────────
// Essential-id forced registration (feat-20260602 M1 / w1; plan-strategy
// D-1 / D-6b; feat-20260611 D-9 SSOT switch to ESSENTIAL_COMPONENT_IDS).
//
// The `Entity` component MUST be the first `defineComponent` evaluated in the
// process so the owner identity assigns it id=0. ESM
// evaluates import bindings in source order before any other statement, so this
// import -- placed textually first among the barrel's module imports -- forces
// `entity.ts` (and thus `defineComponent('Entity', ...)`) to run ahead of
// every downstream component module. The fail-fast assertion below converts
// an import-order regression from a silent runtime mis-id into a structured
// startup throw (charter P3).
//
// The assertion reads `ESSENTIAL_COMPONENT_IDS` (the SSOT for which ids must
// be present and where) rather than hard-coding a token property so adding a
// future essential component requires updating exactly one place.
//
// `Entity` is re-exported from the barrel as a value (the id=0 component
// token). The matching type-space handle type is `EntityHandle`, re-exported
// from `./entity-handle` -- the two no longer share a name (feat-20260611 I-1;
// renamed from `./entity` to `./entity-handle` in tweak-20260611-M3 to make
// the file's role explicit; tweak-20260612 then lifted the Entity component
// from the historical `components/entity.ts` back into `./entity` since that
// slot was free).
import { Disabled, Entity, ESSENTIAL_COMPONENT_IDS, foldEssentials } from './entity';

if (
  !isComponentDefinitionOrderValid() ||
  ESSENTIAL_COMPONENT_IDS.length !== 1 ||
  ESSENTIAL_COMPONENT_IDS[0] !== 0
) {
  throw new Error(
    'forgeax-engine-ecs: ESSENTIAL_COMPONENT_IDS invariant violated ' +
      `(expected [0], got [${ESSENTIAL_COMPONENT_IDS.join(', ')}]). ` +
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
  FixedUpdate,
  type ScheduleName,
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
 * The id=0 essential `Entity` component token. The matching type-space handle
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
export { Disabled, Entity, ESSENTIAL_COMPONENT_IDS, foldEssentials };

// ────────────────────────────────────────────────────────────────────────────
// Core API — the 80% surface most users need
// ────────────────────────────────────────────────────────────────────────────

/**
 * Two-axis phantom-branded handle: `Handle<TargetTag, Mode>`.
 *
 * - `Mode = 'unique'` — released by ECS on despawn / removeComponent / set
 *   (e.g. derived from schema vocab `ref<T>`).
 * - `Mode = 'shared'` — external owner manages release; ECS treats as
 *   plain id (e.g. derived from schema vocab `handle<T>`,
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
/**
 * ECS-aware refcount-tracked handle store (M3). Owns the lifecycle of every
 * `Handle<T, 'shared'>` derived from `shared<T>` schema fields. The producer
 * (typically AssetRegistry) calls `alloc` once (alloc-grant rc=1); each
 * additional holder retains; release decrements; rc 1 -> 0 drops the slot
 * and publishes structured release evidence. Payload disposal belongs to the
 * renderer/assets/plugin owner; ECS invokes no user callback.
 *
 * D-15: the store manages ONLY user-tier slots (`>= BUILTIN_BASE`); builtin
 * asset payloads are process-static in their authoring package
 * (@forgeax/engine-runtime) and never reference-counted. Passing a builtin
 * slot fails fast with `BuiltinSlotNotOwnedError`.
 *
 * `World` owns one `SharedRefStore` per instance, exposed as
 * `world.sharedRefs`. The schema-field write barrier (retain on spawn / set,
 * release on despawn / removeComponent) short-circuits on builtin slots.
 *
 * @example
 * ```ts
 * const world = new World();
 * const handle = world.allocSharedRef('MaterialAsset', payload);
 * const M = defineComponent('M', { asset: 'shared<MaterialAsset>' });
 * world.spawn({ component: M, data: { asset: handle } });
 * // the SharedRefStore publishes release evidence at rc=0.
 * ```
 */
export type { SharedRefReleaseEvidence } from './shared-ref-store.js';

/**
 * ECS-managed handle store (M1). Owns the lifecycle of every
 * `Handle<T, 'unique'>` derived from `ref<T>` schema fields - World hooks
 * `despawn` / `removeComponent` / `set` into `release(handle)`.
 *
 * `World` owns one `UniqueRefStore` per instance, constructed eagerly in the
 * `World` constructor (always-on since feat-20260515-string-managed-collapse).
 * Production code rarely touches the store directly - schema-vocab `ref<T>`
 * fields make `world.get(e, C).<refField>` the canonical access path.
 *
 * @example
 * ```ts
 * const Material = defineComponent('Material', { handle: 'unique<MaterialPayload>' });
 * const world = new World();
 * // World owns the UniqueRefStore internally; AI users do not wire it.
 * ```
 */

/**
 * Component data bundle for spawn/addComponent: pairs a component token with initial values.
 *
 * @example
 * ```ts
 * const data: ComponentData = { component: Position, data: { x: 1, y: 2 } };
 * ```
 */
export type { ComponentData } from './world.js';
/**
 * Top-level ECS container. Owns entities, archetypes, systems, and resources.
 *
 * @example
 * ```ts
 * const world = new World();
 * const e = world.spawn({ component: Position, data: { x: 0, y: 0 } });
 * world.update();
 * ```
 */
export { World } from './world.js';

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
 * System descriptor for `world.addSystem()`. Declares queries, execution function,
 * and optional before/after ordering constraints.
 *
 * @example
 * ```ts
 * world.addSystem(Update, {
 *   name: 'movement',
 *   queries: [{ with: [Position, Velocity] }],
 *   fn: (world, results, commands) => { ... },
 * });
 * ```
 */
/**
 * SystemSet nominal branded token type. Use {@link defineSystemSet} to create
 * a token; never construct manually. The {@link SystemSet.__forgeaxSystemSet}
 * brand prevents plain-object assignment.
 *
 * @example
 * ```ts
 * import type { SystemSet } from '@forgeax/engine-ecs';
 * const set: SystemSet = defineSystemSet({ name: 'gameplay' });
 * ```
 */
export type {
  SystemDescriptor,
  SystemHandle,
  SystemSet,
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
 * const GameplaySet = defineSystemSet({ name: 'gameplay', runIf: (w) => !w.getResource<boolean>('paused') });
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
