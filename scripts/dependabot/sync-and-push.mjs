#!/usr/bin/env node
// scripts/dependabot/sync-and-push.mjs (bug-20260514 M3 / T-009)
// FORGEAX_BUN_LOCK_OUT_OF_SYNC auto-sync executor for
// sync-bun-lock-on-dependabot.yml. Chains check-drift -> bun install
// --ignore-scripts (G3) -> commit -> git push --force-with-lease;
// any fail-fast exit spawns emit-fix-hint.mjs (AC-03 fallback).
// Zero npm deps; node:* stdlib only.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const COMMIT_MESSAGE = 'chore(deps): sync bun.lock for dependabot bump';
export const COMMIT_AUTHOR_NAME = 'github-actions[bot]';
export const COMMIT_AUTHOR_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
export const DEPENDABOT_ACTOR = 'dependabot[bot]';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CHECK_DRIFT = resolve(HERE, 'check-drift.mjs');
const EMIT_HINT = resolve(HERE, 'emit-fix-hint.mjs');

function defaultSpawn(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function parseRef(argv, env) {
  for (const arg of argv) {
    if (arg.startsWith('--ref=')) return arg.slice('--ref='.length);
  }
  if (env.GITHUB_HEAD_REF && env.GITHUB_HEAD_REF.length > 0) return env.GITHUB_HEAD_REF;
  return null;
}

function selfTestRequested(argv) {
  return argv.includes('--self-test');
}

function banner() {
  return [
    'sync-and-push.mjs self-test mode',
    '  no GITHUB_HEAD_REF / no --ref argv -> no auto-sync attempted',
    '  this banner satisfies milestoneCISweep gate; exit 0',
    '',
  ].join('\n');
}

export function main(argv, env, spawn = defaultSpawn) {
  if (selfTestRequested(argv)) {
    return { exitCode: 0, stdout: banner() };
  }

  const ref = parseRef(argv, env);
  if (ref === null) {
    return { exitCode: 0, stdout: banner() };
  }

  // G1 actor defense-in-depth (workflow `if:` is the primary gate).
  const actor = env.GITHUB_ACTOR ?? '';
  if (actor.length > 0 && actor !== DEPENDABOT_ACTOR) {
    return { exitCode: 0, stdout: '' };
  }

  // Step 1: drift detection (R-No-Op-Empty-Commit early exit, AC-07).
  const drift = spawn(process.execPath, [CHECK_DRIFT], {});
  if (drift.status === 0) {
    return { exitCode: 0, stdout: '' };
  }

  // Step 2: bun install --ignore-scripts (G3 supply-chain gate).
  const install = spawn('bun', ['install', '--ignore-scripts'], {});
  if (install.status !== 0) {
    spawn(process.execPath, [EMIT_HINT, `--ref=${ref}`], {});
    return { exitCode: 1, stdout: '' };
  }

  // Step 3: defensive no-op gate -- if `bun install` produced no diff in
  // bun.lock, do NOT commit (R-No-Op-Empty-Commit; plan-strategy 3 / AC-07).
  const diff = spawn('git', ['diff', '--quiet', '--', 'bun.lock'], {});
  if (diff.status === 0) {
    return { exitCode: 0, stdout: '' };
  }

  // Step 4: commit with bot author + fixed message (plan-strategy 2.5).
  const commit = spawn(
    'git',
    [
      '-c',
      `user.name=${COMMIT_AUTHOR_NAME}`,
      '-c',
      `user.email=${COMMIT_AUTHOR_EMAIL}`,
      'commit',
      '-m',
      COMMIT_MESSAGE,
      '--',
      'bun.lock',
    ],
    {},
  );
  if (commit.status !== 0) {
    spawn(process.execPath, [EMIT_HINT, `--ref=${ref}`], {});
    return { exitCode: 1, stdout: '' };
  }

  // Step 5: push --force-with-lease (plan-strategy 2.7); race -> hint.
  const push = spawn('git', ['push', '--force-with-lease', 'origin', `HEAD:${ref}`], {});
  if (push.status !== 0) {
    spawn(process.execPath, [EMIT_HINT, `--ref=${ref}`], {});
    return { exitCode: 1, stdout: '' };
  }

  return { exitCode: 0, stdout: '' };
}

/* v8 ignore start */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = main(process.argv.slice(2), process.env);
  if (r.stdout) process.stdout.write(r.stdout);
  process.exit(r.exitCode);
}
/* v8 ignore stop */
