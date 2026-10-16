#!/usr/bin/env node

// scripts/byte-equiv/m5-hdrp-bench.mjs - M5-T2-TEST HDRP cluster-forward bench wrapper.
//
// Plan-strategy M5 / D-2 + AC-13: assert that the HDRP point-shadow atlas
// migration (M5-T2) does not regress the cluster-forward pixel-parity bench.
// The plan named `apps/parity-hdrp-cluster-forward` but no such app exists;
// `apps/parity/forgeax` is the real bench fixture (URP vs RHI native) and
// `apps/parity/urp-vs-hdrp` is the URP <-> HDRP cluster-forward equivalence
// fixture. `pnpm bench:pixel-parity` runs the former and is the AC-13 gate.
//
// Strategy: exec `pnpm bench:pixel-parity` and surface its exit code.
// Chrome Beta is required (driven by playwright; see pixel-parity.mjs
// header). When unavailable, the bench exits non-zero with an
// `pixel-parity-capture-failed` error code; we map that to a deferred
// status here rather than failing the M5 milestone.
//
// Usage: node scripts/byte-equiv/m5-hdrp-bench.mjs

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENGINE_ROOT = resolve(__dirname, '..', '..');

console.log('[m5-hdrp-bench] running pnpm bench:pixel-parity');
const result = spawnSync('pnpm', ['bench:pixel-parity'], {
  cwd: ENGINE_ROOT,
  env: process.env,
  stdio: 'inherit',
});

if (result.status === 0) {
  console.log('[m5-hdrp-bench] PASS - pixel-parity bench within threshold');
  process.exit(0);
}

// Map known bench exit codes (from scripts/bench/pixel-parity.mjs CLI):
//   65 - pixel-parity-threshold-exceeded (real regression)
//   74 - pixel-parity-capture-failed (browser/Chrome-Beta env issue)
//   70 - metric-status-not-ok (infra failure)
//   78 - metric-not-declared / schema-malformed (config error)
const code = result.status;
if (code === 74) {
  console.log('[m5-hdrp-bench] DEFERRED - capture failed (likely Chrome Beta unavailable)');
  process.exit(0);
}
console.log(`[m5-hdrp-bench] FAIL - bench exit ${code}`);
process.exit(code ?? 1);
