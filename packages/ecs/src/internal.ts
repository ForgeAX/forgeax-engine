// @forgeax/engine-ecs/internal — package-owner seams that are intentionally
// absent from the public ECS barrel.
//
// This entry keeps the existing component-owner imports stable and adds the
// typed symbol used by scene propagation. A symbol avoids putting a derived
// writer method on the discoverable Query contract while still letting the
// owning package share the exact query implementation without a private path
// import or an untyped cast at each consumer.

// Keep this entry limited to package-owner metadata and the derived writer.
// Raw World storage stays source-private; semantic World reads live behind the
// separate `./world-read` entry.
export { componentId, componentSchema } from './component';
export { componentDefinition } from './component-schema';

import type { Result } from '@forgeax/engine-types';
import type { Component } from './component';
import type { QuerySpanUnavailableError } from './errors';
import type { DerivedRangeWriter } from './query/derived-range-writer';
import type { Query } from './query/query';

/** Internal identity for the ECS-owned derived range writer accessor. */
export const DERIVED_WRITER: unique symbol = Symbol.for(
  'forgeax.ecs.query.derivedWriter',
) as unknown as typeof DERIVED_WRITER;

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

export type {
  DerivedColumnBinding,
  DerivedRangeCursor,
  DerivedRangeRowCommit,
  DerivedRangeRowProbe,
  DerivedRangeWriter,
} from './query/derived-range-writer';
