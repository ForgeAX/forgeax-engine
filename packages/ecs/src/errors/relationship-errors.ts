// ────────────────────────────────────────────────────────────────────────────
// feat-20260531-ecs-relationship-abstraction-bidirectional-sync M2 — closed-
// union evolution +4 (plan-strategy D-5). Adds 4 `relationship-*` kebab codes
// (27 -> 31, add-only minor per AGENTS.md Error model evolution contract):
//
//   - relationship-self-cycle                       (cycle / ancestor walk hit)
//   - relationship-mirror-component-not-registered  (defineComponent gate a)
//   - relationship-mirror-field-type-mismatch       (defineComponent gate b)
//   - relationship-detach-mismatch                  (removeChild parent arg mismatch)
//
// `relationship-exclusive-violation` is intentionally NOT a member: exclusive
// re-add is an automatic reparent (a success path, D-1 style), not an error.
// Every detail object is a discriminated payload narrowed via EcsErrorDetail.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` from `world.addChild` / `world.reparent` (M3) when
 * a hierarchy write would form a cycle — either the child is its own parent
 * (self-loop) or the proposed parent is already a descendant of the child
 * (ancestor-walk hit). The `.detail` carries both the offending child entity
 * and the ancestor entity that closed the cycle so AI users can locate the
 * loop without re-walking the graph.
 *
 * `.code = 'relationship-self-cycle'`
 * `.detail = { component, entity, ancestor }`
 * `.hint` — names the child + ancestor that would close the cycle.
 */
export class RelationshipSelfCycleError extends Error {
  override readonly name = 'RelationshipSelfCycleError';
  readonly code = 'relationship-self-cycle' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly component: string;
    readonly entity: number;
    readonly ancestor: number;
  };

  constructor(component: string, entity: number, ancestor: number) {
    const hint = `Linking entity ${entity} via "${component}" would close a cycle through ancestor ${ancestor}. Reparent to an entity that is not a descendant of ${entity}.`;
    const expected = 'acyclic parent chain';
    super(
      `relationship: cycle detected.\n` +
        `  code: relationship-self-cycle\n` +
        `  component: ${component}\n` +
        `  entity: ${entity}\n` +
        `  ancestor: ${ancestor}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component, entity, ancestor };
  }
}

/**
 * Thrown by `defineComponent` (feat-20260602 M2) when a component declares a
 * `relationship.mirror` naming a component that has not yet been defined
 * (AC-09). AI users defineComponent the mirror before the holder (mirror-then-
 * holder order).
 *
 * The `.code` literal `relationship-mirror-component-not-registered` is kept
 * unchanged across the M2 migration (deliberate terminology trade-off:
 * external `.code` stability over wording precision); only the `.hint` text
 * drops the register/registered phrasing in favour of defineComponent ordering
 * guidance.
 *
 * `.code = 'relationship-mirror-component-not-registered'`
 * `.detail = { component, mirror }`
 * `.hint` — names the holder + the undefined mirror component.
 */
export class RelationshipMirrorComponentNotRegisteredError extends Error {
  override readonly name = 'RelationshipMirrorComponentNotRegisteredError';
  readonly code = 'relationship-mirror-component-not-registered' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly component: string; readonly mirror: string };

  constructor(component: string, mirror: string) {
    const hint = `Component "${component}" declares relationship.mirror = "${mirror}", but "${mirror}" has not been defined yet. defineComponent the mirror component before the holder (define them in mirror-then-holder order).`;
    const expected = `mirror component "${mirror}" registered`;
    super(
      `relationship: mirror component not registered.\n` +
        `  code: relationship-mirror-component-not-registered\n` +
        `  component: ${component}\n` +
        `  mirror: ${mirror}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component, mirror };
  }
}

/**
 * Thrown by `defineComponent` (feat-20260602 M2) when the
 * `relationship.field` on the mirror component is missing or its schema type
 * is not the only legal back-reference storage shape `array<entity>`
 * (AC-11 b). AI users declare the mirror field as `'array<entity>'`.
 *
 * `.code = 'relationship-mirror-field-type-mismatch'`
 * `.detail = { component, mirror, field, actualType }`
 * `.hint` — names the holder + mirror field + the type observed.
 */
export class RelationshipMirrorFieldTypeMismatchError extends Error {
  override readonly name = 'RelationshipMirrorFieldTypeMismatchError';
  readonly code = 'relationship-mirror-field-type-mismatch' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly component: string;
    readonly mirror: string;
    readonly field: string;
    readonly actualType: string;
  };

  constructor(component: string, mirror: string, field: string, actualType: string) {
    const hint = `Component "${component}" mirror "${mirror}".${field} has type "${actualType}"; the reverse-list field must be declared as 'array<entity>'.`;
    const expected = "mirror field type === 'array<entity>'";
    super(
      `relationship: mirror field type mismatch.\n` +
        `  code: relationship-mirror-field-type-mismatch\n` +
        `  component: ${component}\n` +
        `  mirror: ${mirror}\n` +
        `  field: ${field}\n` +
        `  actualType: ${actualType}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component, mirror, field, actualType };
  }
}

/**
 * Returned via `Result.err` from `world.removeChild` (M3) when the `parent`
 * argument does not match the child's current relationship parent (the child
 * lacks the relationship component, or it points at a different parent). The
 * `.detail` carries the expected (argument) parent + the actual current parent
 * so AI users can reconcile their model.
 *
 * `.code = 'relationship-detach-mismatch'`
 * `.detail = { component, child, expectedParent, actualParent }`
 *   `actualParent === ENTITY_NULL_RAW` (0) signals the child has no relationship.
 * `.hint` — names the child + the parent mismatch.
 */
export class RelationshipDetachMismatchError extends Error {
  override readonly name = 'RelationshipDetachMismatchError';
  readonly code = 'relationship-detach-mismatch' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly component: string;
    readonly child: number;
    readonly expectedParent: number;
    readonly actualParent: number;
  };

  constructor(component: string, child: number, expectedParent: number, actualParent: number) {
    const hint = `removeChild(${expectedParent}, ${child}) via "${component}": child's current parent is ${actualParent}, not ${expectedParent}. Detach from the actual parent or re-read the current relationship.`;
    const expected = `child's "${component}" parent === ${expectedParent}`;
    super(
      `relationship: detach parent mismatch.\n` +
        `  code: relationship-detach-mismatch\n` +
        `  component: ${component}\n` +
        `  child: ${child}\n` +
        `  expectedParent: ${expectedParent}\n` +
        `  actualParent: ${actualParent}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component, child, expectedParent, actualParent };
  }
}

/** Returned when callers attempt to mutate an engine-maintained target list. */
export class RelationshipTargetReadonlyError extends Error {
  override readonly name = 'RelationshipTargetReadonlyError';
  readonly code = 'component-field-invalid-value' as const;
  readonly expected = 'relationship source mutation';
  readonly hint: string;
  readonly detail: {
    readonly component: string;
    readonly operation: string;
  };

  constructor(component: string, operation: string) {
    const hint = `Component "${component}" is an engine-maintained relationship target. Mutate its source component instead of ${operation}.`;
    super(`[RelationshipTargetReadonlyError component-field-invalid-value] ${hint}`);
    this.hint = hint;
    this.detail = { component, operation };
  }
}
