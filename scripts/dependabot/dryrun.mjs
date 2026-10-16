#!/usr/bin/env node
// scripts/dependabot/dryrun.mjs (bug-20260514 M4 / T-014)
// Local dryrun orchestrator: chains the three dependabot scripts in
// self-test mode so AI users can repro the AC-03 contract end-to-end
// from a clean checkout. Zero npm deps; node:* stdlib only.
//
// Steps (any non-zero exit short-circuits with stderr context):
//   1. node scripts/dependabot/check-drift.mjs
//      (no-drift on clean main -> exit 0; drift on HEAD vs working tree
//      -> exit 1, surfaces the marker on stdout)
//   2. node scripts/dependabot/emit-fix-hint.mjs --self-test
//      (no GITHUB_HEAD_REF / no --ref -> banner + exit 0; the hint
//      template still self-validates the marker / commands contract)
//   3. node scripts/dependabot/sync-and-push.mjs --self-test
//      (banner + exit 0 without spawning bun install / git push)
//
// AGENTS.md > Conventions > Dual lockfile.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export const STEPS = [
  { id: 'check-drift', script: resolve(HERE, 'check-drift.mjs'), argv: [] },
  { id: 'emit-fix-hint', script: resolve(HERE, 'emit-fix-hint.mjs'), argv: ['--self-test'] },
  { id: 'sync-and-push', script: resolve(HERE, 'sync-and-push.mjs'), argv: ['--self-test'] },
];

function defaultSpawn(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', stdio: 'inherit', ...opts });
}

export function main(argv, env = process.env, spawn = defaultSpawn) {
  void argv;
  for (const step of STEPS) {
    const stepEnv = { ...env };
    if (step.id === 'emit-fix-hint') {
      stepEnv.GITHUB_HEAD_REF = '';
    }
    const r = spawn(process.execPath, [step.script, ...step.argv], { env: stepEnv });
    if (r.status !== 0) {
      const stderr = `[dependabot:dryrun] FAIL at step ${step.id} (exit ${r.status})\n`;
      return { exitCode: r.status ?? 1, failedStep: step.id, stderr };
    }
  }
  return { exitCode: 0, failedStep: null, stderr: '' };
}

/* v8 ignore start */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = main(process.argv.slice(2), process.env);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.exitCode);
}
/* v8 ignore stop */
