// @forgeax/engine-physics — CollisionEvent ECS Event token placeholder.
//
// Emitted by physics tick systems during the Writeback phase.
// Two states only: 'started' (new contact) and 'stopped' (separated).
// No 'continued' event — use CollidingEntities component for ongoing contacts
// (plan-strategy D-3).

import type { Vec3 } from '@forgeax/engine-math';

/**
 * Collision event payload — per-contact-pair event emitted during Writeback.
 *
 * `type: 'started'` — two colliders just began touching.
 * `type: 'stopped'` — two colliders just separated.
 */
export interface CollisionEventPayload {
  type: 'started' | 'stopped';
  entityA: number;
  entityB: number;
  contactPoint: Vec3;
  contactNormal: Vec3;
}

/**
 * CollisionEvent constant — identifies the collision event type.
 * Backend systems push CollisionEventPayload instances into the event queue
 * during the Writeback phase; user systems drain via query.
 *
 * The backing ECS event infrastructure (Event<T> generic + world.drainEvent)
 * is deferred to a future feat. For M1, this is a type-only contract.
 */
export const CollisionEvent = '__CollisionEvent__' as const;

/** Type-level identifier for the CollisionEvent event channel. */
export type CollisionEvent = typeof CollisionEvent;
