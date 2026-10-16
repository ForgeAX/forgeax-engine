// controller-db-data.ts -- the 554KB vendored SDL_GameControllerDB, inlined
// at build time via esbuild's text loader (tsup.config.ts loader['.txt']).
//
// This module is a SEPARATE sub-export (`@forgeax/engine-input/controller-db-data`)
// so the vendored 554KB text NEVER enters the main-entry bundle. The
// browser backend dynamic-imports it only on first sight of a non-standard
// gamepad (D-2 lazy-load; C-5 the DB size must not sit in the default path).
//
// The `?raw`-free plain import returns the inlined string because tsup is
// configured with loader: { '.txt': 'text' }. In a vitest/vite context the
// default `.txt` import is a URL, so consumers under test inject their own
// DB text instead of importing this module (D-13 loadControllerDb override).

// @ts-expect-error -- esbuild text loader inlines the .txt file as a string
// module; there is no ambient type declaration for `*.txt` imports and one
// is not warranted for a single build-time asset.
import bundledControllerDb from '../vendor/gamecontrollerdb.txt';

/** The vendored gamecontrollerdb.txt contents, inlined at build time. */
export const BUNDLED_CONTROLLER_DB: string = bundledControllerDb as string;

/** Default loader used by the backend when no override is supplied (D-13). */
export function loadBundledControllerDb(): Promise<string> {
  return Promise.resolve(BUNDLED_CONTROLLER_DB);
}
