/**
 * Signature reference for the `PlayContext` helper, published in the
 * `project play` command help so a playthrough author can read the helper API
 * with `forgeax help project play --json` instead of opening devkit sources.
 *
 * The record is keyed by `keyof PlayContext`, so adding or removing a helper
 * member fails type checking here until the reference matches.
 */

import type { PlayContext } from './play';

export const PLAY_CONTEXT_REFERENCE: Readonly<Record<keyof PlayContext, string>> = {
  page: 'page: playwright Page (native DOM queries the helpers do not cover)',
  signal: 'signal: AbortSignal (aborted on timeout or cancel; stop raw page loops on it)',
  release:
    'release: boolean (true under --release, the built static release; state and waitFor read the registered projection on both builds, advance needs the development host, so guard it with this flag)',
  step: "step<T>(name: string, run: () => T | Promise<T>, options?: { setup?: (play) => unknown /* reaches this step's starting state when --from or --steps starts here */ }): Promise<T> (outside a step range: not run, resolves undefined)",
  state: 'state<T>(read?: string): Promise<T> (game read projection; defaults to the only read)',
  waitFor:
    'waitFor<T>(predicate: (state: T) => boolean, options?: { read?: string; timeoutMs?: number /* 10000 */ }): Promise<T>',
  advance:
    'advance<T>(seconds: number /* <= 600 */, options?: { stepSeconds?: number /* (0, 0.1], 1/60 */; render?: boolean; read?: string }): Promise<T>',
  keyboard:
    "keyboard.press(key: string /* 'KeyW', 'Space', 'Shift+KeyA' */): Promise<void>; keyboard.hold<T>(keys: string | string[], until: number /* ms */ | ((state: T) => boolean), options?: { read?: string; timeoutMs?: number }): Promise<T | undefined>",
  mouse:
    "mouse.click(at: Point, options?: { button?: 'left' | 'right' | 'middle' }); mouse.move(to: Point); mouse.look(dx: number, dy: number); mouse.drag(from: Point, to: Point, options?: { button?: 'left' | 'right' | 'middle' }); all Promise<void>; Point is [x, y] or { x, y } normalized to the canvas, [0, 0] top-left, [1, 1] bottom-right",
  wait: 'wait(ms: number /* game time; under --time-scale the game advances only inside waits, holds, presses and clicks */): Promise<void>',
  screenshot:
    'screenshot(name: string): Promise<{ name: string; path: string; rendered: boolean; digest: string }>',
  reload: 'reload(): Promise<void> (waits until input is open again)',
};

/** One-paragraph summary used as the `project play` input schema description. */
export const PLAY_CONTEXT_HELP = [
  "The playthrough module's default export receives `play: PlayContext`; type it with `/** @param {import('@forgeax/engine/devkit').PlayContext} play */`.",
  ...Object.values(PLAY_CONTEXT_REFERENCE).map((line) => `play.${line}`),
].join('\n');
