// @forgeax/engine-assets-runtime — scene-handle-fields: shared reflection helper for
// SceneAsset handle-field extraction (plan-strategy D-4 / requirements B-5).
//
// `buildSceneChildContext` (breadcrumb)
// consume this helper so the "identify shared<...> / array<shared<...>> schema
// fields + read GUID string" logic has exactly one authoritative location
// (Derive, Don't Duplicate).
//
// This helper returns raw GUID strings WITHOUT mutating the registry; resolution
// to Handle numbers is the caller's responsibility.
//
// Both consumers prefer the structured `envelope.refs` edges (D-3) when an
// envelope is catalogued for the scene, and fall back to this entity-component
// walk only when no envelope (or no per-entity edge detail) is available:
//  - `buildSceneChildContext`: prod GUID-only refs[] edges whose `sourceField`
//    was stripped at the serialization boundary (w7 D-10), plus direct
//    `catalog()` scene registration with no refs. The walk recovers the
//    (entityKey, componentName, fieldName, arrayIndex) triple the bare
//    edge no longer carries.

import type { Component } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';

/**
 * A single handle-field reference extracted from a SceneAsset entity.
 *
 * `entityKey` is the stable keyed SceneAsset identity; `componentName` and `fieldName`
 * identify the schema field whose `fieldType` starts with `shared\<` or
 * `array\<shared\<`. `guidString` is the raw GUID string value from the
 * entity's component data (NOT a parsed `AssetGuid` — callers parse or
 * resolve as needed).
 *
 * `arrayIndex` is `undefined` for plain `handle<T>` fields; for
 * `array<handle<T>>` fields it is the 0-based index into the array.
 */
export interface SceneHandleFieldEntry {
  readonly entityKey: string;
  readonly componentName: string;
  readonly fieldName: string;
  readonly guidString: string;
  /** 0-based index for `array<handle<T>>` elements; `undefined` for plain `handle<T>` fields. */
  readonly arrayIndex?: number;
}

/**
 * Shape of one keyed entity passed to {@link extractSceneEntityHandleGuids}.
 */
interface SceneEntityLike {
  readonly components: Partial<Record<string, Record<string, unknown>>>;
}

/**
 * Walk every `SceneEntityLike` in `entities` and extract all GUID strings
 * bound to schema fields with `handle<...>` or `array<handle<...>>` fieldType.
 *
 * Unknown component names (absent from the supplied World-local catalog) are
 * silently skipped — the ecs layer's `additionalProperties` check will catch
 * unknowns at spawn time if appropriate.
 *
 * Values that are already numbers (resolved Handles) or non-strings are
 * skipped (they are not GUID refs).
 *
 * @internal Shared by `buildSceneChildContext` as the entity-walk fallback used when the structured
 * `envelope.refs` edges are unavailable or carry no per-entity detail.
 */
export function extractSceneEntityHandleGuids(
  components: ReadonlyMap<string, Component>,
  entities: Readonly<Record<string, SceneEntityLike>>,
): SceneHandleFieldEntry[] {
  const entries: SceneHandleFieldEntry[] = [];

  for (const [entityKey, node] of Object.entries(entities)) {
    const rawComponents: Record<string, Record<string, unknown>> = node.components as Record<
      string,
      Record<string, unknown>
    >;

    for (const compName of Object.keys(rawComponents)) {
      const rawFields = rawComponents[compName];
      if (!rawFields) continue;

      const comp = components.get(compName);
      if (!comp) continue;

      for (const fieldName of Object.keys(rawFields)) {
        forEachHandleGuid(
          componentSchema(comp)[fieldName],
          rawFields[fieldName],
          (guidString, arrayIndex) => {
            entries.push({
              entityKey,
              componentName: compName,
              fieldName,
              guidString,
              ...(arrayIndex !== undefined ? { arrayIndex } : {}),
            });
          },
        );
      }
    }
  }

  return entries;
}

/**
 * Shared handle-GUID identification core (feat-20260713 M3 / w12 SSOT): given a
 * schema `fieldType` and a `value`, invoke `sink(guidString, arrayIndex?)` for
 * every GUID string the field binds — once for a `shared<T>` scalar string, once
 * per string element of an `array<shared<T>>`. Non-shared fields, non-string
 * scalars, and non-string array elements (already-resolved handle numbers, D-8)
 * are skipped. Both the entity walk and the override walk route through here so
 * the "is this a shared handle field + read its GUID" logic has one home
 * (architecture-principles §1 SSOT).
 */
function forEachHandleGuid(
  fieldType: string | undefined,
  value: unknown,
  sink: (guidString: string, arrayIndex?: number) => void,
): void {
  if (fieldType === undefined || typeof fieldType !== 'string') return;
  if (fieldType.startsWith('shared<')) {
    if (typeof value === 'string') sink(value);
    return;
  }
  if (fieldType.startsWith('array<shared<') && Array.isArray(value)) {
    for (let elemIdx = 0; elemIdx < value.length; elemIdx++) {
      const elem = value[elemIdx];
      if (typeof elem === 'string') sink(elem, elemIdx);
    }
  }
}
