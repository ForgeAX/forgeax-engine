// apps/collectathon -- HUD: the DOM overlay handle set (Score / Health / Timer).
//
// createHUD() reaches the persistent #hud container declared in index.html and
// returns its three live value spans. hud-sync.ts writes their textContent each
// frame from the GameProgress SSOT -- this module owns the DOM lookup + the
// elapsed->MM:SS formatting; the system owns the per-frame read+write (AC-18).
//
// One-way derive (architecture-principles section 2 / AC-18): the HUD is a VIEW
// of GameProgress, never a second copy. There is no DOM->resource write path in
// this file or in hud-sync.ts -- the only writers of score / health / elapsed
// stay in the game-logic systems (core-collect / guardian-hit / the timer tick).
//
// Visibility (charter F2 text-over-image): index.html ships #hud at
// display:none; main.ts shows it on OnEnter('Play') and hides it on
// OnExit('Play') by toggling container.style.display. The HUD element is
// pointer-events:none so it never steals canvas input.

/** The three live HUD value spans + their container, resolved once at boot. */
export interface HudHandles {
  readonly container: HTMLElement;
  readonly scoreEl: HTMLElement;
  readonly healthEl: HTMLElement;
  readonly timerEl: HTMLElement;
}

/**
 * Resolve the #hud overlay declared in index.html into a typed handle set.
 *
 * index.html is the SSOT for the HUD markup + styling (the persistent overlay
 * scaffold landed in M1). This reads the existing container + value spans rather
 * than building DOM in TS, so the layout stays grep-able in one place. Throws if
 * the markup is missing (Fail Fast: a HUD-less build is a packaging bug, not a
 * silent degrade).
 */
export function createHUD(doc: Document = document): HudHandles {
  const container = doc.getElementById('hud');
  const scoreEl = doc.getElementById('score');
  const healthEl = doc.getElementById('health');
  const timerEl = doc.getElementById('timer');
  if (container === null || scoreEl === null || healthEl === null || timerEl === null) {
    throw new Error(
      'collectathon: HUD markup missing (expected #hud with #score / #health / #timer in index.html)',
    );
  }
  return { container, scoreEl, healthEl, timerEl };
}

/**
 * Format an elapsed-seconds count as MM:SS (zero-padded, clamped to >= 0). Pure
 * so the timer formatting is unit-testable without a DOM. A 1h+ run keeps
 * counting minutes (e.g. 75:09) rather than rolling to HH:MM:SS -- a collectathon
 * level is minutes-scale, so two-field MM:SS stays readable.
 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** Show the HUD overlay (OnEnter Play). */
export function showHUD(hud: HudHandles): void {
  hud.container.style.display = 'block';
}

/** Hide the HUD overlay (OnExit Play / Title screen). */
export function hideHUD(hud: HudHandles): void {
  hud.container.style.display = 'none';
}
