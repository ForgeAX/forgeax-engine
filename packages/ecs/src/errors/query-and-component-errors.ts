/**
 * Returned via `Result.err` from `world.removeComponent` when the caller tries
 * to remove an essential (undeletable) component
 * (feat-20260602-archetype-stores-full-packed-entity M1 / w3, plan-strategy
 * D-3). The only essential component today is the id=0 `Entity` component: every
 * archetype carries it unconditionally as the row's own packed handle, so
 * removing it is structurally meaningless. The code name is deliberately
 * generic (`remove-essential-component`, not entity-specific) so a future second
 * essential component reuses it without a rename.
 *
 * `.code = 'remove-essential-component'`
 * `.detail = { componentName }`
 * `.hint` — names the essential component + states it cannot be removed.
 */
export class RemoveEssentialComponentError extends Error {
  override readonly name = 'RemoveEssentialComponentError';
  readonly code = 'remove-essential-component' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly componentName: string };

  constructor(componentName: string) {
    const hint = `Component "${componentName}" is essential (every entity carries it unconditionally) and cannot be removed. Despawn the entity instead if you want to retire it.`;
    const expected = 'non-essential component';
    super(
      `removeComponent: essential component cannot be removed.\n` +
        `  code: remove-essential-component\n` +
        `  component: ${componentName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { componentName };
  }
}

/**
 * Returned via the `Result` err branch when `instantiate` encounters a
 * SceneAsset entity whose `components` map references a component name that was
 * never passed to `defineComponent`.
 *
 * `.code = 'component-not-defined'`
 * `.detail.name` — the offending component name.
 *
 * Promoting this to a class (rather than a bare object literal) keeps the
 * scene-instantiate failure surface inside the `EcsError` class union, so the
 * documented two-level narrow `cause instanceof EcsError` actually matches it
 * (docs/feedbacks/2026-06-03 §6.2 Tier 4.2). `expected` / `hint` accept
 * per-call overrides because the parent-passthrough (ChildOf) site needs a
 * distinct message from the generic entity-component site.
 */
export class ComponentNotDefinedError extends Error {
  override readonly name = 'ComponentNotDefinedError';
  readonly code = 'component-not-defined' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly name: string };

  constructor(componentName: string, opts?: { expected?: string; hint?: string }) {
    const expected = opts?.expected ?? `component '${componentName}' defined before instantiate`;
    const hint =
      opts?.hint ??
      `define the component via defineComponent('${componentName}', ...) before instantiating this SceneAsset`;
    super(
      `instantiate: component not defined.\n` +
        `  code: component-not-defined\n` +
        `  component: ${componentName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { name: componentName };
  }
}

/**
 * Returned via `Result.err` from `world.spawn` / `world.addComponent` /
 * `world.instantiateScene` / `Commands.spawn` when the caller-supplied
 * data payload carries a key that is not declared in the target component's
 * schema. The pre-fix behaviour silently dropped unknown keys inside
 * `fillComponentDefaults` (which walked schema keys, never raw keys), so a
 * typo like `MeshRenderer { material: h }` (singular legacy field name; the
 * current schema has `materials: array<...>`) produced an empty-defaults row
 * + an invisible / mid-grey entity downstream. Surfacing the typo at the
 * spawn boundary collapses a class of "renders wrong, looks like a graphics
 * bug" reports into a single explicit error.
 *
 * `.code = 'spawn-data-unknown-field'`
 * `.detail = { component, field, knownFields }`
 * `.hint` — names the offending field and lists the schema's known fields.
 */
export class SpawnDataUnknownFieldError extends Error {
  override readonly name = 'SpawnDataUnknownFieldError';
  readonly code = 'spawn-data-unknown-field' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly component: string;
    readonly field: string;
    readonly knownFields: readonly string[];
  };

  constructor(componentName: string, fieldName: string, knownFields: readonly string[]) {
    const sortedKnown = [...knownFields].sort();
    const expected = `field name in {${sortedKnown.join(', ')}}`;
    const hint =
      `'${fieldName}' is not a schema field of '${componentName}'. ` +
      `Known fields: ${sortedKnown.join(', ')}. ` +
      `Check for a typo or a stale single-vs-plural rename (e.g. 'material' vs 'materials').`;
    super(
      `${componentName}: spawn data carries unknown field.\n` +
        `  code: spawn-data-unknown-field\n` +
        `  component: ${componentName}\n` +
        `  field: ${fieldName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component: componentName, field: fieldName, knownFields: sortedKnown };
  }
}
export type QuerySpanUnavailableReason =
  | 'optional-data'
  | 'sparse-component'
  | 'relationship-component';

export class QueryDescriptorConflictError extends Error {
  override readonly name = 'QueryDescriptorConflictError';
  readonly code = 'query-descriptor-conflict' as const;
  readonly expected = 'each component occupies one descriptor role';
  readonly hint: string;
  readonly detail: { readonly componentName: string; readonly roles: readonly string[] };

  constructor(componentName: string, roles: readonly string[]) {
    const hint = `Remove ${componentName} from all but one of: ${roles.join(', ')}.`;
    super(`Query descriptor roles conflict for ${componentName}.\n  hint: ${hint}`);
    this.hint = hint;
    this.detail = { componentName, roles };
  }
}

export class QueryDataRequiresFieldsError extends Error {
  override readonly name = 'QueryDataRequiresFieldsError';
  readonly code = 'query-data-requires-fields' as const;
  readonly expected = 'a component with at least one data field';
  readonly hint: string;
  readonly detail: { readonly componentName: string };

  constructor(componentName: string) {
    const hint = `Move tag ${componentName} to with or without.`;
    super(`Query data access requires fields on ${componentName}.\n  hint: ${hint}`);
    this.hint = hint;
    this.detail = { componentName };
  }
}

export class QuerySpanUnavailableError extends Error {
  override readonly name = 'QuerySpanUnavailableError';
  readonly code = 'query-span-unavailable' as const;
  readonly expected = 'a descriptor whose rows form contiguous table ranges';
  readonly hint = 'Use row iteration or split the query.';
  readonly detail: { readonly reason: QuerySpanUnavailableReason };

  constructor(reason: QuerySpanUnavailableReason) {
    super(`Query spans are unavailable: ${reason}.\n  hint: Use row iteration or split the query.`);
    this.detail = { reason };
  }
}

export class QueryIterationInvalidatedError extends Error {
  override readonly name = 'QueryIterationInvalidatedError';
  readonly code = 'query-iteration-invalidated' as const;
  readonly expected: string;
  readonly hint = 'Use deferred Commands for structural mutation, then restart iteration.';
  readonly detail: {
    readonly expectedStructureEpoch: number;
    readonly actualStructureEpoch: number;
  };

  constructor(expectedStructureEpoch: number, actualStructureEpoch: number) {
    const expected = `structure epoch ${expectedStructureEpoch}`;
    super(
      `Query iteration was invalidated by structure epoch ${actualStructureEpoch}.\n  hint: ${'Use deferred Commands for structural mutation, then restart iteration.'}`,
    );
    this.expected = expected;
    this.detail = { expectedStructureEpoch, actualStructureEpoch };
  }
}

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
