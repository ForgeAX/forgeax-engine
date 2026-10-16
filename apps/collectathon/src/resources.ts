// apps/collectathon -- GameProgress: the single authoritative carrier for the
// gameplay scoreboard (AC-18, plan-strategy D-1 SSOT).
//
// score / total / health / elapsed live HERE and only here. There is NO second
// counter field anywhere in the game: the HUD (M5) reads this resource and
// renders it one-way; the win-lose arbiter (M4) reads health; core-collect (m3-7)
// is the SOLE writer of score; guardian-hit (M4) is the sole writer of health.
// The pure mutators below (applyCollect lives in core-collect.ts, tickElapsed +
// allCollected here) are the only sanctioned write/read paths -- this keeps the
// AC-18 single-writer review anchor grep-able (write call sites are named, not
// scattered `progress.score =` assignments across systems).
//
// GameProgress is a plain string-keyed World resource (no defineResource
// registration -- the engine's resource store is a key->value map). main.ts adds
// it in the OnEnter('Play') callback via world.insertResource('GameProgress',
// createGameProgress(coreCount)); systems read it via
// world.getResource<GameProgress>('GameProgress').

/** Resource key under which GameProgress is stored in the World. */
export const GAME_PROGRESS_KEY = 'GameProgress';

/** Starting health (hearts) for a fresh run (plan-strategy: 3 hits to Lose). */
export const INITIAL_HEALTH = 3;

/**
 * The gameplay scoreboard SSOT (AC-18).
 *
 * - `score`   collected Core count; the SOLE writer is core-collect (m3-7).
 * - `total`   Core count for this level; the win gate is score === total.
 * - `health`  remaining hearts; the sole writer is guardian-hit (M4).
 * - `elapsed` run time in seconds; advanced by the collect/timer tick.
 */
export interface GameProgress {
  score: number;
  total: number;
  health: number;
  elapsed: number;
}

/**
 * Build a fresh GameProgress for a level whose Core count is `total`.
 *
 * health starts at INITIAL_HEALTH; score + elapsed start at 0. A Title -> Play
 * replay calls this again, so the scoreboard resets cleanly (AC-11).
 */
export function createGameProgress(total: number): GameProgress {
  return { score: 0, total, health: INITIAL_HEALTH, elapsed: 0 };
}

/**
 * True once every Core is collected (score === total) -- the win gate that
 * portal-activate (m3-8) reads to flip the Portal active. A degenerate total=0
 * level reads as collected from the first frame.
 */
export function allCollected(progress: GameProgress): boolean {
  return progress.score >= progress.total;
}

/**
 * Accumulate `dt` seconds into the run timer (in-place SSOT write). Returns the
 * same progress object so call sites read as a single statement.
 */
export function tickElapsed(progress: GameProgress, dt: number): GameProgress {
  progress.elapsed += dt;
  return progress;
}

/**
 * Replace the World's GameProgress with a fresh scoreboard for a `total`-Core
 * level (AC-11 replay reset). Called from the Title OnEnter hook so a
 * Win/Lose -> Title -> Play replay starts clean: insertResource overwrites the
 * old object (no in-place mutation of a possibly-referenced run state), so score
 * / health / elapsed all return to their initial values. Pairs with the
 * state-scoped despawn that clears the prior run's entities.
 */
export function resetProgress(world: import('@forgeax/engine-ecs').World, total: number): void {
  world.insertResource(GAME_PROGRESS_KEY, createGameProgress(total));
}

/**
 * Resource key for the transient pickup-signal channel (AC-12 MSDF "+1" text).
 *
 * core-collect writes a PickupSignal[] before despawn so the floating-text
 * system can read the Core world positions. The pickup-text system reads +
 * clears this resource each frame (it is purely transient -- a one-frame
 * signal, not persistent scoreboard state). One writer (core-collect), one
 * reader (pickup-text) -- grep-able AC-18 SSOT single-writer shape.
 */
export const PICKUP_SIGNAL_KEY = 'CollectathonPickupSignal';

/** A pickup signal carrying the world position where a Core was collected. */
export interface PickupSignal {
  readonly pos: readonly [number, number, number];
}
