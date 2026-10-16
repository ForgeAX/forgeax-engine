// @forgeax/engine-app -- loadGame(slug, resolver) -> Result<Plugin, LoadGameError>
//
// Pure-function load helper that validates a dynamically-imported game
// template module. The resolver is an injection point so loadGame is
// independent of Vite / bundler specifics.
//
// Shape:
//   1. Call resolver(slug). If resolver throws, distinguish module-not-found
//      (slug in detail) from import-failed (cause in detail).
//   2. Validate the module's `default` export as a Cordis plugin.
//   3. On success, return that plugin without creating a parallel entry lifecycle.
//
// Constraints from upstream:
//   - requirements D-3: loadGame does NOT depend on Vite specifics
//   - requirements boundary-case table: module-not-found -> slug in detail;
//     invalid-format -> exportKeys; import-failed -> cause
//   - plan-strategy D-3: LoadGameError reuses codebase structured error pattern
//
// Charter awareness:
//   - P3 explicit failure: all 3 error paths return structured Result.err
//   - F1 context-limited: the function is one screen (no hidden state)

import type { Plugin } from '@forgeax/engine-plugin';
import { err, ok, type Result } from '@forgeax/engine-types';

import { LOAD_GAME_ERROR_HINTS, LOAD_GAME_EXPECTED, LoadGameError } from './load-game-errors';

/**
 * The shape of a module that the resolver returns.
 */
interface GameEntryModule {
  readonly default?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Resolver function signature: receives a slug (the game identifier),
 * returns a Promise that resolves to a module object.
 *
 * The host (apps/preview/) injects this as a dynamic import proxy,
 * e.g. `(slug) => import(\`../../templates/\${slug}/src/main.ts\`)`.
 * loadGame does not hardcode any import path.
 */
export type GamePluginResolver = (slug: string) => Promise<GameEntryModule>;

function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' &&
      value !== null &&
      'apply' in value &&
      typeof value.apply === 'function')
  );
}

/**
 * Load and validate a game template module.
 *
 * Returns `Result.ok<Plugin>` when the resolver returns a module
 * whose default export is a native Cordis plugin. Returns `Result.err<LoadGameError>`
 * with one of 3 error codes on failure.
 *
 * @param slug - The game identifier (e.g. 'game-default'). Passed
 *   through to the resolver and carried in the 'module-not-found' detail.
 * @param resolver - Async function that imports/fetches the game module.
 *   The host owns all path resolution logic.
 */
export async function loadGame(
  slug: string,
  resolver: GamePluginResolver,
): Promise<Result<Plugin, LoadGameError>> {
  let module: GameEntryModule;
  try {
    module = await resolver(slug);
  } catch (thrown: unknown) {
    // Distinguish module-not-found from generic import failure.
    // The heuristic: if the thrown error contains the slug in its message,
    // treat it as module-not-found (the resolver signaled the specific
    // module was not found, e.g. Vite "Failed to load module" with the
    // slug path in the message). Otherwise treat it as import-failed
    // (generic network error, eval error, etc.).
    if (thrown instanceof Error && thrown.message.includes(slug)) {
      return err(
        new LoadGameError({
          code: 'module-not-found',
          expected: LOAD_GAME_EXPECTED['module-not-found'],
          hint: LOAD_GAME_ERROR_HINTS['module-not-found'],
          detail: { slug },
        }),
      );
    }
    return err(
      new LoadGameError({
        code: 'import-failed',
        expected: LOAD_GAME_EXPECTED['import-failed'],
        hint: LOAD_GAME_ERROR_HINTS['import-failed'],
        detail: { cause: thrown },
      }),
    );
  }

  if (!isPlugin(module.default)) {
    const exportKeys = Object.keys(module);
    return err(
      new LoadGameError({
        code: 'invalid-format',
        expected: LOAD_GAME_EXPECTED['invalid-format'],
        hint: LOAD_GAME_ERROR_HINTS['invalid-format'],
        detail: { exportKeys },
      }),
    );
  }

  return ok(module.default);
}
