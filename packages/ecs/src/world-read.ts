// @forgeax/engine-ecs — safe read-only World seam.
//
// This is the only cross-package World capability needed by relationship and
// scene projections. It exposes semantic scalar/array reads, never the table,
// archetype, backing allocator, or mutation stores behind those reads.

import type {
  Component,
  ComponentSchema,
  InputShapeOf,
  ScalarFieldType,
  TypedArrayFor,
} from './component';
import type { EntityHandle } from './entity-handle';
import type { RemovedComponentsCursor } from './removed-components';

export type { RemovedComponentsCursor } from './removed-components';

/** Stable identity for the World-owned semantic read capability. */
export const worldRead: unique symbol = Symbol.for('forgeax.ecs.worldRead');

/**
 * Read-only semantic probes used by owner packages such as scene.
 *
 * Missing entities, components, fields, and out-of-range elements return
 * `undefined`; callers never receive a storage object or mutable view.
 */
export interface WorldRead {
  /** Check one source/index/mirror edge through its existing backpointer. */
  readonly hasRelationshipEdge: (
    component: Component,
    source: EntityHandle,
    target: EntityHandle,
  ) => boolean;
  /** Existing source-relationship index revision; unindexed components return zero. */
  readonly getRelationshipEpoch: (component: Component) => number;
  /** Last mutation epoch that wrote this entity's component; absent or untracked returns zero. */
  readonly getChangedEpoch: (entity: EntityHandle, component: Component) => number;
  /** Last epoch at which any entity's value of this component was written; untouched returns zero. */
  readonly getComponentEpoch: (component: Component) => number;
  /** Epoch at which this entity gained the component; absent returns zero. */
  readonly getAddedEpoch: (entity: EntityHandle, component: Component) => number;
  /** Global mutation epoch; equal values across two reads mean no write happened between them. */
  readonly getMutationEpoch: () => number;
  /**
   * Visit entities that lost the component (removal or despawn) since this
   * cursor's previous read. Events are retained for two `World.update()` calls;
   * the first read of a component starts its stream.
   */
  readonly readRemoved: (
    component: Component,
    cursor: RemovedComponentsCursor,
    visit: (entity: EntityHandle) => void,
  ) => void;
  /** Compare the supplied fields at their stored precision. Only differing fields
   * are returned for one ordinary World.set. Missing storage returns the original
   * input so the write owner can report its normal error. */
  readonly changedFields: <S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
    input: Partial<InputShapeOf<S>>,
  ) => Partial<InputShapeOf<S>> | undefined;
  readonly getFieldValue: (
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ) => number | undefined;
  readonly getArrayLength: (
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ) => number | undefined;
  readonly getArrayElement: (
    entity: EntityHandle,
    component: Component,
    fieldName: string,
    index: number,
  ) => number | undefined;
  /** Compare a numeric input with the stored row at its declared precision, without borrowing a view. */
  readonly arrayEquals: (
    entity: EntityHandle,
    component: Component,
    fieldName: string,
    values: ArrayLike<number>,
  ) => boolean;
  /** Copy a whole numeric array into caller-owned output, preserving its remaining tail.
   * Returns its logical count, or undefined without writing for absence / insufficient capacity.
   * Inline columns need no transient view; overlapping typed output retains native copy semantics.
   */
  readonly copyArray: (
    entity: EntityHandle,
    component: Component,
    fieldName: string,
    target: TypedArrayFor<ScalarFieldType> | number[],
  ) => number | undefined;
}
