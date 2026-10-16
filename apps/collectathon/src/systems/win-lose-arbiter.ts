// apps/collectathon -- win-lose-arbiter: the SOLE Win/Lose verdict system
// (requirements AC-17 fail path + the Win/Lose same-frame mutual-exclusion
// boundary, F-08 setNextState one-frame defer).
//
// WHY a single arbiter: setNextState defers a frame (F-08), and if two different
// systems both requested a transition the same frame the LAST writer would win
// silently. Funnelling every Win/Lose decision through ONE system that calls
// setNextState at most once per frame makes the outcome deterministic -- there is
// no frame in which both Win and Lose are requested.
//
// PRIORITY: Win > Lose. arbitrate returns at most one verdict; the Win branch is
// checked first, so a player who collects the last Core and reaches the active
// Portal the same frame their health hits 0 is judged a Win -- they completed the
// objective. Only when the objective is incomplete does health<=0 read as Lose.
//
// The Win condition mirrors portal-activate's gate (all Cores collected + player
// on the active Portal). portal-activate already flips PortalState.active and
// requests Win on arrival; this arbiter is the authoritative funnel that ALSO
// owns the Lose path, so Win/Lose can never both fire. (portal-activate's own
// Win request is harmless -- same target state -- but the arbiter is the SSOT for
// the mutual-exclusion guarantee.)

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { CollidingEntities } from '@forgeax/engine-physics';
import type { StateToken } from '@forgeax/engine-state';
import { setNextState } from '@forgeax/engine-state';

import { Portal, PortalState } from '../components';
import { GAME_PROGRESS_KEY, type GameProgress } from '../resources';

export interface ArbiterInput {
  readonly health: number;
  readonly score: number;
  readonly total: number;
  /** True when the player is overlapping a Portal whose PortalState is active. */
  readonly playerOnActivePortal: boolean;
}

/**
 * Pure single-verdict decision. Returns 'Win', 'Lose', or null (run ongoing).
 *
 * Win > Lose: the objective-complete branch (all Cores collected AND on the
 * active Portal) is evaluated first, so completing the objective the same frame
 * health reaches 0 is a Win. Otherwise health <= 0 is a Lose. Exactly one verdict
 * (or none) is returned, guaranteeing the system calls setNextState at most once.
 */
export function arbitrate(input: ArbiterInput): 'Win' | 'Lose' | null {
  const objectiveComplete = input.score >= input.total && input.playerOnActivePortal;
  if (objectiveComplete) return 'Win';
  if (input.health <= 0) return 'Lose';
  return null;
}

/**
 * Build the win-lose-arbiter system bound to the player parent + the Portal
 * entity + the GameState token. Factory form mirrors the other gameplay systems
 * (captured handles unreachable from the descriptor fn).
 *
 * Guarded for the early-frame window: a missing GameProgress resource no-ops. The
 * Portal handle going stale (mid-transition despawn) reads playerOnActivePortal
 * as false, so a Lose can still fire while a Win cannot mis-trigger on a dead
 * Portal.
 */
export function createArbiterSystem(
  player: EntityHandle,
  portal: EntityHandle,
  gameState: StateToken,
): SystemHandle<readonly []> {
  return defineSystem({
    name: 'win-lose-arbiter',
    after: ['portal-activate', 'guardian-hit'],
    queries: [],
    fn: (world: World) => {
      if (!world.hasResource(GAME_PROGRESS_KEY)) return;
      const progress = world.getResource<GameProgress>(GAME_PROGRESS_KEY);

      const verdict = arbitrate({
        health: progress.health,
        score: progress.score,
        total: progress.total,
        playerOnActivePortal: playerOnActivePortal(world, player, portal),
      });
      if (verdict === null) return;

      void setNextState(world, gameState, verdict);
    },
  });
}

// True when the Portal is active AND the player parent's CollidingEntities lists
// it. A stale/despawned Portal reads false.
function playerOnActivePortal(world: World, player: EntityHandle, portal: EntityHandle): boolean {
  const stateRes = world.get(portal, PortalState);
  if (!stateRes.ok || stateRes.value.active !== true) return false;
  const colliding = world.get(player, CollidingEntities);
  if (!colliding.ok) return false;
  const entities = colliding.value.entities;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e !== undefined && world.get(e as EntityHandle, Portal).ok) return true;
  }
  return false;
}
