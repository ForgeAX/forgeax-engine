import type { AssetError } from '@forgeax/engine-types';

class EcsFault<const C extends string, const D, const N extends string> extends Error {
  protected declare readonly ecsFaultIdentity: void;
  constructor(
    override readonly name: N,
    readonly code: C,
    message: string,
    readonly hint: string,
    readonly expected: string,
    readonly detail: D,
  ) {
    super(`[${code}] ${message}\n  expected: ${expected}\n  hint: ${hint}`);
  }
}

import type { SharedKernelEligibilityReason, WorldExecutionState } from './execution/shared-kernel';
import type { MemoryError, MemoryErrorDetail } from './memory-types';

class DetailError<D> extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly expected: string,
    readonly detail: D,
  ) {
    super(`${message}\n  expected: ${expected}\n  hint: ${hint}`);
  }
}
class RangeDetailError<D> extends RangeError {
  constructor(
    message: string,
    readonly hint: string,
    readonly expected: string,
    readonly detail: D,
  ) {
    super(`${message}\n  expected: ${expected}\n  hint: ${hint}`);
  }
}

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
      'unique<T>, shared<T>, asset<kind>, array<T>, or array<T,N>. ' +
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

export function createSparseStorageRequiresTagError(componentName: string) {
  return new EcsFault(
    'SparseStorageRequiresTagError',
    'sparse-storage-requires-tag',
    `Sparse component "${componentName}" must be a zero-field, non-relationship tag.`,
    'remove all fields and relationship metadata, or use storage: table',
    'sparse components have an empty schema and no relationship metadata',
    { componentName },
  );
}
export type SparseStorageRequiresTagError = ReturnType<typeof createSparseStorageRequiresTagError>;

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
export function createCyclicDependencyError(cycle: readonly string[]) {
  const cycleStr = cycle.join(' -> ');
  const hint = `Cycle path: ${cycleStr}. Remove one ordering constraint to break the cycle.`;
  return new EcsFault(
    'CyclicDependencyError',
    'cyclic-dependency',
    `DAG Schedule has a cyclic dependency.`,
    hint,
    'the schedule dependency graph is acyclic',
    { code: 'cyclic-dependency' as const, cycle },
  );
}
export type CyclicDependencyError = ReturnType<typeof createCyclicDependencyError>;

/** Ordering referenced an unregistered system set in this schedule. */
export function createSystemSetNotRegisteredError(name: string, registered: readonly string[]) {
  const hint =
    `SystemSet "${name}" is not valid for the current World schedule. ` +
    `Pass a non-empty SystemSet token owned by this World schedule.`;
  const message =
    `SystemSet "${name}" is not registered.\n` +
    `  expected: ${name}\n` +
    `  registered: [${registered.join(', ')}]\n` +
    `  hint: ${hint}`;
  return new EcsFault(
    'SystemSetNotRegisteredError',
    'system-set-not-registered',
    message,
    hint,
    name,
    { code: 'system-set-not-registered' as const, name, registered },
  );
}
export type SystemSetNotRegisteredError = ReturnType<typeof createSystemSetNotRegisteredError>;

/**
 * Factory for {@link SystemSetNotRegisteredError}. Consumed by
 * {@link validateSystemSetTokens} (w4) and the two mutation entry points.
 */
export function systemSetNotRegistered(
  name: string,
  registered: readonly string[],
): SystemSetNotRegisteredError {
  return createSystemSetNotRegisteredError(name, registered);
}

/** Closed schedule-mutation failures. */
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

export class ChangeEpochExhaustedError extends DetailError<{ readonly epoch: number }> {
  override readonly name = 'ChangeEpochExhaustedError';
  readonly code = 'change-epoch-exhausted' as const;

  constructor(epoch: number) {
    super(
      `World mutation epoch is exhausted at ${epoch}.`,
      'Rebuild the World before performing another mutation.',
      'mutationEpoch < Number.MAX_SAFE_INTEGER',
      { epoch },
    );
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

export function createDerivedRangeOutOfBoundsError(
  start: number,
  count: number,
  spanLength: number,
) {
  return new EcsFault(
    'DerivedRangeOutOfBoundsError',
    'derived-range-out-of-bounds',
    `Derived range [${start}, ${start + count}) exceeds QuerySpan length ${spanLength}.`,
    'check start and count against the QuerySpan length, then retry without changing World state',
    'a non-negative span-relative range with start + count <= span.length',
    { start, count, spanLength },
  );
}
export type DerivedRangeOutOfBoundsError = ReturnType<typeof createDerivedRangeOutOfBoundsError>;

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
export function createUniqueRefReleasedError(handle: number, target: string) {
  const hint = `Handle ${handle} (target ${target}) was released before this access. Re-acquire via the producing system or re-spawn the asset before reading.`;
  const expected = 'live (refcount >= 1) managed handle';
  return new EcsFault(
    'UniqueRefReleasedError',
    'unique-ref-released',
    'UniqueRefStore: handle is already released.',
    hint,
    expected,
    { handle, target },
  );
}
export type UniqueRefReleasedError = ReturnType<typeof createUniqueRefReleasedError>;

/**
 * Thrown / returned via `Result.err` when UniqueRefStore.release is called on
 * a handle whose refcount is already zero (double-free).
 *
 * `.code = 'unique-ref-double-release'`
 * `.detail = { handle, target }`
 * `.hint` — recommends auditing the release-loop entry points (set / removeComponent / despawn).
 */
export function createUniqueRefDoubleReleaseError(handle: number, target: string) {
  const hint = `Handle ${handle} (target ${target}) was released twice. Only one of {despawn / removeComponent / set} should release a managed handle per lifecycle.`;
  const expected = 'first release of a managed handle (refcount transition 1 -> 0)';
  return new EcsFault(
    'UniqueRefDoubleReleaseError',
    'unique-ref-double-release',
    'UniqueRefStore: double release on handle.',
    hint,
    expected,
    { handle, target },
  );
}
export type UniqueRefDoubleReleaseError = ReturnType<typeof createUniqueRefDoubleReleaseError>;
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

/**
 * Thrown / returned via `Result.err` when SharedRefStore.resolve / .retain is
 * called on a handle whose refcount has already dropped to zero (slot released).
 *
 * `.code = 'shared-ref-released'`
 * `.detail = { handle, target }`
 * `.hint` — recommends checking handle lifetime against owner / consumer release.
 */
export function createSharedRefReleasedError(handle: number, target: string) {
  const hint = `Handle ${handle} (target ${target}) was released (refcount reached 0). Re-acquire via the producing system or re-spawn the asset before reading.`;
  const expected = 'live (refcount >= 1) shared handle';
  return new EcsFault(
    'SharedRefReleasedError',
    'shared-ref-released',
    'SharedRefStore: handle is already released.',
    hint,
    expected,
    { handle, target },
  );
}
export type SharedRefReleasedError = ReturnType<typeof createSharedRefReleasedError>;

/** Release attempted on an already released shared reference. */
export function createSharedRefDoubleReleaseError(handle: number, target: string, rc: number) {
  const hint = `Handle ${handle} (target ${target}) released with rc=${rc}. Each shared handle must have a matching alloc/retain for every release; audit the producer / consumer release pairs.`;
  const expected = 'rc >= 1 before release';
  return new EcsFault(
    'SharedRefDoubleReleaseError',
    'shared-ref-double-release',
    'SharedRefStore: double release on handle.',
    hint,
    expected,
    { handle, target, rc },
  );
}
export type SharedRefDoubleReleaseError = ReturnType<typeof createSharedRefDoubleReleaseError>;

/** Raised before SharedRefStore mutates slot state for a nullish payload. */
export function createSharedRefPayloadInvalidError(target: string, actual: 'null' | 'undefined') {
  return new EcsFault(
    'SharedRefPayloadInvalidError',
    'shared-ref-payload-invalid',
    `SharedRefStore: ${actual} payload is not a valid shared reference for ${target}.`,
    'Allocate a concrete payload and let its owning effect dispose it.',
    'a non-null, non-undefined shared payload',
    { target, actual },
  );
}
export type SharedRefPayloadInvalidError = ReturnType<typeof createSharedRefPayloadInvalidError>;

/** Generation mismatch in SharedRefStore; the slot may now belong to another payload. */
export class SharedRefStaleError extends DetailError<{
  readonly slot: number;
  readonly expectedGeneration: number;
  readonly actualGeneration: number;
}> {
  override readonly name = 'SharedRefStaleError';
  readonly code = 'shared-ref-stale' as const;

  constructor(slot: number, expectedGeneration: number, actualGeneration: number) {
    const hint = `Handle for slot ${slot} is stale: expected generation ${expectedGeneration}, but the store has generation ${actualGeneration} (slot was released and re-allocated). Re-acquire the handle from AssetRegistry.`;
    const expected = `generation === ${actualGeneration} (current store generation)`;
    super('SharedRefStore: stale handle.', hint, expected, {
      slot,
      expectedGeneration,
      actualGeneration,
    });
  }
}

/** Generation mismatch in UniqueRefStore; the slot may now belong to another payload. */
export class UniqueRefStaleError extends DetailError<{
  readonly slot: number;
  readonly expectedGeneration: number;
  readonly actualGeneration: number;
}> {
  override readonly name = 'UniqueRefStaleError';
  readonly code = 'unique-ref-stale' as const;

  constructor(slot: number, expectedGeneration: number, actualGeneration: number) {
    const hint = `Handle for slot ${slot} is stale: expected generation ${expectedGeneration}, but the store has generation ${actualGeneration} (slot was released and re-allocated). Re-acquire the handle via the producing system or re-spawn the asset.`;
    const expected = `generation === ${actualGeneration} (current store generation)`;
    super('UniqueRefStore: stale handle.', hint, expected, {
      slot,
      expectedGeneration,
      actualGeneration,
    });
  }
}

/** A buffer access or allocation exceeds its admitted bounds. */
export class ManagedBufferOutOfBoundsError extends RangeDetailError<{
  readonly index: number;
  readonly size: number;
}> {
  override readonly name = 'ManagedBufferOutOfBoundsError';
  readonly code = 'managed-buffer-out-of-bounds' as const;

  constructor(index: number, size: number) {
    const hint = `Index ${index} is outside [0, ${size}). Check the field's array declaration matches the access pattern.`;
    const expected = `index in [0, ${size})`;
    super('Managed storage: index out of bounds.', hint, expected, { index, size });
  }
}

/** An array schema declares an element type outside the closed vocabulary. */
export function createManagedArrayElementTypeNotAllowedError(
  fieldName: string,
  elementType: string,
) {
  const hint = `array<T> element type must be a scalar (f32/f64/i32/u32/i16/u16/i8/u8/bool/enum) or entity. unique<X> / buffer / nested array<...> are forbidden on field "${fieldName}".`;
  const expected = 'element type in {scalar | entity}';
  return new EcsFault(
    'ManagedArrayElementTypeNotAllowedError',
    'managed-array-element-type-not-allowed',
    'managed-array: element type not allowed.',
    hint,
    expected,
    {
      fieldName,
      elementType,
      hint,
    },
  );
}
export type ManagedArrayElementTypeNotAllowedError = ReturnType<
  typeof createManagedArrayElementTypeNotAllowedError
>;

/**
 * Union of all EcsError types that World methods can return via Result.
 * AI users: switch on `.code` for programmatic branching.
 */
export type EcsError =
  | TimeScaleInvalidError
  | TimeScaleLeaseReleasedError
  | MemoryError
  | AssetError
  | ArrayRangeOutOfBoundsError
  | CommandFailedError
  | StaleEntityError
  | ComponentNotPresentError
  | ComponentAlreadyPresentError
  | ComponentFieldInvalidValueError
  | ManagedArrayInvalidValueError
  | SharedFieldInvalidValueError
  | SpawnDataUnknownFieldError
  | UniqueRefReleasedError
  | UniqueRefDoubleReleaseError
  | UniqueRefStaleError
  | ManagedBufferOutOfBoundsError
  | RelationshipSelfCycleError
  | RelationshipDetachMismatchError
  | RelationshipTargetReadonlyError
  | ComponentNotDefinedError
  | RemoveEntityComponentError
  | SystemSetNotRegisteredError
  | SystemFailedError
  | TimeDeltaInvalidError
  | TimeConfigInvalidError
  | ScheduleScopeMismatchError
  | SharedKernelEligibilityError
  | SharedKernelFailureError
  | DerivedRangeOutOfBoundsError
  | DerivedWriteActiveError
  | ChangeEpochExhaustedError
  | WorldPoisonedError;

/** Expected operation failures, including direct store and schedule entry points. */
type CoreOperationError =
  | EcsError
  | CyclicDependencyError
  | ResourceNotFoundError
  | ScheduleMutationError
  | SharedRefReleasedError
  | SharedRefDoubleReleaseError
  | SharedRefPayloadInvalidError
  | SharedRefStaleError
  | SpawnDataUnknownFieldError
  | SharedFieldInvalidValueError;

/** Closed code projection from the errors the operation owners actually expose. */
export type EcsErrorCode = CoreOperationError['code'];

type ErrorDetail<E> = E extends { readonly code: string; readonly detail: infer D }
  ? { readonly code: E['code'] } & D
  : never;

/**
 * Detached error details derive from their declaring ECS classes.
 * Memory payloads retain their own `kind` discriminator.
 */
type DetailedEcsError =
  | Exclude<CoreOperationError, MemoryError>
  | SparseStorageRequiresTagError
  | ManagedArrayElementTypeNotAllowedError
  | QueryDescriptorConflictError
  | QueryDataRequiresFieldsError
  | QuerySpanUnavailableError
  | QueryIterationInvalidatedError
  | QueryIterationActiveError
  | QueryBatchUnavailableError;

export type EcsErrorDetail = MemoryErrorDetail | ErrorDetail<DetailedEcsError>;

export type CommandKind = 'spawn' | 'despawn' | 'addComponent' | 'removeComponent';

export interface CommandCommitEvidence {
  readonly index: number;
  readonly kind: CommandKind;
}

/** Expected command preflight failure, with the exact batch location. */
export function createCommandFailedError(
  systemName: string,
  schedule: string,
  commandIndex: number,
  commandKind: CommandKind,
  cause: unknown,
) {
  return Object.assign(
    new EcsFault(
      'CommandFailedError',
      'command-failed',
      `Deferred command failed before commit in ${schedule}/${systemName} at command ${commandIndex} (${commandKind}).`,
      'Inspect detail.cause, repair the command at detail.commandIndex, and run the World again.',
      'all deferred commands pass preflight before commit',
      { systemName, schedule, commandIndex, commandKind, cause },
    ),
    { cause: cause } as const,
  );
}
export type CommandFailedError = ReturnType<typeof createCommandFailedError>;

/** Unknown system failure. The World is poisoned because row writes may exist. */
export function createSystemFailedError(
  systemName: string,
  schedule: string,
  cause: unknown,
  lastCommittedCommand: CommandCommitEvidence | null = null,
) {
  return Object.assign(
    new EcsFault(
      'SystemFailedError',
      'system-failed',
      `System ${schedule}/${systemName} failed; World is poisoned.`,
      'Inspect detail.cause, stop using this poisoned World, and rebuild it from the owning App.',
      'a system completes without throwing or returning a failed Result',
      { systemName, schedule, cause, lastCommittedCommand },
    ),
    { cause: cause } as const,
  );
}
export type SystemFailedError = ReturnType<typeof createSystemFailedError>;

/** Rejects removal of the Entity identity column. */
export class RemoveEntityComponentError extends Error {
  override readonly name = 'RemoveEntityComponentError';
  // Published error-code spelling; changing it requires a version boundary.
  readonly code = 'remove-essential-component' as const;
  readonly hint =
    'Entity stores the entity identity and cannot be removed. Despawn the entity instead.';
  readonly expected = 'a component other than Entity';
  readonly detail = { componentName: 'Entity' } as const;

  constructor() {
    super('removeComponent: Entity cannot be removed.');
  }
}

/** A serialized component name is absent from the supplied component catalog. */
export class ComponentNotDefinedError extends DetailError<{ readonly name: string }> {
  override readonly name = 'ComponentNotDefinedError';
  readonly code = 'component-not-defined' as const;

  constructor(componentName: string, opts?: { expected?: string; hint?: string }) {
    const expected = opts?.expected ?? `component '${componentName}' defined before instantiate`;
    const hint =
      opts?.hint ??
      `define the component via defineComponent('${componentName}', ...) before instantiating this SceneAsset`;
    super('instantiate: component not defined.', hint, expected, { name: componentName });
  }
}

/** Spawn/add/set input contains an undeclared field. Keys are checked before storage mutation. */
export function createSpawnDataUnknownFieldError(
  componentName: string,
  fieldName: string,
  knownFields: readonly string[],
) {
  const sortedKnown = [...knownFields].sort();
  const expected = `field name in {${sortedKnown.join(', ')}}`;
  const hint =
    `'${fieldName}' is not a schema field of '${componentName}'. ` +
    `Known fields: ${sortedKnown.join(', ')}. ` +
    `Check for a typo or a stale single-vs-plural rename (e.g. 'material' vs 'materials').`;
  return new EcsFault(
    'SpawnDataUnknownFieldError',
    'spawn-data-unknown-field',
    `${componentName}: spawn data carries unknown field.`,
    hint,
    expected,
    {
      component: componentName,
      field: fieldName,
      knownFields: sortedKnown,
    },
  );
}
export type SpawnDataUnknownFieldError = ReturnType<typeof createSpawnDataUnknownFieldError>;
export type QuerySpanUnavailableReason =
  | 'optional-data'
  | 'sparse-component'
  | 'relationship-component';

export function createQueryDescriptorConflictError(
  componentName: string,
  roles: readonly string[],
) {
  const hint = `Remove ${componentName} from all but one of: ${roles.join(', ')}.`;
  return new EcsFault(
    'QueryDescriptorConflictError',
    'query-descriptor-conflict',
    `Query descriptor roles conflict for ${componentName}.`,
    hint,
    'each component occupies one descriptor role',
    { componentName, roles },
  );
}
export type QueryDescriptorConflictError = ReturnType<typeof createQueryDescriptorConflictError>;

export function createQueryDataRequiresFieldsError(componentName: string) {
  const hint = `Move tag ${componentName} to with or without.`;
  return new EcsFault(
    'QueryDataRequiresFieldsError',
    'query-data-requires-fields',
    `Query data access requires fields on ${componentName}.`,
    hint,
    'a component with at least one data field',
    { componentName },
  );
}
export type QueryDataRequiresFieldsError = ReturnType<typeof createQueryDataRequiresFieldsError>;

export function createQuerySpanUnavailableError(reason: QuerySpanUnavailableReason) {
  return new EcsFault(
    'QuerySpanUnavailableError',
    'query-span-unavailable',
    `Query spans are unavailable: ${reason}.`,
    'Use row iteration or split the query.',
    'a descriptor whose rows form contiguous table ranges',
    { reason },
  );
}
export type QuerySpanUnavailableError = ReturnType<typeof createQuerySpanUnavailableError>;

export function createQueryIterationInvalidatedError(
  expectedStructureEpoch: number,
  actualStructureEpoch: number,
) {
  const expected = `structure epoch ${expectedStructureEpoch}`;
  return new EcsFault(
    'QueryIterationInvalidatedError',
    'query-iteration-invalidated',
    `Query iteration was invalidated by structure epoch ${actualStructureEpoch}.`,
    'Use deferred Commands for structural mutation, then restart iteration.',
    expected,
    { expectedStructureEpoch, actualStructureEpoch },
  );
}
export type QueryIterationInvalidatedError = ReturnType<
  typeof createQueryIterationInvalidatedError
>;

export class QueryIterationActiveError extends Error {
  override readonly name = 'QueryIterationActiveError';
  readonly code = 'query-iteration-active' as const;
  readonly expected = 'one active iterator per Query';
  readonly hint = 'Complete the active iterator or create an independent Query.';
  readonly detail = {};

  constructor() {
    super('Query already has an active iterator.\n  hint: Complete it before iterating again.');
  }
}

export type QueryBatchUnavailableReason =
  | 'write-access'
  | 'temporal-filter'
  | 'undeclared-component'
  | 'unknown-field'
  | 'non-numeric-field'
  | 'missing-required-data'
  | 'expired-batch';

/** The read-only physical batch boundary rejects unsupported access explicitly. */
export class QueryBatchUnavailableError extends DetailError<{
  readonly reason: QueryBatchUnavailableReason;
  readonly componentName?: string;
  readonly fieldName?: string;
}> {
  override readonly name = 'QueryBatchUnavailableError';
  readonly code = 'query-batch-unavailable' as const;

  constructor(reason: QueryBatchUnavailableReason, componentName?: string, fieldName?: string) {
    super(
      `Query batch access is unavailable: ${reason}.`,
      'Use read/optional numeric fields within this batch; use existing rows or spans for write/temporal descriptors.',
      'a live read-only batch and a declared inline numeric field',
      {
        reason,
        ...(componentName === undefined ? {} : { componentName }),
        ...(fieldName === undefined ? {} : { fieldName }),
      },
    );
  }
}
/** A relationship edge would violate the pair's self/cycle policy. */
export function createRelationshipSelfCycleError(
  component: string,
  entity: number,
  ancestor: number,
) {
  const hint = `Linking entity ${entity} via "${component}" would close a cycle through ancestor ${ancestor}. Reparent to an entity that is not a descendant of ${entity}.`;
  const expected = 'acyclic parent chain';
  return new EcsFault(
    'RelationshipSelfCycleError',
    'relationship-self-cycle',
    'relationship: cycle detected.',
    hint,
    expected,
    { component, entity, ancestor },
  );
}
export type RelationshipSelfCycleError = ReturnType<typeof createRelationshipSelfCycleError>;

/** The supplied parent differs from the child's current relationship target. */
export function createRelationshipDetachMismatchError(
  component: string,
  child: number,
  expectedParent: number,
  actualParent: number,
) {
  const hint = `removeChild(${expectedParent}, ${child}) via "${component}": child's current parent is ${actualParent}, not ${expectedParent}. Detach from the actual parent or re-read the current relationship.`;
  const expected = `child's "${component}" parent === ${expectedParent}`;
  return new EcsFault(
    'RelationshipDetachMismatchError',
    'relationship-detach-mismatch',
    'relationship: detach parent mismatch.',
    hint,
    expected,
    {
      component,
      child,
      expectedParent,
      actualParent,
    },
  );
}
export type RelationshipDetachMismatchError = ReturnType<
  typeof createRelationshipDetachMismatchError
>;

/** Returned when callers attempt to mutate an engine-maintained target list. */
export function createRelationshipTargetReadonlyError(component: string, operation: string) {
  const hint = `Component "${component}" is an engine-maintained relationship target. Mutate its source component instead of ${operation}.`;
  return new EcsFault(
    'RelationshipTargetReadonlyError',
    'component-field-invalid-value',
    `[RelationshipTargetReadonlyError component-field-invalid-value] ${hint}`,
    hint,
    'relationship source mutation',
    { component, operation },
  );
}
export type RelationshipTargetReadonlyError = ReturnType<
  typeof createRelationshipTargetReadonlyError
>;

export function createSharedKernelEligibilityError(
  kernelName: string,
  reason: SharedKernelEligibilityReason,
) {
  return new EcsFault(
    'SharedKernelEligibilityError',
    'shared-kernel-ineligible',
    `Shared kernel "${kernelName}" is ineligible: ${reason}.`,
    'export a named function from the kernel module and use only dense numeric QuerySpan columns',
    'a module-loadable named kernel with one or more numeric QuerySpan read/write declarations',
    { kernelName, reason },
  );
}
export type SharedKernelEligibilityError = ReturnType<typeof createSharedKernelEligibilityError>;

export function createSharedKernelFailureError(
  kernelName: string,
  worldIdentity: string,
  cause: unknown,
  partialWrite: boolean,
) {
  return new EcsFault(
    'SharedKernelFailureError',
    'shared-kernel-failed',
    `Shared kernel "${kernelName}" failed; World ${worldIdentity} is poisoned.`,
    'do not retry this World; inspect detail.cause and rebuild with a new World identity',
    'every dispatched shard completes without a possible partial write',
    { kernelName, worldIdentity, cause, partialWrite, retryable: false },
  );
}
export type SharedKernelFailureError = ReturnType<typeof createSharedKernelFailureError>;

export function createWorldPoisonedError(worldIdentity: string, fault: unknown) {
  return new EcsFault(
    'WorldPoisonedError',
    'world-poisoned',
    `World ${worldIdentity} is poisoned and cannot update.`,
    'stop scheduling this World and explicitly bootstrap a new World identity',
    'World health is healthy before update',
    { worldIdentity, fault },
  );
}
export type WorldPoisonedError = ReturnType<typeof createWorldPoisonedError>;

/** The single poisoned-World fence: the structured error to refuse with, or undefined when healthy. */
export function worldPoisonedError(state: WorldExecutionState): WorldPoisonedError | undefined {
  return state.health === 'poisoned'
    ? createWorldPoisonedError(state.identity, state.fault)
    : undefined;
}

/** A shared scalar or array element is not a resolved numeric handle.
 * The optional index identifies an invalid array element; assets use their separate owner. */
export function createSharedFieldInvalidValueError(
  componentName: string,
  fieldName: string,
  fieldType: string,
  actualValue: unknown,
  index?: number,
) {
  const at = index === undefined ? '' : `[${index}]`;
  const expected = `a resolved numeric Handle for shared field '${fieldName}${at}'`;
  const hint =
    `'${fieldName}${at}' on '${componentName}' is a ${fieldType} reference; ` +
    `got ${typeof actualValue} (${JSON.stringify(actualValue)}). ` +
    `Allocate non-asset resources with world.allocSharedRef(target, value). ` +
    `Managed assets use asset<kind> fields and assets.load(guid, kind) or assets.create(value).`;
  return new EcsFault(
    'SharedFieldInvalidValueError',
    'shared-field-invalid-value',
    `${componentName}.${fieldName}${at}: shared field bound to a non-handle value.`,
    hint,
    expected,
    index === undefined
      ? { component: componentName, field: fieldName, fieldType, actualValue }
      : { component: componentName, field: fieldName, fieldType, actualValue, index },
  );
}
export type SharedFieldInvalidValueError = ReturnType<typeof createSharedFieldInvalidValueError>;

export function createTimeDeltaInvalidError(received: number) {
  return new EcsFault(
    'TimeDeltaInvalidError',
    'time-delta-invalid',
    `Invalid world.update delta: ${received}.`,
    'Call world.update(deltaSeconds) with a finite non-negative delta.',
    'a finite delta greater than or equal to 0',
    { received },
  );
}
export type TimeDeltaInvalidError = ReturnType<typeof createTimeDeltaInvalidError>;

export function createTimeConfigInvalidError(detail: {
  readonly fixedDeltaSeconds: number;
  readonly maxStepsPerUpdate: number;
  readonly maxDeltaSeconds: number;
}) {
  const expected = 'maxDeltaSeconds >= (maxStepsPerUpdate + 1) * fixedDeltaSeconds';
  return new EcsFault(
    'TimeConfigInvalidError',
    'time-config-invalid',
    `Invalid World time policy.`,
    'Increase maxDeltaSeconds or decrease maxStepsPerUpdate or fixedDeltaSeconds.',
    expected,
    detail,
  );
}
export type TimeConfigInvalidError = ReturnType<typeof createTimeConfigInvalidError>;

export function createScheduleScopeMismatchError(
  sourceSchedule: string,
  targetSchedule: string,
  reference?: string,
) {
  const expected = `a reference owned by ${sourceSchedule}`;
  const hint = `The referenced item belongs to ${targetSchedule}; register and order it in ${sourceSchedule}.`;
  return new EcsFault(
    'ScheduleScopeMismatchError',
    'schedule-scope-mismatch',
    `Schedule scope mismatch.`,
    hint,
    expected,
    {
      sourceSchedule,
      targetSchedule,
      ...(reference ? { reference } : {}),
    },
  );
}
export type ScheduleScopeMismatchError = ReturnType<typeof createScheduleScopeMismatchError>;

/**
 * Returned when a closed enum field receives a value outside its reflected
 * labels. The write owner runs this before any archetype or column mutation.
 */
export function createComponentFieldInvalidValueError(
  entity: number | undefined,
  component: string,
  field: string,
  received: unknown,
  allowedValues: Readonly<Record<string, number>>,
) {
  const entries = Object.entries(allowedValues)
    .map(([label, value]) => `${label}=${value}`)
    .join(', ');
  const expected = `${component}.${field} in { ${entries} }`;
  const hint = `Set ${component}.${field} to one of the reflected enum values: ${entries}`;
  return new EcsFault(
    'ComponentFieldInvalidValueError',
    'component-field-invalid-value',
    `${component}.${field} received an invalid enum value.`,
    hint,
    expected,
    {
      entity,
      component,
      field,
      received,
      allowedValues,
    },
  );
}
export type ComponentFieldInvalidValueError = ReturnType<
  typeof createComponentFieldInvalidValueError
>;

/**
 * Returned before an ECS write when a managed `array<T>` field receives a
 * value that the storage boundary cannot interpret as an array payload. The
 * old column writer treated arbitrary objects as an empty payload, which
 * silently changed the row while retaining no evidence of the caller error.
 */
export function createManagedArrayInvalidValueError(
  componentName: string,
  fieldName: string,
  fieldType: string,
  actualValue: unknown,
) {
  const hint =
    `Set ${componentName}.${fieldName} to a plain array or TypedArray matching ` +
    `${fieldType}; use null or undefined to clear the managed value.`;
  return new EcsFault(
    'ManagedArrayInvalidValueError',
    'managed-array-invalid-value',
    `${componentName}.${fieldName}: managed array received an invalid value.`,
    hint,
    'an Array or TypedArray payload (or null/undefined to clear it)',
    { component: componentName, field: fieldName, fieldType, actualValue },
  );
}
export type ManagedArrayInvalidValueError = ReturnType<typeof createManagedArrayInvalidValueError>;

/**
 * Returned by `World.setArrayRange` when the written window does not fit the
 * field's current length, or the field is not a numeric array. The write
 * never resizes: a range write that would grow the array must use `set`.
 */
export class ArrayRangeOutOfBoundsError extends RangeDetailError<{
  readonly component: string;
  readonly field: string;
  readonly offset: number;
  readonly length: number;
  readonly size: number;
}> {
  override readonly name = 'ArrayRangeOutOfBoundsError';
  readonly code = 'array-range-out-of-bounds' as const;

  constructor(
    componentName: string,
    fieldName: string,
    offset: number,
    length: number,
    size: number,
  ) {
    const expected = `an integer offset with offset + length <= ${size}`;
    const hint =
      size < 0
        ? `${componentName}.${fieldName} is not a numeric array field; use world.set for it.`
        : `Write within [0, ${size}) of ${componentName}.${fieldName}, or use world.set to resize the array.`;
    super(
      `${componentName}.${fieldName}: range [${offset}, ${offset + length}) is outside the array.`,
      hint,
      expected,
      { component: componentName, field: fieldName, offset, length, size },
    );
  }
}

type FactoryFault = Extract<DetailedEcsError, EcsFault<string, unknown, string>>;
/** Distinguish an owner-produced expected failure from an arbitrary thrown value. */
export function isEcsFault<C extends FactoryFault['code']>(
  cause: unknown,
  code: C,
): cause is Extract<FactoryFault, { readonly code: C }> {
  return cause instanceof EcsFault && cause.code === code;
}

export class TimeScaleInvalidError extends Error {
  override readonly name = 'TimeScaleInvalidError';
  readonly code = 'time-scale-invalid' as const;
  readonly expected = 'a finite scale greater than or equal to 0';
  readonly hint = 'Pass a finite non-negative scale to World.acquireTimeScale or lease.set.';
  readonly detail: { readonly received: number };
  constructor(received: number) {
    super(`Invalid time scale: ${received}`);
    this.detail = { received };
  }
}
export class TimeScaleLeaseReleasedError extends Error {
  override readonly name = 'TimeScaleLeaseReleasedError';
  readonly code = 'time-scale-lease-released' as const;
  readonly expected = 'an active time scale lease';
  readonly hint = 'Acquire a new lease; released contributions cannot be reactivated.';
  readonly detail = {};
  constructor() {
    super('Cannot change a released time scale lease.');
  }
}
