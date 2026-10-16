// ensure-wasm-lib.mjs — shared postinstall provisioning for the three WASM
// packages (@forgeax/engine-wgpu-wasm, -fbx, -codec).
//
// Every one of them ships its pkg/ WASM as a content-keyed GitHub Release asset
// (NOT committed; zero-binary invariant) and hydrates it on install. The logic
// is identical across all three:
//
//   1. pkg/ already present and freshness-validated -> skip (idempotent;
//      toolchain owners who ran build:wasm, CI which built pkg/, and prior
//      fetches are untouched). Package-specific provenance can reject a
//      self-consistent bundle whose source content key is stale.
//   2. skip env set           -> skip (opt-out for toolchain owners).
//   3. otherwise              -> run fetch-wasm.mjs (release tier), NON-FATAL:
//      a failed fetch (offline / no published release / source changed) NEVER
//      breaks `pnpm install`. It warns with a build hint and returns 0. The
//      build/typecheck that actually needs pkg/ fails later with a clear error.
//
// This mirrors scripts/lib/fetch-wasm-lib.mjs: the fetch layer was already an
// SSOT shared by all three fetch-wasm.mjs scripts; this collapses the ensure
// layer the same way (three near-identical bodies -> one helper + thin configs).
// Graceful degradation: architecture-principles #9.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Best-effort hydrate a package's pkg/ WASM from its release. Never throws,
 * never compiles, always returns an exit code (0 on skip/success/soft-fail).
 *
 * @param {object} opts
 * @param {string} opts.pkgLabel        short label for log lines, e.g. 'fbx'
 * @param {string[]} opts.presenceMarkers absolute paths whose existence means pkg/ is hydrated
 * @param {string} opts.fetchScript     absolute path to the package's fetch-wasm.mjs
 * @param {string} opts.skipEnv         env var name that opts out of the fetch
 * @param {string} opts.buildHint       recovery hint printed on soft-fail
 * @param {boolean} [opts.ready]        freshness-validated readiness; defaults to marker presence
 * @param {object} [opts.env]           defaults to process.env
 * @param {Function} [opts.spawn]       defaults to spawnSync (injectable for tests)
 * @param {Function} [opts.log]         defaults to console.log
 * @returns {number} exit code
 */
export function ensureWasm({
  pkgLabel,
  presenceMarkers,
  fetchScript,
  skipEnv,
  buildHint,
  ready = presenceMarkers.every((p) => existsSync(p)),
  env = process.env,
  spawn = spawnSync,
  log = console.log,
}) {
  if (ready) {
    log(`[${pkgLabel}] pkg/ WASM already present — skipping fetch.`);
    return 0;
  }

  if (env[skipEnv]) {
    log(`[${pkgLabel}] ${skipEnv} set — skipping WASM fetch.`);
    return 0;
  }

  log(`[${pkgLabel}] fetching pre-built WASM from release (best-effort)...`);
  const result = spawn(process.execPath, [fetchScript], { stdio: 'inherit' });
  if (result.status === 0) return 0;

  // Non-fatal: install must never fail because a release is unavailable.
  log(
    `[${pkgLabel}] WASM not fetched (fetch-wasm exhausted Node fetch and available OS-native fallbacks, ` +
      `or the release/content key is unavailable).\n` +
      `      See the fetch-wasm output above for the transport diagnosis.\n` +
      `      This is fine for a bare install. To provision it:\n` +
      `        ${buildHint}`,
  );
  return 0;
}
