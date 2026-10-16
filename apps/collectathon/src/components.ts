// apps/collectathon -- game-specific tag/marker components.
//
// These are zero-field marker components used to identify gameplay entities in
// system queries and CollidingEntities scans (e.g. "is this colliding entity a
// Core?" -> world.get(e, Core).ok). defineComponent self-registers globally on
// import (no per-World registration call); the empty `{}` schema is the
// canonical tag pattern (ECS types.test-d.ts: tag component has empty schema).
//
// Core / Portal hold no data here -- the scoreboard SSOT is GameProgress
// (resources.ts) and the Portal active state lives on the Portal entity via a
// separate one-field component (PortalState) so the activation flag has a single
// authoritative carrier rather than a parallel boolean.

import { defineComponent } from '@forgeax/engine-ecs';

/** Tag: a collectible Core. core-spin animates it; core-collect despawns it. */
export const Core = defineComponent('CollectathonCore', {});

/** Tag: the level exit Portal. portal-activate flips its PortalState.active. */
export const Portal = defineComponent('CollectathonPortal', {});

/**
 * The Portal's activation state (single authoritative carrier). `active` flips
 * false -> true once every Core is collected; an inactive Portal ignores player
 * arrival (boundary case). Stored on the Portal entity, read/written only by
 * portal-activate.
 */
export const PortalState = defineComponent('CollectathonPortalState', {
  active: { type: 'bool', default: false },
});

/**
 * Guardian per-entity AI state (per-entity component mode, NOT a global
 * defineState -- the global state machine is GameState Title/Play/Win/Lose).
 * Each Guardian carries its own `mode` so guardian-ai switches on it per entity:
 *   0 = patrol  (walk the waypoint loop)
 *   1 = chase   (move toward the player)
 *   2 = attack  (hold + arm the attack sensor)
 * `waypoint` is the index into the Guardian's patrol path; `timer` accumulates
 * the per-mode dwell (patrol pause / attack hold). guardian-ai is the sole writer.
 */
export const Guardian = defineComponent('CollectathonGuardian', {
  mode: { type: 'enum', default: 0 },
  waypoint: { type: 'enum', default: 0 },
  timer: { type: 'f32', default: 0 },
});

/** Guardian AI mode enum values (Guardian.mode field). */
export const GuardianModeValue = {
  patrol: 0,
  chase: 1,
  attack: 2,
} as const;

/**
 * Tag: a Guardian's attack sensor (a child sensor entity, ChildOf the Guardian).
 * The player parent's CollidingEntities lists this entity while the player is in
 * the Guardian's attack reach; guardian-hit reads `world.get(e, GuardianAttack)`
 * to recognise a hit. `armed` gates damage to the attack mode only -- guardian-ai
 * sets it true in attack mode, false otherwise, so a passing chase contact does
 * not damage (only a committed attack lands).
 */
export const GuardianAttack = defineComponent('CollectathonGuardianAttack', {
  armed: { type: 'bool', default: false },
});
