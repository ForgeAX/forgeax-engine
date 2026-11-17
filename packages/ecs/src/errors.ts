import type * as QueryErrors from './errors/query-and-component-errors';
import type * as BatchErrors from './errors/query-batch-errors';
import type * as FieldErrors from './errors/sprite-and-shared-errors';
import type { MemoryError, MemoryErrorDetail } from './memory-types';

// @forgeax/engine-ecs — typed error class collection.
//
// Typed error classes covering all boundary conditions. Each follows progressive
// disclosure format: one-line summary → context fields → hint fix suggestion.
// Each exposes a `.hint` readonly property for programmatic extraction.

// ────────────────────────────────────────────────────────────────────────────
// Re-exports from split error sub-files (w3-b — package cohesion split)
// ────────────────────────────────────────────────────────────────────────────

export {
  ComponentNotDefinedError,
  QueryDataRequiresFieldsError,
  QueryDescriptorConflictError,
  QueryIterationActiveError,
  QueryIterationInvalidatedError,
  QuerySpanUnavailableError,
  type QuerySpanUnavailableReason,
  RemoveEntityComponentError,
  SpawnDataUnknownFieldError,
} from './errors/query-and-component-errors';

export {
  RelationshipDetachMismatchError,
  RelationshipMirrorComponentNotRegisteredError,
  RelationshipMirrorFieldTypeMismatchError,
  RelationshipSelfCycleError,
  RelationshipTargetReadonlyError,
} from './errors/relationship-errors';
export {
  SharedKernelEligibilityError,
  SharedKernelFailureError,
  WorldPoisonedError,
} from './errors/shared-kernel-errors';
export { SharedFieldInvalidValueError } from './errors/sprite-and-shared-errors';
export {
  ArrayRangeOutOfBoundsError,
  ComponentFieldInvalidValueError,
  ManagedArrayInvalidValueError,
  ScheduleScopeMismatchError,
  TimeConfigInvalidError,
  TimeDeltaInvalidError,
  TimeScaleInvalidError,
  TimeScaleLeaseReleasedError,
  validateEnumFieldValues,
} from './errors/validation-errors';

/**
 * Thrown when an attempt is made to encode an entity index that does not fit
 * in 24 bits (i.e. >= 2^24 = 16_777_216).
 *
 * `.code = 'entity-index-overflow'`
 * `.hint` — suggests reducing entity count or investigating leaks.
 */
export class EntityIndexOverflowError extends RangeError {
  override readonly name = 'EntityIndexOverflowError';
  readonly code = 'entity-index-overflow' as const;
  readonly hint: string;

  constructor(index: number) {
    const hint =
      'Entity index exceeds 24-bit max (16777215). Reduce simultaneous entity count or investigate entity leaks.';
    super(
      `Entity index ${index} exceeds 24-bit max (16777215).\n` +
        `  index: ${index}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
  }
}

/**
 * Thrown when `defineComponent` is given a field type that is not in the
 * supported scalar field type set.
 *
 * `.code = 'schema-unsupported-field'`
 * `.hint` — lists all supported scalar field types.
 */
export class SchemaUnsupportedFieldError extends Error {
  override readonly name = 'SchemaUnsupportedFieldError';
  readonly code = 'schema-unsupported-field' as const;
  readonly hint: string;

  constructor(fieldName: string, fieldType: string) {
    const hint =
      'Use a scalar (f32/f64/i32/u32/i16/u16/i8/u8/bool/enum), entity, string, ' +
      'unique<T>, shared<T>, asset<kind>, buffer, buffer<N>, array<T>, or array<T,N>. ' +
      'AssetRegistry owns asset content; unique<T> owns one non-asset value.';
    super(
      `Schema field "${fieldName}" has unsupported type "${fieldType}".\n` +
        `  field: ${fieldName}\n` +
        `  type: ${fieldType}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
  }
}

export class SparseStorageRequiresTagError extends Error {
  override readonly name = 'SparseStorageRequiresTagError';
  readonly code = 'sparse-storage-requires-tag' as const;
  readonly expected = 'sparse components have an empty schema and no relationship metadata';
  readonly hint = 'remove all fields and relationship metadata, or use storage: table';
  readonly detail: { readonly componentName: string };

  constructor(componentName: string) {
    super(
      `Sparse component "${componentName}" must be a zero-field, non-relationship tag.\n` +
        `  component: ${componentName}\n` +
        `  hint: remove all fields and relationship metadata, or use storage: table`,
    );
    this.detail = { componentName };
  }
}

/**
 * Thrown (or returned via the `Result` err branch — `r.ok === false`, `r.error`)
 * when get/set/addComponent/removeComponent is called on an entity that has
 * been despawned (stale handle).
 *
 * `.code = 'stale-entity'`
 * `.hint` — includes operation name, expected/actual generation, and component name.
 * Enhanced fields: `.component`, `.operation`, `.expectedGeneration`, `.actualGeneration`.
 */
export class StaleEntityError extends Error {
  override readonly name = 'StaleEntityError';
  readonly code = 'stale-entity' as const;
  readonly hint: string;

  /** Component name involved in the operation (undefined when the operation does not target a specific component). */
  readonly component: string | undefined;
  /** The component-level operation that triggered this error (e.g. 'get' / 'set' / 'add' / 'remove'). Entity-level operations like `despawn` are not surfaced here — see `EntityHandle` lifecycle errors. */
  readonly operation: string | undefined;
  /** The generation the caller expected (from the entity handle). */
  readonly expectedGeneration: number | undefined;
  /**
   * The actual generation found in the entity pool. `-1` is the sentinel
   * value for entities never allocated (slot was never occupied), as opposed
   * to allocated-then-despawned entities which carry a real (incremented)
   * generation number.
   */
  readonly actualGeneration: number | undefined;

  constructor(
    entityId: number,
    index: number,
    generation: number,
    enhanced?: {
      component?: string;
      operation: string;
      expectedGeneration: number;
      actualGeneration: number;
    },
  ) {
    const hint = enhanced
      ? `Entity was despawned. Operation "${enhanced.operation}" on entity ${entityId}` +
        (enhanced.component ? ` (component: ${enhanced.component})` : '') +
        ` expected generation ${enhanced.expectedGeneration}, found ${enhanced.actualGeneration}.` +
        ' Check entity lifecycle before access.'
      : 'Entity was despawned. Check entity lifecycle before access.';
    super(
      `Operation on stale entity handle.\n` +
        `  entity: ${entityId} (index=${index}, generation=${generation})\n` +
        (enhanced ? `  operation: ${enhanced.operation}\n` : '') +
        (enhanced?.component ? `  component: ${enhanced.component}\n` : '') +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.component = enhanced?.component;
    this.operation = enhanced?.operation;
    this.expectedGeneration = enhanced?.expectedGeneration;
    this.actualGeneration = enhanced?.actualGeneration;
  }
}

/**
 * Returned via the `Result` err branch (`r.ok === false`, `r.error`) when
 * addComponent tries to add a component that the entity already possesses.
 *
 * `.code = 'component-already-present'`
 * `.hint` — suggests using `set()` to update values instead.
 */
export class ComponentAlreadyPresentError extends Error {
  override readonly name = 'ComponentAlreadyPresentError';
  readonly code = 'component-already-present' as const;
  readonly hint: string;

  constructor(entityId: number, componentName: string) {
    const hint = 'Entity already has this component. Use set() to update values.';
    super(
      `Entity ${entityId} already has component "${componentName}".\n` +
        `  entity: ${entityId}\n` +
        `  component: ${componentName}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
  }
}

/**
 * Returned via the `Result` err branch (`r.ok === false`, `r.error`) when
 * removeComponent / set is called for a component the entity does not possess.
 *
 * `.code = 'component-not-present'`
 * `.hint` — suggests checking with query or inspect().
 */
export class ComponentNotPresentError extends Error {
  override readonly name = 'ComponentNotPresentError';
  readonly code = 'component-not-present' as const;
  readonly hint: string;

  constructor(entityId: number, componentName: string) {
    const hint = 'Entity does not have this component. Check with query or inspect().';
    super(
      `Entity ${entityId} does not have component "${componentName}".\n` +
        `  entity: ${entityId}\n` +
        `  component: ${componentName}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
  }
}

/**
 * Thrown when DAG Schedule detects a cyclic dependency among systems.
 *
 * `.code = 'cyclic-dependency'`
 * `.hint` — includes the cycle path and suggests removing one constraint.
 * `.detail` — `{ code: 'cyclic-dependency'; cycle: readonly string[] }` contains the
 *    structured cycle path for programmatic consumption.
 */
export class CyclicDependencyError extends Error {
  override readonly name = 'CyclicDependencyError';
  readonly code = 'cyclic-dependency' as const;
  readonly expected = 'the schedule dependency graph is acyclic';
  readonly hint: string;
  /** Structured cycle path — programmatic consumers read this, not the message. */
  readonly detail: { readonly code: 'cyclic-dependency'; readonly cycle: readonly string[] };

  constructor(cycle: readonly string[]) {
    const cycleStr = cycle.join(' -> ');
    const hint = `Cycle path: ${cycleStr}. Remove one ordering constraint to break the cycle.`;
    super(`DAG Schedule has a cyclic dependency.\n  cycle: ${cycleStr}\n  hint: ${hint}`);
    this.hint = hint;
    this.detail = { code: 'cyclic-dependency' as const, cycle };
  }
}

/**
 * Returned via `Result.err` from `world.addSystems`
 * when a SystemSet token fails local structural validation.
 *
 * The sole public invalid-token error type (D-2a). Covers all rejection
 * scenarios: plain-object cast, unregistered name, stale token after
 * overwrite, and cross-realm copies.
 *
 * `.code = 'system-set-not-registered'`
 * `.expected` — the name of the unregistered token.
 * `.hint` — suggests passing the current token to the owning World schedule.
 * `.detail` — `{ code, name, registered }` where `registered` is a deterministic snapshot
 *    of the current World-local schedule keys.
 */
export class SystemSetNotRegisteredError extends Error {
  override readonly name = 'SystemSetNotRegisteredError';
  readonly code = 'system-set-not-registered' as const;
  /** The name carried by the rejected token. */
  readonly expected: string;
  readonly hint: string;
  /** Deterministic snapshot of the current World-local schedule for repair. */
  readonly detail: {
    readonly code: 'system-set-not-registered';
    readonly name: string;
    readonly registered: readonly string[];
  };

  constructor(name: string, registered: readonly string[]) {
    const hint =
      `SystemSet "${name}" is not valid for the current World schedule. ` +
      `Pass a non-empty SystemSet token owned by this World schedule.`;
    const message =
      `SystemSet "${name}" is not registered.\n` +
      `  expected: ${name}\n` +
      `  registered: [${registered.join(', ')}]\n` +
      `  hint: ${hint}`;
    super(message);
    this.expected = name;
    this.hint = hint;
    this.detail = { code: 'system-set-not-registered' as const, name, registered };
  }
}

/**
 * Factory for {@link SystemSetNotRegisteredError}. Consumed by
 * {@link validateSystemSetTokens} (w4) and the two mutation entry points.
 */
export function systemSetNotRegistered(
  name: string,
  registered: readonly string[],
): SystemSetNotRegisteredError {
  return new SystemSetNotRegisteredError(name, registered);
}

/**
 * Closed-set ScheduleMutationError code union (M2 — plan-strategy D-3).
 *
 * Schedule add-only API (`removeSystem` / `replaceSystem`) returns
 * `Result<void, ScheduleMutationError>` carrying one of these codes. The
 * `@forgeax/engine-remote` layer (M3) bridges these strings to JSON-RPC
 * `RemoteErrorCode` 1:1 — keeping ECS free of console / wire dependencies.
 *
 * - `system-before-unknown` — name argument does not match any registered system.
 * - `system-name-conflict`  — reserved for the M3 inject path; surfaced from
 *   schedule when callers inject a name that already exists.
 * - `cyclic-injection`      — schedule build detected a cycle introduced by
 *   the mutation; carries the cycle path in `.detail.cycle`.
 */
export type ScheduleMutationErrorCode = 'system-before-unknown';

export interface ScheduleMutationErrorDetail {
  readonly cycle?: readonly string[];
  readonly candidates?: readonly string[];
}

/**
 * Returned via `Result.err` from `world.removeSystem` / `world.replaceSystem`.
 *
 * `.code` is the closed-set string SSOT consumed by the M3 console bridge;
 * `.hint` carries an AI-friendly self-repair suggestion; `.detail` is the
 * discriminated payload (cycle path for `cyclic-injection`, candidate list
 * for `system-before-unknown`).
 */
export class ScheduleMutationError extends Error {
  override readonly name = 'ScheduleMutationError';
  readonly code: ScheduleMutationErrorCode;
  readonly hint: string;
  readonly detail: ScheduleMutationErrorDetail;

  constructor(
    code: ScheduleMutationErrorCode,
    message: string,
    hint: string,
    detail: ScheduleMutationErrorDetail = {},
  ) {
    super(`${message}\n  code: ${code}\n  hint: ${hint}`);
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }
}

/**
 * Thrown when getResource is called with a key that does not exist.
 *
 * `.code = 'resource-not-found'`
 * `.hint` — suggests using `world.insertResource()` first.
 */
export class ResourceNotFoundError extends Error {
  override readonly name = 'ResourceNotFoundError';
  readonly code = 'resource-not-found' as const;
  readonly hint: string;

  constructor(key: string) {
    const hint = `Resource "${key}" not found. Insert with world.insertResource() first.`;
    super(`Resource "${key}" not found.\n` + `  key: ${key}\n` + `  hint: ${hint}`);
    this.hint = hint;
  }
}

export class ChangeEpochExhaustedError extends Error {
  override readonly name = 'ChangeEpochExhaustedError';
  readonly code = 'change-epoch-exhausted' as const;
  readonly expected = 'mutationEpoch < Number.MAX_SAFE_INTEGER';
  readonly hint = 'Rebuild the World before performing another mutation.';
  readonly detail: { readonly epoch: number };

  constructor(epoch: number) {
    super(`World mutation epoch is exhausted at ${epoch}.\n  hint: Rebuild the World.`);
    this.detail = { epoch };
  }
}

export class DerivedWriteActiveError extends Error {
  override readonly name = 'DerivedWriteActiveError';
  readonly code = 'derived-write-active' as const;
  readonly expected =
    'a completed synchronous derived write before reading changes or starting another writer';
  readonly hint = 'Finish the active numeric producer, then retry on the same healthy World.';
  readonly detail = {};
  constructor() {
    super('World has an active derived write; its change evidence is not published yet.');
  }
}

export class DerivedRangeOutOfBoundsError extends Error {
  override readonly name = 'DerivedRangeOutOfBoundsError';
  readonly code = 'derived-range-out-of-bounds' as const;
  readonly expected = 'a non-negative span-relative range with start + count <= span.length';
  readonly hint =
    'check start and count against the QuerySpan length, then retry without changing World state';
  readonly detail: { readonly start: number; readonly count: number; readonly spanLength: number };

  constructor(start: number, count: number, spanLength: number) {
    super(`Derived range [${start}, ${start + count}) exceeds QuerySpan length ${spanLength}.`);
    this.detail = { start, count, spanLength };
  }
}

/**
 * Thrown when insertResource/removeResource is called on a World-owned
 * protected resource (Time or FixedTime).
 *
 * `.code = 'resource-protected'`
 * `.hint` — suggests using `world.update(delta)` or reading the resource.
 * `.expected` — the resource name that was rejected.
 */
export class ProtectedResourceError extends Error {
  override readonly name = 'ProtectedResourceError';
  readonly code = 'resource-protected' as const;
  readonly hint: string;
  readonly expected: string;

  constructor(resourceName: string, operation: 'insert' | 'remove') {
    const hint =
      operation === 'insert'
        ? `"${resourceName}" is a World-owned protected resource. It is advanced by world.update(delta); read it via world.getResource(${resourceName}).`
        : `"${resourceName}" is a World-owned protected resource. It is owned by the World scheduler and cannot be removed.`;
    const expected = `a user-owned resource key (not ${resourceName})`;
    super(
      `Protected resource "${resourceName}" cannot be ${operation}ed.\n` +
        `  code: resource-protected\n` +
        `  resource: ${resourceName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Managed value lifetime errors.

/**
 * Thrown / returned via `Result.err` when UniqueRefStore.alloc encounters a
 * slot whose refcount has already dropped to zero (sentinel for a released
 * slot reused without re-init).
 *
 * `.code = 'unique-ref-released'`
 * `.detail = { handle, target }`
 * `.hint` — recommends checking handle lifetime against owner despawn.
 */
export class UniqueRefReleasedError extends Error {
  override readonly name = 'UniqueRefReleasedError';
  readonly code = 'unique-ref-released' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly handle: number; readonly target: string };

  constructor(handle: number, target: string) {
    const hint = `Handle ${handle} (target ${target}) was released before this access. Re-acquire via the producing system or re-spawn the asset before reading.`;
    const expected = 'live (refcount >= 1) managed handle';
    super(
      `UniqueRefStore: handle is already released.\n` +
        `  code: unique-ref-released\n` +
        `  handle: ${handle}\n` +
        `  target: ${target}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { handle, target };
  }
}

/**
 * Thrown / returned via `Result.err` when UniqueRefStore.release is called on
 * a handle whose refcount is already zero (double-free).
 *
 * `.code = 'unique-ref-double-release'`
 * `.detail = { handle, target }`
 * `.hint` — recommends auditing the release-loop entry points (set / removeComponent / despawn).
 */
export class UniqueRefDoubleReleaseError extends Error {
  override readonly name = 'UniqueRefDoubleReleaseError';
  readonly code = 'unique-ref-double-release' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly handle: number; readonly target: string };

  constructor(handle: number, target: string) {
    const hint = `Handle ${handle} (target ${target}) was released twice. Only one of {despawn / removeComponent / set} should release a managed handle per lifecycle.`;
    const expected = 'first release of a managed handle (refcount transition 1 -> 0)';
    super(
      `UniqueRefStore: double release on handle.\n` +
        `  code: unique-ref-double-release\n` +
        `  handle: ${handle}\n` +
        `  target: ${target}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { handle, target };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260614-ecs-shared-component-and-unique-rename M3 — SharedRefStore
// closed-union extension (+2). Mirrors the UniqueRef* pair — `'shared-ref-released'`
// covers resolve-after-release / retain-after-release; `'shared-ref-double-release'`
// covers release-when-rc-already-zero. Both are Result.err returns (not throws);
// AI users branch on `.code` and read `.detail.handle` for the offending slot.
//
// Detail field shape mirrors UniqueRef* with one addition (`rc`) so AI users
// debugging a double-release see the exact rc transition that surfaced the
// failure (charter P3 progressive disclosure). Empty `target` handled the
// same way as UniqueRef* — runtime-erased phantom, surfaced as '<unknown>'.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thrown / returned via `Result.err` when SharedRefStore.resolve / .retain is
 * called on a handle whose refcount has already dropped to zero (slot released).
 *
 * `.code = 'shared-ref-released'`
 * `.detail = { handle, target }`
 * `.hint` — recommends checking handle lifetime against owner / consumer release.
 */
export class SharedRefReleasedError extends Error {
  override readonly name = 'SharedRefReleasedError';
  readonly code = 'shared-ref-released' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly handle: number; readonly target: string };

  constructor(handle: number, target: string) {
    const hint = `Handle ${handle} (target ${target}) was released (refcount reached 0). Re-acquire via the producing system or re-spawn the asset before reading.`;
    const expected = 'live (refcount >= 1) shared handle';
    super(
      `SharedRefStore: handle is already released.\n` +
        `  code: shared-ref-released\n` +
        `  handle: ${handle}\n` +
        `  target: ${target}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { handle, target };
  }
}

/**
 * Thrown / returned via `Result.err` when SharedRefStore.release is called on
 * a handle whose refcount is already zero (double-release). Distinct from the
 * UniqueRef family because shared release is rc--, not direct slot drop —
 * AI users debug this by reading `.detail.rc` (always 0 here) alongside the
 * payload-presence signal.
 *
 * `.code = 'shared-ref-double-release'`
 * `.detail = { handle, target, rc }`
 * `.hint` — recommends auditing the producer / consumer release pairs.
 */
export class SharedRefDoubleReleaseError extends Error {
  override readonly name = 'SharedRefDoubleReleaseError';
  readonly code = 'shared-ref-double-release' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly handle: number; readonly target: string; readonly rc: number };

  constructor(handle: number, target: string, rc: number) {
    const hint = `Handle ${handle} (target ${target}) released with rc=${rc}. Each shared handle must have a matching alloc/retain for every release; audit the producer / consumer release pairs.`;
    const expected = 'rc >= 1 before release';
    super(
      `SharedRefStore: double release on handle.\n` +
        `  code: shared-ref-double-release\n` +
        `  handle: ${handle}\n` +
        `  target: ${target}\n` +
        `  rc: ${rc}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { handle, target, rc };
  }
}

/** Raised before SharedRefStore mutates slot state for a nullish payload. */
export class SharedRefPayloadInvalidError extends Error {
  override readonly name = 'SharedRefPayloadInvalidError';
  readonly code = 'shared-ref-payload-invalid' as const;
  readonly expected = 'a non-null, non-undefined shared payload';
  readonly hint = 'Allocate a concrete payload and let its owning effect dispose it.';
  readonly detail: { readonly target: string; readonly actual: 'null' | 'undefined' };

  constructor(target: string, actual: 'null' | 'undefined') {
    super(`SharedRefStore: ${actual} payload is not a valid shared reference for ${target}.`);
    this.detail = { target, actual };
  }
}

/**
 * Returned via `Result.err` when SharedRefStore.resolve / .retain / .release
 * is called with a handle whose generation no longer matches the store's
 * current generation for that slot — the slot was released and re-allocated
 * to a different payload. Distinct from `'shared-ref-released'` (slot empty,
 * never re-allocated): stale means the slot IS live but belongs to a newer
 * allocation.
 *
 * `.code = 'shared-ref-stale'`
 * `.detail = { slot, expectedGeneration, actualGeneration }`
 * `.hint` — recommends re-acquiring the handle from AssetRegistry.
 */
export class SharedRefStaleError extends Error {
  override readonly name = 'SharedRefStaleError';
  readonly code = 'shared-ref-stale' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly slot: number;
    readonly expectedGeneration: number;
    readonly actualGeneration: number;
  };

  constructor(slot: number, expectedGeneration: number, actualGeneration: number) {
    const hint = `Handle for slot ${slot} is stale: expected generation ${expectedGeneration}, but the store has generation ${actualGeneration} (slot was released and re-allocated). Re-acquire the handle from AssetRegistry.`;
    const expected = `generation === ${actualGeneration} (current store generation)`;
    super(
      `SharedRefStore: stale handle.\n` +
        `  code: shared-ref-stale\n` +
        `  slot: ${slot}\n` +
        `  expectedGeneration: ${expectedGeneration}\n` +
        `  actualGeneration: ${actualGeneration}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { slot, expectedGeneration, actualGeneration };
  }
}

/**
 * Returned via `Result.err` when UniqueRefStore.resolve / .release is
 * called with a handle whose generation no longer matches the store's
 * current generation for that slot — the slot was released and re-allocated.
 * Distinct from `'unique-ref-released'` (slot empty). UniqueRefStore has
 * no retain method; the stale surface is resolve + release only.
 *
 * `.code = 'unique-ref-stale'`
 * `.detail = { slot, expectedGeneration, actualGeneration }`
 * `.hint` — recommends re-acquiring the handle from the producing system.
 */
export class UniqueRefStaleError extends Error {
  override readonly name = 'UniqueRefStaleError';
  readonly code = 'unique-ref-stale' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly slot: number;
    readonly expectedGeneration: number;
    readonly actualGeneration: number;
  };

  constructor(slot: number, expectedGeneration: number, actualGeneration: number) {
    const hint = `Handle for slot ${slot} is stale: expected generation ${expectedGeneration}, but the store has generation ${actualGeneration} (slot was released and re-allocated). Re-acquire the handle via the producing system or re-spawn the asset.`;
    const expected = `generation === ${actualGeneration} (current store generation)`;
    super(
      `UniqueRefStore: stale handle.\n` +
        `  code: unique-ref-stale\n` +
        `  slot: ${slot}\n` +
        `  expectedGeneration: ${expectedGeneration}\n` +
        `  actualGeneration: ${actualGeneration}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { slot, expectedGeneration, actualGeneration };
  }
}

/**
 * Thrown / returned via `Result.err` when BufferPool indexing reads or writes
 * an offset outside the slot's `[0, size)` byte range. Triggers are limited
 * to the `buffer:<N>` and managed-array-element-buffer paths; the
 * `'string'` schema vocab no longer routes through this code (collapsed onto
 * the managed-ref dispatch by feat-20260515-string-managed-collapse — JS
 * string capacity is bounded by the host runtime, not by BufferPool buckets).
 *
 * `.code = 'managed-buffer-out-of-bounds'`
 * `.detail = { index, size }`
 * `.hint` — points at the field's `'buffer'` / `buffer<N>` schema declaration.
 */
export class ManagedBufferOutOfBoundsError extends RangeError {
  override readonly name = 'ManagedBufferOutOfBoundsError';
  readonly code = 'managed-buffer-out-of-bounds' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly index: number; readonly size: number };

  constructor(index: number, size: number) {
    const hint = `Index ${index} is outside [0, ${size}). Check the field's 'buffer' / 'buffer<N>' declaration matches the access pattern.`;
    const expected = `index in [0, ${size})`;
    super(
      `BufferPool: index out of bounds.\n` +
        `  code: managed-buffer-out-of-bounds\n` +
        `  index: ${index}\n` +
        `  size: ${size}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { index, size };
  }
}

/**
 * Thrown / returned via `Result.err` when BufferPool resize is asked to shrink
 * a slot below its current allocated size — the pool only grows.
 *
 * `.code = 'managed-buffer-shrink-not-supported'`
 * `.detail = { requested, current }`
 * `.hint` — directs callers to allocate a fresh slot if a smaller buffer is needed.
 */
export class ManagedBufferShrinkNotSupportedError extends Error {
  override readonly name = 'ManagedBufferShrinkNotSupportedError';
  readonly code = 'managed-buffer-shrink-not-supported' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly requested: number; readonly current: number };

  constructor(requested: number, current: number) {
    const hint = `BufferPool only grows. Requested ${requested} bytes < current ${current}; allocate a fresh slot if a smaller buffer is required.`;
    const expected = `requested >= ${current}`;
    super(
      `BufferPool: shrink not supported.\n` +
        `  code: managed-buffer-shrink-not-supported\n` +
        `  requested: ${requested}\n` +
        `  current: ${current}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { requested, current };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260515-buffer-array-vocab-collapse w11 — closed-union evolution.
//
// 4 managed-array-* error classes deleted (replaced by the 4 collapsed-vocab
// codes below); ManagedArrayElementTypeNotAllowedError preserved (still
// surfaced from defineComponent's schema parser).
//
// 2 surviving error classes:
//   - FixedSizeMismatchError              ('fixed-size-mismatch')
//   - InstanceTransformsStrideMismatchError ('instance-transforms-stride-mismatch')
//
// Naming-prefix orthogonality (plan-strategy §2.5):
//   fixed-     element-type or capacity contract violations on fixed shape
//   array-     operation failures (pop on empty) on the array vocab keyword
//   instance-  GPU-render component-specific stride contract (Instances.transforms)
//
// The array element-wise facade was removed; only write-shape and render
// stride errors remain on this boundary. The
// `instance-transforms-stride-mismatch` member is the plan-strategy §2.4
// evolution surfaced from `packages/runtime/src/render-system-extract.ts`
// defensive entry (consumed by w15 in M3, but the error class lives here so
// the EcsErrorCode union closure is owned by ECS — RhiError is not extended
// per plan-strategy §2.4 decision).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` from `world.set` when a `buffer<N>` field is
 * written with a `Uint8Array` whose `byteLength` does not equal the
 * schema-declared fixed size `N`. AI users resize their payload to exactly
 * `N` bytes (zero-pad or truncate at the producer) before calling `world.set`.
 *
 * `.code = 'fixed-size-mismatch'`
 * `.detail = { expected, actual }`
 * `.hint` — points at the producer's payload sizing.
 */
export class FixedSizeMismatchError extends Error {
  override readonly name = 'FixedSizeMismatchError';
  readonly code = 'fixed-size-mismatch' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly expected: number; readonly actual: number };

  constructor(fieldName: string, expected: number, actual: number) {
    const hint = `buffer<${expected}> set with byteLength ${actual} (expected ${expected}); resize your Uint8Array to exactly ${expected} bytes before world.set`;
    const expectedStr = `byteLength === ${expected}`;
    super(
      `buffer<N>: fixed-size mismatch.\n` +
        `  code: fixed-size-mismatch\n` +
        `  field: ${fieldName}\n` +
        `  expected: ${expected}\n` +
        `  actual: ${actual}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { expected, actual };
  }
}

/**
 * Thrown by `defineComponent` when an `array<T>` / `array<T,N>` schema field
 * carries an element type outside the legal whitelist (scalars + entity).
 * Forms like `array<unique<X>>` / `array<asset<kind>>` / `array<buffer:N>` /
 * `array<array<...>>` are rejected (AC-03 runtime fail-safe). The TS layer
 * blocks these forms at compile time; this error is the runtime backstop for
 * `as unknown as SchemaFieldType` casts.
 *
 * `.code = 'managed-array-element-type-not-allowed'`
 * `.detail = { fieldName, elementType, hint }`
 * `.hint` — lists the whitelist of legal element types.
 */
export class ManagedArrayElementTypeNotAllowedError extends Error {
  override readonly name = 'ManagedArrayElementTypeNotAllowedError';
  readonly code = 'managed-array-element-type-not-allowed' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly fieldName: string;
    readonly elementType: string;
    readonly hint: string;
  };

  constructor(fieldName: string, elementType: string) {
    const hint = `array<T> element type must be a scalar (f32/f64/i32/u32/i16/u16/i8/u8/bool/enum) or entity. unique<X> / buffer / nested array<...> are forbidden on field "${fieldName}".`;
    const expected = 'element type in {scalar | entity}';
    super(
      `managed-array: element type not allowed.\n` +
        `  code: managed-array-element-type-not-allowed\n` +
        `  field: ${fieldName}\n` +
        `  elementType: ${elementType}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { fieldName, elementType, hint };
  }
}

/** Expected operation failures, including direct store and schedule entry points. */
type CoreOperationError =
  | import('./world').EcsError
  | CyclicDependencyError
  | ResourceNotFoundError
  | ScheduleMutationError
  | SharedRefReleasedError
  | SharedRefDoubleReleaseError
  | SharedRefPayloadInvalidError
  | SharedRefStaleError
  | QueryErrors.SpawnDataUnknownFieldError
  | FieldErrors.SharedFieldInvalidValueError;

/** Closed code projection from the errors the operation owners actually expose. */
export type EcsErrorCode = CoreOperationError['code'];

type ErrorDetail<E> = E extends { readonly code: string; readonly detail: infer D }
  ? { readonly code: E['code'] } & D
  : never;

/**
 * Detached error details derive from their declaring ECS classes.
 * Memory payloads retain their own `kind` discriminator.
 */
export type EcsErrorDetail =
  | MemoryErrorDetail
  | ErrorDetail<
      | Exclude<CoreOperationError, MemoryError>
      | SparseStorageRequiresTagError
      | ManagedArrayElementTypeNotAllowedError
      | QueryErrors.QueryDescriptorConflictError
      | QueryErrors.QueryDataRequiresFieldsError
      | QueryErrors.QuerySpanUnavailableError
      | QueryErrors.QueryIterationInvalidatedError
      | QueryErrors.QueryIterationActiveError
      | BatchErrors.QueryBatchUnavailableError
    >;

/**
 * Layer-3 error envelope routed through managed-storage callbacks. Callers
 * narrow `detail` through the source-owned `EcsErrorDetail` union.
 */
export interface ManagedArrayErrorEnvelope {
  readonly code: EcsErrorCode;
  readonly hint: string;
  readonly expected: string;
  readonly detail: unknown;
}

export type CommandKind = 'spawn' | 'despawn' | 'addComponent' | 'removeComponent';

export interface CommandCommitEvidence {
  readonly index: number;
  readonly kind: CommandKind;
}

/** Expected command preflight failure, with the exact batch location. */
export class CommandFailedError extends Error {
  override readonly name = 'CommandFailedError';
  readonly code = 'command-failed' as const;
  readonly expected = 'all deferred commands pass preflight before commit';
  readonly hint =
    'Inspect detail.cause, repair the command at detail.commandIndex, and run the World again.';
  override readonly cause: unknown;
  readonly detail: {
    readonly systemName: string;
    readonly schedule: string;
    readonly commandIndex: number;
    readonly commandKind: CommandKind;
    readonly cause: unknown;
  };

  constructor(
    systemName: string,
    schedule: string,
    commandIndex: number,
    commandKind: CommandKind,
    cause: unknown,
  ) {
    super(
      `Deferred command failed before commit in ${schedule}/${systemName} ` +
        `at command ${commandIndex} (${commandKind}).`,
    );
    this.cause = cause;
    this.detail = { systemName, schedule, commandIndex, commandKind, cause };
  }
}

/** Unknown system failure. The World is poisoned because row writes may exist. */
export class SystemFailedError extends Error {
  override readonly name = 'SystemFailedError';
  readonly code = 'system-failed' as const;
  readonly expected = 'a system completes without throwing or returning a failed Result';
  readonly hint =
    'Inspect detail.cause, stop using this poisoned World, and rebuild it from the owning App.';
  override readonly cause: unknown;
  readonly detail: {
    readonly systemName: string;
    readonly schedule: string;
    readonly cause: unknown;
    readonly lastCommittedCommand: CommandCommitEvidence | null;
  };

  constructor(
    systemName: string,
    schedule: string,
    cause: unknown,
    lastCommittedCommand: CommandCommitEvidence | null = null,
  ) {
    super(`System ${schedule}/${systemName} failed; World is poisoned.`);
    this.cause = cause;
    this.detail = { systemName, schedule, cause, lastCommittedCommand };
  }
}

export {
  QueryBatchUnavailableError,
  type QueryBatchUnavailableReason,
} from './errors/query-batch-errors';
