// @forgeax/engine-ecs/internal — package-owner seams that are intentionally
// absent from the public ECS barrel.
//
// This entry keeps the existing component-owner imports stable and adds the
// typed symbol used by scene propagation. A symbol avoids putting a derived
// writer method on the discoverable Query contract while still letting the
// owning package share the exact query implementation without a private path
// import or an untyped cast at each consumer.

// Keep this entry limited to owner metadata, Query and producer-lifetime capabilities.
// Raw World storage stays source-private; semantic World reads live behind the
// separate `./world-read` entry.
export {
  componentDefinition,
  componentId,
  componentSchema,
  parseManagedArraySchema,
} from './component';

import type { Result } from '@forgeax/engine-types';
import { type Component, componentId as componentIdOf } from './component';
import type { EntityHandle } from './entity-handle';
import type { QuerySpanUnavailableError } from './errors';
import type { DerivedRangeWriter } from './query/derived-range-writer';
import type { Query } from './query/query';
import type { World } from './world';
import { worldInternal } from './world-internal';

/** Capture one fixed Scene roster for ordinary table-tag transitions. */
export function prepareDisabledBatch(world: World, members: readonly EntityHandle[]) {
  const entities = new Set(members);
  return (disabled: boolean) => world[worldInternal].setDisabledBatch(entities, disabled);
}

/** Internal identity for the ECS-owned derived range writer accessor. */
export const DERIVED_WRITER: unique symbol = Symbol.for(
  'forgeax.ecs.query.derivedWriter',
) as unknown as typeof DERIVED_WRITER;

/** Read-only owner observation; the Query remains the cursor authority. */
export const QUERY_ITERATING: unique symbol = Symbol.for(
  'forgeax.ecs.query.iterating',
) as unknown as typeof QUERY_ITERATING;

export function isQueryIterating<
  R extends readonly Component[],
  W extends readonly Component[],
  O extends readonly Component[],
>(query: Query<R, W, O>): boolean {
  return (query as Query<R, W, O> & { [QUERY_ITERATING](): boolean })[QUERY_ITERATING]();
}

type DerivedWriterQuery<
  R extends readonly Component[],
  W extends readonly Component[],
  O extends readonly Component[],
> = Query<R, W, O> & {
  readonly [DERIVED_WRITER]: <C extends W[number]>(
    component: C,
  ) => Result<DerivedRangeWriter<R[number], C>, QuerySpanUnavailableError>;
};

/**
 * Resolve the ECS-owned derived writer through its internal symbol seam.
 * Consumers of this module retain the component/query type relationship while
 * the public Query and QuerySpan surfaces remain read/write-only contracts.
 */
export function getDerivedWriter<
  R extends readonly Component[],
  W extends readonly Component[],
  O extends readonly Component[],
  C extends W[number],
>(
  query: Query<R, W, O>,
  component: C,
): Result<DerivedRangeWriter<R[number], C>, QuerySpanUnavailableError> {
  const internalQuery = query as DerivedWriterQuery<R, W, O>;
  return internalQuery[DERIVED_WRITER](component);
}

/**
 * Flag one entity's component as changed without writing its value, so
 * `changed` queries and change epochs observe it. Returns false, writing
 * nothing, when the entity does not have the component.
 */
export function markComponentChanged(
  world: World,
  entity: EntityHandle,
  component: Component,
): boolean {
  return world[worldInternal].markComponentChanged(entity, componentIdOf(component));
}

export { releaseUnadoptedUniqueRef } from './producer-refs';
export type {
  DerivedColumnBinding,
  DerivedRangeCursor,
  DerivedRangeWriter,
} from './query/derived-range-writer';
export type { EntityLookup, EntityLookupColumns } from './query/entity-lookup';
export { createEntityLookup } from './query/entity-lookup';
export type { ArrayStore } from './storage/array-store';
