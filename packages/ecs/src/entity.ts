// Entity is an unconditional id=0 component carrying the full packed handle.
// The root entry checks this reserved identity directly.

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
