// apps/collectathon -- hud-sync: one-way GameProgress SSOT -> DOM overlay
// (AC-18 single-direction derive, architecture-principles section 2).
//
// hudSyncSystem reads the GameProgress resource each frame and renders its
// score / health / elapsed into the three #hud value spans. It is a pure VIEW of
// the SSOT: this file contains NO world.insertResource / world.set on
// GameProgress and never mutates the resource object -- grep this file for
// `GameProgress` and every hit is a read. The AC-18 review anchor is exactly
// this: the timer increment that DOES write GameProgress.elapsed lives in the
// separate timer-tick system (createTimerSystem below), keeping the HUD reader
// write-free so the single-direction derive is grep-provable.
//
// formatHud is pure (GameProgress -> three strings) so the read-side rendering
// is unit-testable without a DOM; the system fn wires it to the live resource +
// the HUD handle spans.

import type { SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';

import { formatElapsed, type HudHandles } from '../hud';
import { GAME_PROGRESS_KEY, type GameProgress, tickElapsed } from '../resources';
import { readDt } from './frame-time';

/** The three rendered HUD strings derived from a GameProgress snapshot (pure). */
export interface HudView {
  readonly score: string;
  readonly health: string;
  readonly timer: string;
}

/**
 * Pure derive: GameProgress -> the three HUD strings. No DOM, no resource write.
 * `Score: collected/total`, `Health: hearts`, `MM:SS` elapsed.
 */
export function formatHud(progress: GameProgress): HudView {
  return {
    score: `${progress.score}/${progress.total}`,
    health: String(progress.health),
    timer: formatElapsed(progress.elapsed),
  };
}

/**
 * Build the HUD sync system bound to the resolved #hud spans. Per frame: read
 * GameProgress (guarded -- no-op before OnEnter inserts it), derive the view
 * strings, and write them to the DOM. This system NEVER writes GameProgress
 * (AC-18 one-way derive) -- the elapsed timer write is the separate timer-tick
 * system (createTimerSystem).
 */
export function createHudSyncSystem(hud: HudHandles): SystemHandle<readonly []> {
  return defineSystem({
    name: 'hud-sync',
    queries: [],
    fn: (world: World) => {
      if (!world.hasResource(GAME_PROGRESS_KEY)) return;
      const progress = world.getResource<GameProgress>(GAME_PROGRESS_KEY);
      const view = formatHud(progress);
      hud.scoreEl.textContent = view.score;
      hud.healthEl.textContent = view.health;
      hud.timerEl.textContent = view.timer;
    },
  });
}

/**
 * Build the run-timer system: the SOLE writer of GameProgress.elapsed. Kept
 * separate from hud-sync so the HUD reader stays provably write-free (AC-18).
 * Per frame it accumulates the clamped frame dt into elapsed via the resources
 * tickElapsed mutator (the named write call site, mirroring core-collect's
 * applyCollect / guardian-hit's damage writer).
 */
export function createTimerSystem(): SystemHandle<readonly []> {
  return defineSystem({
    name: 'hud-timer',
    queries: [],
    fn: (world: World) => {
      if (!world.hasResource(GAME_PROGRESS_KEY)) return;
      const progress = world.getResource<GameProgress>(GAME_PROGRESS_KEY);
      tickElapsed(progress, readDt(world));
    },
  });
}
