// apps/collectathon -- debug-overlay: an opt-in immediate-mode debug-draw layer
// over the live gameplay (plan-strategy D-4 toggle, AC-14 debug-draw overlay,
// research F-11 app.debugDraw zero-cost when idle).
//
// When debugDrawEnabled is true the system draws, each frame, via app.debugDraw:
//   - the player capsule approx (green sphere at the player position)
//   - each live Core sensor (warm sphere)
//   - each live Guardian body (red sphere) + a red line Guardian -> player
//     (the chase ray), so the AI's targeting is visible
//   - the level boundary AABB (grey box)
//
// The toggle is resolved ONCE at wiring time (import.meta.env.DEV default, with a
// URL ?debug=0/1 override) and captured into the closure -- the system reads a
// boolean each frame, not the URL, so there is no per-frame parse. When disabled
// the system early-returns before touching debugDraw (F-11 zero-cost idle).
//
// Debug-draw is dev-affordance only: the captured handles can go stale (a Core is
// collected, the run ends) -- each draw is gated by a live world.get so a stale
// handle is skipped rather than throwing.

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';

// Overlay colours (RGB; debug-draw fills alpha=1).
const PLAYER_COLOR = [0, 1, 0] as const;
const CORE_COLOR = [1, 0.7, 0.3] as const;
const GUARDIAN_COLOR = [1, 0, 0] as const;
const CHASE_LINE_COLOR = [1, 0, 0] as const;
const BOUNDS_COLOR = [0.5, 0.5, 0.5] as const;

// Debug sphere radii approximating each collider.
const PLAYER_DEBUG_RADIUS = 0.4;
const CORE_DEBUG_RADIUS = 0.35;
const GUARDIAN_DEBUG_RADIUS = 0.5;

/** Minimal app surface the overlay needs: the debugDraw handle (may be absent). */
interface DebugApp {
  readonly debugDraw?:
    | {
        sphere(center: ArrayLike<number>, radius: number, color: ArrayLike<number>): void;
        line(a: ArrayLike<number>, b: ArrayLike<number>, color: ArrayLike<number>): void;
        aabb(min: ArrayLike<number>, max: ArrayLike<number>, color: ArrayLike<number>): void;
      }
    | undefined;
}

/** The live entity handles the overlay visualizes for the current run. */
export interface OverlayTargets {
  readonly player: EntityHandle;
  readonly cores: ReadonlyArray<EntityHandle>;
  readonly guardianBodies: ReadonlyArray<EntityHandle>;
  /** Level half-extent (the boundary wall ring); the AABB spans +/- this in XZ. */
  readonly levelHalf: number;
}

/**
 * Resolve the debug-draw enabled flag (D-4): import.meta.env.DEV is the default,
 * a URL ?debug=1 forces on, ?debug=0 forces off. Pure over its two inputs so the
 * toggle policy is reviewable without a DOM. Any non-0/1 value falls through to
 * the dev default.
 */
export function resolveDebugEnabled(devDefault: boolean, debugParam: string | null): boolean {
  if (debugParam === '1') return true;
  if (debugParam === '0') return false;
  return devDefault;
}

/**
 * Build the debug-overlay system bound to the app + the live run targets + the
 * resolved enabled flag. Factory form so the captured handles + the flag persist
 * across frames. When `enabled` is false the system is a per-frame no-op (it
 * still runs, but returns before any debugDraw call -- F-11 zero-cost idle).
 */
export function createDebugOverlaySystem(
  app: DebugApp,
  targets: OverlayTargets,
  enabled: boolean,
): SystemHandle<readonly []> {
  return defineSystem({
    name: 'debug-overlay',
    after: ['guardian-ai'],
    queries: [],
    fn: (world: World) => {
      if (!enabled) return;
      const dd = app.debugDraw;
      if (dd === undefined) return;

      const playerPos = entityPos(world, targets.player);
      if (playerPos !== undefined) {
        dd.sphere(playerPos, PLAYER_DEBUG_RADIUS, PLAYER_COLOR);
      }

      for (const core of targets.cores) {
        const p = entityPos(world, core);
        if (p !== undefined) dd.sphere(p, CORE_DEBUG_RADIUS, CORE_COLOR);
      }

      for (const guardian of targets.guardianBodies) {
        const gp = entityPos(world, guardian);
        if (gp === undefined) continue;
        dd.sphere(gp, GUARDIAN_DEBUG_RADIUS, GUARDIAN_COLOR);
        if (playerPos !== undefined) dd.line(gp, playerPos, CHASE_LINE_COLOR);
      }

      const h = targets.levelHalf;
      dd.aabb(vec3.create(-h, 0, -h), vec3.create(h, 4, h), BOUNDS_COLOR);
    },
  });
}

// Read an entity's world position as a Vec3, or undefined if the handle is stale.
function entityPos(world: World, entity: EntityHandle): ReturnType<typeof vec3.create> | undefined {
  const tf = world.get(entity, Transform);
  if (!tf.ok) return undefined;
  return vec3.create(tf.value.pos[0] ?? 0, tf.value.pos[1] ?? 0, tf.value.pos[2] ?? 0);
}
