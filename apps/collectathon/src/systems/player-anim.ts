// apps/collectathon -- player-anim: weights[] crossfade between idle/locomotion.
//
// The engine has NO crossfade() / fadeTo() method (research F-03): crossfade is
// a user-space recipe -- multiple active AnimationPlayer slots whose weights[]
// are re-written every frame. advanceAnimationPlayer blends the active slots by
// weight (importer-agnostic, FBX and glTF share the same path).
//
// humanoid.fbx ships clips run / punch / shot -- NOT idle / run / jump. Per plan
// D-3 the locomotion state machine maps onto the available clips:
//   slot 0 = locomotion: the run clip at speed 1
//   slot 1 = idle:       the SAME run clip held at speed 0 (frozen first frame)
// Crossfading the two weights produces a visible run<->stand transition without
// a hard cut. (A dedicated idle clip would be richer, but the run-held-at-speed-0
// idle still proves the weights[] crossfade is real, non-hard-cut -- AC-05.)
//
// blendTowards is a pure function so the 0.3s ease is unit-testable; the system
// fn wires it to the PlayerMoveSignal produced by player-move (no re-querying
// input -- D-5 one-way signal).

import { AnimationPlayer } from '@forgeax/engine-animation';
import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';

import { readDt } from './frame-time';
import type { PlayerMoveSignal } from './player-move';

// Crossfade settle time: weights interpolate over this many seconds (AC-05 spec
// of a 0.3s transition).
export const CROSSFADE_DURATION = 0.3;

/**
 * Advance a normalized crossfade phase toward a target (0 = idle, 1 = locomotion)
 * at a rate that fully settles over CROSSFADE_DURATION seconds. Clamped to [0,1].
 *
 * @param phase current phase in [0,1]
 * @param target 1 when moving, 0 when idle
 * @param dt frame delta seconds
 */
export function blendTowards(phase: number, target: number, dt: number): number {
  const step = dt / CROSSFADE_DURATION;
  if (target > phase) return Math.min(1, phase + step);
  if (target < phase) return Math.max(0, phase - step);
  return phase;
}

// App surface the system closure needs: just the World for the 'Time' resource.
interface AnimSystemApp {
  readonly world: World;
}

/**
 * Build the player-anim system bound to the Skin entity + the move signal.
 *
 * slot 0 weight = phase (locomotion), slot 1 weight = 1 - phase (idle). phase
 * eases toward 1 while signal.moving, toward 0 while idle. The weights are
 * normalized (sum 1) so advanceAnimationPlayer's per-channel blend stays stable.
 *
 * Factory form mirrors player-move: the descriptor fn (world only) cannot reach
 * the captured Skin handle / move signal, so they are closed over. One
 * defineSystem per domain file (AC-20).
 */
export function createAnimSystem(
  _app: AnimSystemApp,
  skin: EntityHandle,
  signal: PlayerMoveSignal,
): SystemHandle<readonly []> {
  // Spawn pose is idle (phase 0); spawn-player primed weights=[0,1].
  let phase = 0;

  return defineSystem({
    name: 'player-anim',
    after: ['player-move'],
    queries: [],
    fn: (world: World) => {
      const dt = readDt(world);
      const target = signal.moving ? 1 : 0;
      phase = blendTowards(phase, target, dt);

      // weights[0] = locomotion (run, speed 1), weights[1] = idle (run, speed 0).
      const setRes = world.set(skin, AnimationPlayer, {
        weights: [phase, 1 - phase],
      });
      // A missing AnimationPlayer (skin not ready) is a no-op, not a failure.
      void setRes;
    },
  });
}
