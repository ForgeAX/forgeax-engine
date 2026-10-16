// apps/collectathon -- core-collect: sensor pickup -> Score+1 -> Core despawn
// (plan-strategy D-1 sensor + CollidingEntities set read, AC-13 pickup, AC-18
// single-writer SSOT).
//
// Per frame the system reads the player parent's CollidingEntities set (the set
// of entities whose colliders currently overlap the player), keeps only the ones
// tagged Core, then for each: captures the Core world position (via Transform),
// despawns the Core (deferred via commands), and adds 1 to GameProgress.score.
// This is the SOLE GameProgress.score writer (AC-18) -- grep `applyCollect`
// finds the only score mutation.
//
// Before despawn, the system writes the Core world positions into a transient
// PickupSignal[] resource so the pickup-text system (AC-12) can spawn floating
// "+1" GlyphText entities at the collection points. core-collect writes the
// signal; pickup-text reads + clears it -- one-way, grep-able single-writer
// (AC-18 shape).
//
// Pure helpers (resolveCollisions / applyCollect) carry the testable decision
// logic; the system fn wires them to the live CollidingEntities + GameProgress +
// PickupSignal.

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { CollidingEntities } from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-scene';

import { Core } from '../components';
import {
  GAME_PROGRESS_KEY,
  type GameProgress,
  PICKUP_SIGNAL_KEY,
  type PickupSignal,
} from '../resources';

/**
 * From a set of colliding entity handles, keep only the ones the `isCore`
 * predicate accepts (the real system passes e => world.get(e, Core).ok). Accepts
 * either a plain number[] or the Uint32Array that CollidingEntities.entities
 * exposes at runtime.
 */
export function resolveCollisions(
  colliding: ReadonlyArray<number> | Uint32Array,
  isCore: (entity: number) => boolean,
): number[] {
  const hits: number[] = [];
  for (let i = 0; i < colliding.length; i++) {
    const e = colliding[i];
    if (e !== undefined && isCore(e)) hits.push(e);
  }
  return hits;
}

/**
 * The single GameProgress.score writer (AC-18): add `n` collected Cores to the
 * score in place and return the same progress object.
 */
export function applyCollect(progress: GameProgress, n: number): GameProgress {
  progress.score += n;
  return progress;
}

/**
 * Build the core-collect system bound to the player parent entity (whose
 * CollidingEntities set is read each frame). Factory form mirrors the other
 * gameplay systems: the captured player handle cannot be reached from the
 * descriptor fn (world only).
 *
 * Two guards keep the early-frame window safe: a missing GameProgress resource
 * (before OnEnter inserts it) and a missing CollidingEntities component (before
 * the first physics tick writes it) both no-op rather than throw.
 */
export function createCollectSystem(player: EntityHandle): SystemHandle<readonly []> {
  return defineSystem({
    name: 'core-collect',
    after: ['player-move'],
    queries: [],
    fn: (world: World, _results, commands) => {
      if (!world.hasResource(GAME_PROGRESS_KEY)) return;
      const colliding = world.get(player, CollidingEntities);
      if (!colliding.ok) return;

      const hits = resolveCollisions(
        colliding.value.entities,
        (e) => world.get(e as EntityHandle, Core).ok,
      );
      if (hits.length === 0) return;

      // Capture world positions before despawn (AC-12): the Transform is
      // gone after despawn, so read Transform.pos now and write the signal
      // so the pickup-text system can spawn floating "+1" text at each site.
      const signals: PickupSignal[] = [];
      for (const core of hits) {
        const t = world.get(core as EntityHandle, Transform);
        if (t.ok) {
          signals.push({
            pos: [t.value.pos[0] ?? 0, t.value.pos[1] ?? 0, t.value.pos[2] ?? 0],
          });
        }
      }

      for (const core of hits) commands.despawn(core as EntityHandle);
      const progress = world.getResource<GameProgress>(GAME_PROGRESS_KEY);
      applyCollect(progress, hits.length);

      world.insertResource(PICKUP_SIGNAL_KEY, signals);
    },
  });
}
