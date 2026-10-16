// @forgeax/engine-ecs - Entity component (feat-20260602-archetype-stores-full-packed-entity M1 / w1).
//
// Entity identity is modelled as a real id=0 ECS component `Entity`, whose sole
// field `self` stores the full 32-bit packed entity handle (generation << 24 |
// index). Every archetype carries this column unconditionally (it is essential
// and cannot be removed), so an entity's own handle is read through the exact
// same query / read path as Transform / MeshRenderer columns:
//
//   const query = world.query({ read: [Transform] }).unwrap();
//   for (const row of query) row.entity;
//   world.get(e, Entity).unwrap().self === e
//
// This retires the "entity is an archetype side-array + three-step rebuild"
// implementation detail (index slot -> generation lookup -> encodeEntity) in
// favour of a single uniform column read.
//
// id=0 structural guarantee: `Entity` MUST be the first `defineComponent`
// evaluated in the process so the owner identity assigns it 0. The package
// barrel (packages/ecs/src/index.ts) force-evaluates this module before any
// other component-defining module and asserts the invariant fail-fast.
// See plan-strategy D-1 / D-6b (LP-1): the hard-coded 0 + barrel forced
// registration + startup throw is the locked design; no UECS-style runtime
// token lookup is introduced (the hot-path archetype column key stays a numeric
// owner-assigned component identity).
//
// charter mapping: P4 (consistent abstraction -- reading the entity handle is
// reading any other column) + P3 (id=0 drift surfaces as a structured startup
// throw, never a silent runtime mis-id) + P1 (single top-level import surface).

import type { ComponentId } from './component';
import { componentId, defineComponent } from './component';

/**
 * The id=0 essential `Entity` component. Its single `self` field carries the
 * full packed entity handle for the row it sits on (written at spawn time).
 *
 * Naming convention (feat-20260611-ecs-storage-naming-ssot):
 *
 *   - Value-space `Entity` (this const) is the id=0 component token. It is
 *     looked up by name (`'Entity'`) at component-registration time and used
 *     as a value (`world.spawn`, `world.get(entity, Entity)`).
 *   - Type-space `EntityHandle` (the branded number, exported from `../entity`)
 *     is the row-identifier handle type. It is used in `: EntityHandle`
 *     annotations.
 *
 * The two no longer share a name -- the prior intentional coexistence (a
 * single `Entity` symbol carrying both meanings via TS namespace merging) was
 * dropped because two-roles-one-name created repeated AI-user confusion when
 * reading `: Entity` annotations (is this the handle or the token?). The id=0
 * component token's name (the literal string `'Entity'`) is preserved for
 * runtime stability; only the type-space alias was renamed.
 *
 * @example Read an entity's own handle through a query:
 *   const query = world.query({ read: [Transform] }).unwrap();
 *   for (const row of query) {
 *     const handle = row.entity;
 *   }
 *
 * @example Use `world.get` as a general liveness probe:
 *   const r = world.get(e, Entity);
 *   if (!r.ok) { // r.error.code === 'stale-entity' for a despawned handle
 *   }
 */
export const Entity = defineComponent('Entity', {
  // Layer-2 default is never observed: `world.spawn` always overwrites `self`
  // with the freshly encoded handle for the row. `null` is the type-correct
  // "no handle yet" placeholder (`'entity'` decodes to `EntityHandle | null`).
  self: { type: 'entity', default: null },
});

/**
 * Marks an entity as disabled.
 *
 * Queries exclude this tag by default. Add `Disabled` to a query's `with`
 * tuple when the query must inspect or re-enable disabled entities.
 */
export const Disabled = defineComponent('Disabled', {});

/**
 * SSOT for component ids that are essential to every archetype. Every archetype
 * carries the columns named by these ids unconditionally (they cannot be added
 * or removed via `addComponent` / `removeComponent`). Currently only `Entity`
 * is essential -- the row-identity column that lets every entity read its own
 * packed handle (`world.get(e, Entity).self === e`) through the same column
 * path as any other component (feat-20260602 / charter P4).
 *
 * Frozen so consumers cannot mutate the SSOT. The barrel
 * (`packages/ecs/src/index.ts`) re-exports this constant so the AI-facing
 * `import { ESSENTIAL_COMPONENT_IDS } from '@forgeax/engine-ecs'` works.
 *
 * Physical location is `packages/ecs/src/entity.ts` -- the module that owns
 * the `defineComponent('Entity', ...)` call, so reading the owner identity
 * immediately after registration is well-defined. tweak-20260612-ecs-concept-
 * compression lifted this file back from the historical `components/entity.ts`
 * after `entity-handle.ts` freed up the `entity.ts` slot.
 */
export const ESSENTIAL_COMPONENT_IDS: ReadonlyArray<ComponentId> = Object.freeze([
  componentId(Entity),
]);

/**
 * Fold the essential component ids (currently `[componentId(Entity)]`) into a caller-
 * supplied id list. Returns a NEW array; never mutates the input.
 *
 *   - If `ids` already contains every essential id, returns a deduped copy
 *     (idempotent under repeated folding).
 *   - Otherwise, returns `[...essential, ...ids]` with duplicates of the
 *     essential ids removed.
 *
 * The empty input maps to `[componentId(Entity)]` -- the bare-archetype shape that a
 * `world.spawn()` (no components) materialises.
 *
 * Single SSOT consumed by both `archetypeKey` (string-key fold) and
 * `createArchetype` (column-build fold) so the two sites can never disagree
 * on which ids are essential. Hot-path correctness is on `createArchetype`'s
 * side: misalignment between key and columns silently drops fields.
 *
 * @example
 *   foldEssentials([2, 5, 7])              // [componentId(Entity), 2, 5, 7]
 *   foldEssentials([componentId(Entity), 2, 5]) // [componentId(Entity), 2, 5]
 *   foldEssentials([componentId(Entity), componentId(Entity)]) // [componentId(Entity)]
 *   foldEssentials([])                     // [componentId(Entity)]
 */
export function foldEssentials(ids: ReadonlyArray<ComponentId>): ComponentId[] {
  const seen = new Set<ComponentId>();
  const out: ComponentId[] = [];
  for (const essential of ESSENTIAL_COMPONENT_IDS) {
    if (!seen.has(essential)) {
      seen.add(essential);
      out.push(essential);
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
