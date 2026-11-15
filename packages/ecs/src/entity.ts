// @forgeax/engine-ecs - Entity component (feat-20260602-archetype-stores-full-packed-entity M1 / w1).
//
// Entity identity is modelled as a real id=0 ECS component `Entity`, whose sole
// field `self` stores the full 32-bit packed entity handle (generation << 24 |
// index). Every archetype carries this column unconditionally; it cannot be
// removed. An entity's own handle is read through the same query / read path
// as Transform / MeshRenderer columns:
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

import { defineComponent } from './component';

/**
 * The id=0 `Entity` component. Its single `self` field carries the
 * full packed entity handle for the row it sits on (written at spawn time).
 *
 * `Entity` is the component token used by `world.get(entity, Entity)`.
 * `EntityHandle` is the branded packed number used in type annotations.
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
