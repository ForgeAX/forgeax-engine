// apps/collectathon -- guardian-hit: Guardian attack hit detection + Health
// decrement (plan-strategy D-1 sensor + CollidingEntities, AC-15 hit -> Health--,
// AC-18 Health SSOT single writer, requirements boundary: multi-Guardian
// same-frame hits never dropped).
//
// Per frame the system reads the player parent's CollidingEntities set (entities
// whose colliders overlap the player), keeps only ARMED Guardian attack sensors
// (guardian-ai arms a sensor only in attack mode -- a chase fly-by deals no
// damage), runs them through a PER-ATTACKER invulnerability filter, then for each
// admitted attacker subtracts 1 from GameProgress.health.
//
// This is the SOLE GameProgress.health writer (AC-18) -- grep `applyDamage` finds
// the only health mutation in the game (resources.ts only declares the field +
// the factory; no system other than this one calls applyDamage).
//
// The invul window is per-attacker (keyed by the attack-sensor entity, stamped
// with GameProgress.elapsed): so (a) two DIFFERENT Guardians landing the same
// frame both damage -- no hit dropped (boundary), while (b) the SAME Guardian
// holding contact every frame within GUARDIAN_INVUL_SECONDS does not drain health
// per-frame. The cooldown map lives in the system closure (per-run state).
//
// resolveHits / applyDamage / admitHits are pure so the decision logic is gated
// (guardian-hit.test.ts, m4-1); the system fn wires them to the live
// CollidingEntities + GameProgress + the elapsed clock.

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { CollidingEntities } from '@forgeax/engine-physics';

import { GuardianAttack } from '../components';
import { GAME_PROGRESS_KEY, type GameProgress } from '../resources';

/** Per-attacker invulnerability window (seconds) after a Guardian lands a hit. */
export const GUARDIAN_INVUL_SECONDS = 1.0;

/**
 * From a set of colliding entity handles, keep only the ones the
 * `isAttackSensor` predicate accepts (the real system passes
 * e => world.get(e, GuardianAttack).armed === true). Accepts a plain number[] or
 * the Uint32Array that CollidingEntities.entities exposes at runtime. Mirrors
 * core-collect.resolveCollisions.
 */
export function resolveHits(
  colliding: ReadonlyArray<number> | Uint32Array,
  isAttackSensor: (entity: number) => boolean,
): number[] {
  const hits: number[] = [];
  for (let i = 0; i < colliding.length; i++) {
    const e = colliding[i];
    if (e !== undefined && isAttackSensor(e)) hits.push(e);
  }
  return hits;
}

/**
 * The single GameProgress.health writer (AC-18): subtract `n` from health in
 * place, clamped at 0 (never negative), and return the same progress object.
 */
export function applyDamage(progress: GameProgress, n: number): GameProgress {
  progress.health = Math.max(0, progress.health - n);
  return progress;
}

/**
 * Per-attacker invulnerability filter (multi-Guardian boundary). Given the
 * candidate attacker entities, the cooldown map (attacker -> last-hit elapsed),
 * and the current elapsed clock, return the attackers admitted this frame and
 * stamp each admitted attacker's last-hit time into `invul` in place.
 *
 * - A first-time attacker (no record) is admitted + stamped.
 * - An attacker outside its window (now - last >= GUARDIAN_INVUL_SECONDS) is
 *   re-admitted + re-stamped.
 * - An attacker still inside its window is suppressed and its record is NOT
 *   re-stamped (so the window measures from the FIRST hit, not the latest touch).
 *
 * Distinct attackers are independent: two fresh Guardians the same frame both
 * pass, so no hit is dropped.
 */
export function admitHits(
  attackers: ReadonlyArray<number>,
  invul: Map<number, number>,
  nowElapsed: number,
): number[] {
  const admitted: number[] = [];
  for (const a of attackers) {
    const last = invul.get(a);
    if (last === undefined || nowElapsed - last >= GUARDIAN_INVUL_SECONDS) {
      invul.set(a, nowElapsed);
      admitted.push(a);
    }
  }
  return admitted;
}

/**
 * Build the guardian-hit system bound to the player parent entity (whose
 * CollidingEntities set is read each frame). Factory form mirrors core-collect:
 * the captured player handle + the per-run invulnerability map cannot be reached
 * from the descriptor fn (world only).
 *
 * Two guards keep the early-frame window safe: a missing GameProgress resource
 * (before OnEnter inserts it) and a missing CollidingEntities component (before
 * the first physics tick writes it) both no-op rather than throw.
 */
export function createGuardianHitSystem(player: EntityHandle): SystemHandle<readonly []> {
  // attack-sensor entity -> GameProgress.elapsed at last admitted hit.
  const invul = new Map<number, number>();
  return defineSystem({
    name: 'guardian-hit',
    after: ['guardian-ai'],
    queries: [],
    fn: (world: World) => {
      if (!world.hasResource(GAME_PROGRESS_KEY)) return;
      const colliding = world.get(player, CollidingEntities);
      if (!colliding.ok) return;

      const armedHits = resolveHits(colliding.value.entities, (e) => {
        const ga = world.get(e as EntityHandle, GuardianAttack);
        return ga.ok && ga.value.armed === true;
      });
      if (armedHits.length === 0) return;

      const progress = world.getResource<GameProgress>(GAME_PROGRESS_KEY);
      const admitted = admitHits(armedHits, invul, progress.elapsed);
      if (admitted.length > 0) applyDamage(progress, admitted.length);
    },
  });
}
