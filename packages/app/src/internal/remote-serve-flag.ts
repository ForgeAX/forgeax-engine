// @forgeax/engine-app/internal/remote-serve-flag -- FORGEAX_ENGINE_REMOTE_SERVE
// dual-source resolution (plan-strategy secondary D-7).
//
// The remote eval server is auto-started in dev mode (vite's import.meta.env.DEV)
// and production builds skip it. Headless/dawn-node can opt in via the
// FORGEAX_ENGINE_REMOTE_SERVE=1 env var.
//
// Dual sources (mirrors rhi-debug-flag.ts pattern):
//   browser (vite): import.meta.env.DEV is statically replaced by vite
//     (true in dev server, false in production build).
//   dawn-node     : import.meta may be undefined; fallback to
//     globalThis.process.env.FORGEAX_ENGINE_REMOTE_SERVE === '1'.
//
// The SSOT precedence: import.meta.env.DEV wins when available;
// process.env is the headless opt-in path.

/** Minimal structural view of an env bag carrying the serve flag. */
interface RemoteServeEnv {
  readonly FORGEAX_ENGINE_REMOTE_SERVE?: string | undefined;
}

/**
 * Resolve whether the remote eval server should be started.
 *
 * Returns `true` when:
 *   - vite dev mode (import.meta.env.DEV === true), OR
 *   - headless/dawn-node with FORGEAX_ENGINE_REMOTE_SERVE=1 opt-in
 *
 * Returns `false` in production builds and headless without explicit opt-in.
 *
 * @param isDev flag from import.meta.env.DEV (undefined when import.meta absent)
 * @param processEnv globalThis.process?.env when present, else undefined
 */
export function resolveRemoteServeFlag(
  isDev: boolean | undefined,
  processEnv: RemoteServeEnv | undefined,
): boolean {
  if (isDev === true) return true;
  if (processEnv?.FORGEAX_ENGINE_REMOTE_SERVE === '1') return true;
  return false;
}
