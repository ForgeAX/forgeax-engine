#!/usr/bin/env node

// scripts/dependabot/emit-fix-hint.mjs (bug-20260514 M2 / T-005)
// FORGEAX_BUN_LOCK_OUT_OF_SYNC structured fail-hint emitter for
// sync-bun-lock-on-dependabot.yml (AC-03 fallback path; plan-strategy 7.3).
// Zero npm deps; node:* stdlib only.

import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MARKER = 'FORGEAX_BUN_LOCK_OUT_OF_SYNC';
export const SELF_TEST_REF = 'dependabot/npm_and_yarn/self-test-placeholder';
export const COMMIT_MESSAGE = 'chore(deps): sync bun.lock for dependabot bump';

export function buildHint(ref) {
  const lines = [
    `::error title=${MARKER}::bun.lock drift detected on dependabot PR branch`,
    '::group::FIX_INSTRUCTIONS',
    `ref: ${ref}`,
    'commands:',
    `  git fetch origin ${ref}:_dependabot_fix`,
    '  git checkout _dependabot_fix',
    '  bun install --ignore-scripts',
    '  git add bun.lock',
    `  git commit -m "${COMMIT_MESSAGE}"`,
    `  git push origin HEAD:${ref}`,
    'docs: AGENTS.md Conventions Dual lockfile (search the marker above)',
    '::endgroup::',
  ];
  return `${lines.join('\n')}\n`;
}

function parseRef(argv, env) {
  for (const arg of argv) {
    if (arg.startsWith('--ref=')) return arg.slice('--ref='.length);
  }
  if (env.GITHUB_HEAD_REF && env.GITHUB_HEAD_REF.length > 0) return env.GITHUB_HEAD_REF;
  return null;
}

export function main(argv, env) {
  const ref = parseRef(argv, env);
  if (ref === null) {
    return { exitCode: 0, stdout: buildHint(SELF_TEST_REF) };
  }
  return { exitCode: 1, stdout: buildHint(ref) };
}

/* v8 ignore start */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = main(process.argv.slice(2), process.env);
  if (r.stdout) process.stdout.write(r.stdout);
  process.exit(r.exitCode);
}
/* v8 ignore stop */
