// apps/collectathon -- portal-activate: flip the Portal active once every Core
// is collected, then Win on player arrival (plan-strategy D-1, AC-16 win path,
// F-08 setNextState one-frame defer).
//
// Per frame:
//   (1) if GameProgress shows every Core collected and the Portal is still
//       inactive, flip PortalState.active = true and swap the Portal material to
//       the bright active glow.
//   (2) if the Portal is active AND the player parent's CollidingEntities lists
//       the Portal sensor, request setNextState(GameState, 'Win'). An inactive
//       Portal ignores arrival (boundary case).
//
// Win/Lose mutual exclusion: portal-activate owns the "player arrived at active
// Portal" gate -- it is the only system that fires on that condition, and it
// only requests 'Win'. The Lose path and the same-frame Win > Lose mutual
// exclusion live in win-lose-arbiter (the SSOT funnel for all
// game-ending transitions).  portal-activate's own Win request is harmless --
// same target state as the arbiter's Win -- but the arbiter is the authoritative
// single-writer on setNextState for Win/Lose.
//
// shouldActivatePortal / shouldWin are pure so the gates are unit-tested
// (portal-activate.test.ts); the system fn wires them to the live resource +
// CollidingEntities + state token.

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { CollidingEntities } from '@forgeax/engine-physics';
import { MeshRenderer } from '@forgeax/engine-render';
import type { StateToken } from '@forgeax/engine-state';
import { setNextState } from '@forgeax/engine-state';
import type { MaterialAsset } from '@forgeax/engine-types';

import { Portal, PortalState } from '../components';
import { allCollected, GAME_PROGRESS_KEY, type GameProgress } from '../resources';
import { activePortalMaterial } from '../spawn/spawn-portal';

/** Activate the Portal iff every Core is collected (the win gate). */
export function shouldActivatePortal(progress: GameProgress): boolean {
  return allCollected(progress);
}

/** Win iff the Portal is active AND the player has arrived at it. */
export function shouldWin(portalActive: boolean, playerOnPortal: boolean): boolean {
  return portalActive && playerOnPortal;
}

/**
 * Build the portal-activate system bound to the player parent + the Portal
 * entity + the GameState token. Factory form mirrors the other gameplay systems.
 *
 * The Win is requested at most once: setNextState is idempotent within a frame
 * and the Play state's OnExit despawns the Portal, so a second arrival after the
 * transition cannot re-fire (the Portal handle goes stale).
 */
export function createPortalSystem(
  player: EntityHandle,
  portal: EntityHandle,
  gameState: StateToken,
): SystemHandle<readonly []> {
  return defineSystem({
    name: 'portal-activate',
    after: ['core-collect'],
    queries: [],
    fn: (world: World) => {
      if (!world.hasResource(GAME_PROGRESS_KEY)) return;
      const stateRes = world.get(portal, PortalState);
      if (!stateRes.ok) return; // Portal despawned (e.g. mid-transition).

      let active = stateRes.value.active === true;

      if (!active) {
        const progress = world.getResource<GameProgress>(GAME_PROGRESS_KEY);
        if (shouldActivatePortal(progress)) {
          activatePortal(world, portal);
          active = true;
        }
      }

      if (!active) return;
      const colliding = world.get(player, CollidingEntities);
      if (!colliding.ok) return;
      const playerOnPortal = setHasPortal(world, colliding.value.entities);
      if (shouldWin(active, playerOnPortal)) {
        void setNextState(world, gameState, 'Win');
      }
    },
  });
}

// Flip PortalState.active and swap to the bright active material.
function activatePortal(world: World, portal: EntityHandle): void {
  world.set(portal, PortalState, { active: true });
  const renderer = world.get(portal, MeshRenderer);
  if (!renderer.ok) return;
  const activeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    activePortalMaterial(),
  );
  world.set(portal, MeshRenderer, { materials: [activeMat] });
}

// True if any colliding entity carries the Portal tag (arrival detection).
function setHasPortal(world: World, colliding: ReadonlyArray<number> | Uint32Array): boolean {
  for (let i = 0; i < colliding.length; i++) {
    const e = colliding[i];
    if (e !== undefined && world.get(e as EntityHandle, Portal).ok) return true;
  }
  return false;
}
