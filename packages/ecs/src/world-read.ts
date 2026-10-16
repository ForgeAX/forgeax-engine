// @forgeax/engine-ecs — safe read-only World seam.
//
// This is the only cross-package World capability needed by relationship and
// scene projections. It exposes semantic scalar/array reads, never the table,
// archetype, buffer-pool, or mutation stores behind those reads.

import type { Component } from './component';
import type { EntityHandle } from './entity-handle';

/** Stable identity for the World-owned semantic read capability. */
export const worldRead: unique symbol = Symbol.for('forgeax.ecs.worldRead');

/**
 * Read-only semantic probes used by owner packages such as scene.
 *
 * Missing entities, components, fields, and out-of-range elements return
 * `undefined`; callers never receive a storage object or mutable view.
 */
export interface WorldRead {
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
}
