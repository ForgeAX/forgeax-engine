// apps/collectathon -- collision group SSOT (plan-strategy D-1, risk R-D1).
//
// Rapier packs collision filtering into a u32: the high 16 bits are the
// collider's membership groups, the low 16 bits are the filter (which groups it
// interacts with). Two colliders A,B interact iff
//   (A.membership & B.filter) != 0  AND  (B.membership & A.filter) != 0.
//
// This file is the single place the interaction matrix is declared so Core and
// Guardian sensors never trigger each other (R-D1: a Core sensor overlapping a
// Guardian sensor must NOT register as a pickup, and vice-versa). The rule:
//   - PLAYER (the KCC body) is the only thing the pickup/hit sensors react to.
//   - CORE / GUARDIAN sensors filter to PLAYER only -- not to each other, not to
//     themselves. So CollidingEntities for the player parent contains Cores and
//     Guardians (both filter-match PLAYER), while a Core's own set never lists a
//     Guardian.
//   - LEVEL (ground + boundary walls) interacts with PLAYER for solid blocking.
//
// Membership bits (high 16) -- one bit per category:
export const GROUP_PLAYER = 1 << 0;
export const GROUP_LEVEL = 1 << 1;
export const GROUP_CORE = 1 << 2;
export const GROUP_GUARDIAN = 1 << 3;
export const GROUP_PORTAL = 1 << 4;

/** Pack a Rapier collisionGroups u32 from membership + filter 16-bit masks. */
export function packGroups(membership: number, filter: number): number {
  // >>> 0 keeps the result an unsigned 32-bit integer (the schema field is u32).
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

/** Player KCC body: member of PLAYER, collides with LEVEL + CORE + GUARDIAN + PORTAL. */
export const PLAYER_GROUPS = packGroups(
  GROUP_PLAYER,
  GROUP_LEVEL | GROUP_CORE | GROUP_GUARDIAN | GROUP_PORTAL,
);

/** Level geometry (ground + walls): member of LEVEL, collides with PLAYER. */
export const LEVEL_GROUPS = packGroups(GROUP_LEVEL, GROUP_PLAYER);

/** Core sensor: member of CORE, filters to PLAYER ONLY (never Guardian/Core). */
export const CORE_GROUPS = packGroups(GROUP_CORE, GROUP_PLAYER);

/** Guardian sensor: member of GUARDIAN, filters to PLAYER ONLY (M4 reuse). */
export const GUARDIAN_GROUPS = packGroups(GROUP_GUARDIAN, GROUP_PLAYER);

/**
 * Guardian KCC body: member of GUARDIAN, collides with LEVEL so the kinematic
 * capsule slides on the ground + boundary walls (moveAndSlide). It deliberately
 * does NOT filter PLAYER -- the player feels no solid push from the body; only
 * the attack SENSOR (GUARDIAN_GROUPS, filter PLAYER) reaches the player, and that
 * is read as an overlap (damage), never a collision response.
 */
export const GUARDIAN_BODY_GROUPS = packGroups(GROUP_GUARDIAN, GROUP_LEVEL);

/** Portal sensor: member of PORTAL, filters to PLAYER ONLY (arrival detection). */
export const PORTAL_GROUPS = packGroups(GROUP_PORTAL, GROUP_PLAYER);
