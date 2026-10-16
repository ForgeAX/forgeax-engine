// apps/collectathon -- shared frame-time read.
//
// The app frame-loop writes a 'Time' resource ({ dt }) before world.update()
// each frame. Every per-frame system reads its clamped dt from this single
// source (SSOT). Extracted here so player-move / player-anim / future systems
// share one reader rather than copy-pasting the try/catch fallback.
//
// The catch returns a fixed 1/60 (16.67ms) so callers never see NaN/0; the
// only window where the resource is absent is before the first frame-loop tick
// fires, and every system that consumes dt upstream gates on other guards
// (player-move on PhysicsWorld, player-anim on the locomotion signal, etc.)
// that also no-op in that window. Returning a Result<number> would force the 8
// callers to unwrap at every frame, which is heavier than the bug it prevents.

import { Time, type World } from '@forgeax/engine-ecs';

let warnedMissingTime = false;

/** Clamped per-frame delta seconds from the 'Time' resource (60fps fallback). */
export function readDt(world: World): number {
  try {
    return world.getResource(Time).delta;
  } catch {
    if (!warnedMissingTime) {
      console.warn(
        '[collectathon] Time resource missing at frame start; using fixed 1/60 dt. ' +
          'If this persists past the first render tick, check the frame-loop bootstrap.',
      );
      warnedMissingTime = true;
    }
    return 1 / 60;
  }
}
