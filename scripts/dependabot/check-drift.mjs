#!/usr/bin/env node
// scripts/dependabot/check-drift.mjs (bug-20260514 M1 / T-002)
// FORGEAX_BUN_LOCK_OUT_OF_SYNC drift detector for sync-bun-lock-on-dependabot.yml.
// Compares working-tree bun.lock vs `git show HEAD:bun.lock`; exit 0 = same,
// exit 1 = drift / missing. Zero npm deps; node:* stdlib only.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MARKER = 'FORGEAX_BUN_LOCK_OUT_OF_SYNC';
export const LOCK_PATH = 'bun.lock';

export function readWorkingTree(cwd) {
  const path = resolve(cwd, LOCK_PATH);
  try {
    statSync(path);
  } catch (err) {
    return {
      ok: false,
      reason: `bun.lock missing in working tree at ${path}: ${err.code ?? err.message}`,
    };
  }
  try {
    return { ok: true, bytes: readFileSync(path) };
  } catch (err) {
    return {
      ok: false,
      reason: `bun.lock unreadable in working tree at ${path}: ${err.code ?? err.message}`,
    };
  }
}

export function readHeadBlob(cwd) {
  const r = spawnSync('git', ['show', `HEAD:${LOCK_PATH}`], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const stderr = (r.stderr ?? Buffer.from('')).toString('utf8').trim();
    return {
      ok: false,
      reason: `bun.lock not present at HEAD (git show HEAD:${LOCK_PATH} failed): ${stderr}`,
    };
  }
  return { ok: true, bytes: r.stdout };
}

export function checkDrift(cwd) {
  const wt = readWorkingTree(cwd);
  if (!wt.ok) {
    return { exitCode: 1, stdout: '', stderr: `${wt.reason}\n` };
  }
  const head = readHeadBlob(cwd);
  if (!head.ok) {
    return { exitCode: 1, stdout: '', stderr: `${head.reason}\n` };
  }
  if (wt.bytes.equals(head.bytes)) {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  const stdout =
    `${MARKER}\n` +
    `cwd=${cwd}\n` +
    `working-tree-bytes=${wt.bytes.length}\n` +
    `head-blob-bytes=${head.bytes.length}\n`;
  return { exitCode: 1, stdout, stderr: '' };
}

function main() {
  /* v8 ignore start */
  const cwd = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const r = checkDrift(cwd);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.exitCode);
  /* v8 ignore stop */
}

/* v8 ignore start */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
/* v8 ignore stop */
