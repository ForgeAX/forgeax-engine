import type { Component, ComponentStorage, FieldReflection } from './component';
import type { RelationshipRole } from './relationship-index';

/**
 * Serialization facts owned beside schema registration, not carried by the
 * public component token. Queries and storage only need the token's schema
 * vocabulary; domain validation and lifecycle belong to their owners.
 */
export interface ComponentPolicy {
  readonly transient: boolean;
  readonly meta: Record<string, unknown>;
  /** Components that are materialized whenever this component is added. */
  readonly requires: readonly Component[];
}

/** Immutable schema reflection plus non-token policy projection. */
export interface ComponentDefinition {
  readonly fieldNames: readonly string[];
  readonly fields: Readonly<Record<string, FieldReflection>>;
  readonly defaults: Readonly<Record<string, unknown>> | undefined;
  readonly policy: ComponentPolicy;
}

// Component tokens can cross independently bundled ECS entry points. Share
// the owner registry through globalThis rather than attaching a hidden symbol
// to each token; `Reflect.ownKeys(token)` must remain exactly the three public
// facts name/fields/storage.
const COMPONENT_REGISTRY = Symbol.for('forgeax.ecs.componentRegistry');
interface ComponentRegistry {
  readonly definitions: WeakMap<object, ComponentDefinition>;
  readonly relationships: WeakMap<Component, RelationshipRole>;
}
const globalSymbols = globalThis as typeof globalThis & { [key: symbol]: unknown };
const definitions =
  (globalSymbols[COMPONENT_REGISTRY] as ComponentRegistry | undefined) ??
  (() => {
    const registry: ComponentRegistry = {
      definitions: new WeakMap<object, ComponentDefinition>(),
      relationships: new WeakMap<Component, RelationshipRole>(),
    };
    globalSymbols[COMPONENT_REGISTRY] = registry;
    return registry;
  })();

/** Relationship policy follows the same token identity across ECS module instances. */
export const componentRelationshipRoles = definitions.relationships;

export function registerComponentDefinition(
  component: Component,
  definition: Omit<ComponentDefinition, 'fieldNames'>,
): void {
  definitions.definitions.set(
    component,
    Object.freeze({
      ...definition,
      fieldNames: Object.freeze(Object.keys(definition.fields)),
    }),
  );
}

/** Read the definition-time schema/policy projection for a component token. */
export function componentDefinition(component: Component): ComponentDefinition {
  const definition = definitions.definitions.get(component);
  if (definition === undefined) {
    throw new Error(`Component definition missing for '${component.name}'.`);
  }
  return definition;
}

/** Read the generic structural requirements declared by one component. */
export function componentRequirements(component: Component): readonly Component[] {
  // Keep invalid/foreign tokens on the ordinary preflight error path. The
  // expansion helper runs before validation, so it must not turn a structured
  // `component-not-defined` Result into an uncaught registry exception.
  return definitions.definitions.get(component)?.policy.requires ?? [];
}

type ComponentDataLike = {
  readonly component: Component;
  readonly data: Partial<Record<string, unknown>>;
};

/**
 * Expand component requirements once at the structural boundary.
 *
 * Explicit component data wins and is never duplicated. Requirements are
 * appended in declaration order, and the same identity set also terminates a
 * malformed dependency cycle without a per-frame scan.
 */
export function expandComponentRequirements<T extends ComponentDataLike>(
  componentDatas: readonly T[],
): T[] {
  let hasRequirements = false;
  for (const entry of componentDatas) {
    if (componentRequirements(entry.component).length !== 0) {
      hasRequirements = true;
      break;
    }
  }
  // Most structural operations use components without dependencies. Preserve
  // that path without copying or allocating a Set; callers only consume the
  // returned list and never mutate it.
  if (!hasRequirements) return componentDatas as T[];

  const expanded = [...componentDatas];
  const seen = new Set<Component>(expanded.map((entry) => entry.component));
  for (let index = 0; index < expanded.length; index++) {
    const component = expanded[index]?.component;
    if (component === undefined) continue;
    for (const required of componentRequirements(component)) {
      if (seen.has(required)) continue;
      seen.add(required);
      expanded.push({ component: required, data: {} } as T);
    }
  }
  return expanded;
}

/**
 * Freeze a schema value recursively.  Component descriptors are authored data,
 * so nested defaults and enum label maps must not become mutation channels.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value as Readonly<T>;
  }
  // Non-empty TypedArrays reject Object.freeze and their indexed elements
  // remain writable even when the wrapper is frozen. Treat binary views as
  // immutable leaf projections; the authored descriptor around them is still
  // recursively frozen by this function.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value as Readonly<T>;
  }
  const object = value as object;
  for (const key of Reflect.ownKeys(object)) {
    const child = (object as Record<PropertyKey, unknown>)[key];
    if (child !== null && (typeof child === 'object' || typeof child === 'function')) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value) as Readonly<T>;
}

export function assertComponentStorage(value: string): asserts value is ComponentStorage {
  if (value !== 'table' && value !== 'sparse') {
    throw new Error(`Unsupported component storage '${value}'. Expected 'table' or 'sparse'.`);
  }
}
