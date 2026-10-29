#!/usr/bin/env node
// Seed a fresh checkout with another worktree's ignored build outputs.
//
//   node scripts/seed-build-outputs.mjs [--from <built worktree>] [--dry-run]
//
// A new worktree otherwise rebuilds Rust/WASM producers, every package, all
// declarations and the shared shader producer from nothing. Seeding copies the
// sibling's generated outputs and task receipts; `pnpm build:engine` then
// verifies them exactly like an in-place incremental build (content-fingerprint
// receipts, WASM content keys, producer manifests, `tsc -b` up-to-date checks)
// and rebuilds whatever differs. Existing paths in the target are never replaced.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TASK_CACHE = 'node_modules/.cache/forgeax-build';
// Toolchain installs and Rust scratch are per-checkout; neither is a build output.
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.wasm-build', '.git']);
// Package outputs, app outputs and the shared/released shader producer inputs.
const SEEDED_ROOTS = new Set([
  'packages',
  'apps',
  'shared-build-inputs',
  'shared-build-inputs-release',
]);

const canonical = (path) => (existsSync(path) ? realpathSync.native(path) : resolve(path));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
}

export function worktreeRoots(root) {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => canonical(line.slice('worktree '.length).trim()));
}

/** The most recently built sibling, judged by its build summary. */
export function newestBuiltWorktree(root) {
  const self = canonical(root);
  let best;
  for (const candidate of worktreeRoots(root)) {
    if (candidate === self) continue;
    const summary = join(candidate, TASK_CACHE, 'summary.json');
    if (!existsSync(summary)) continue;
    const mtimeMs = statSync(summary).mtimeMs;
    if (best === undefined || mtimeMs > best.mtimeMs) best = { root: candidate, mtimeMs };
  }
  return best?.root;
}

/** Ignored generated paths of `source`, as repository-relative POSIX paths. */
export function buildOutputPaths(source) {
  const ignored = git(source, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
  ])
    .split('\n')
    .map((line) => line.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .filter((path) => {
      const parts = path.split('/');
      return SEEDED_ROOTS.has(parts[0] ?? '') && !parts.some((part) => EXCLUDED_SEGMENTS.has(part));
    });
  return [...ignored, TASK_CACHE].sort();
}

export function seedBuildOutputs({ root, from, dryRun = false, log = console.error }) {
  const target = canonical(root);
  const source = canonical(from);
  if (source === target) throw new Error('seed source and target are the same checkout');
  if (!existsSync(join(source, TASK_CACHE, 'summary.json')))
    throw new Error(`seed source has no completed build: ${source}`);
  const copied = [];
  const kept = [];
  for (const path of buildOutputPaths(source)) {
    const from = join(source, path);
    const to = join(target, path);
    if (!existsSync(from)) continue;
    if (existsSync(to)) {
      kept.push(path);
      continue;
    }
    if (!dryRun) cpSync(from, to, { recursive: true, preserveTimestamps: true });
    copied.push(path);
  }
  log(
    `[seed-build-outputs] ${dryRun ? 'would copy' : 'copied'} ${copied.length} path(s) from ${source}; kept ${kept.length} existing`,
  );
  return { source, copied, kept };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(process.env.FORGEAX_REPO_ROOT ?? '.');
  const fromIndex = process.argv.indexOf('--from');
  const from = fromIndex > 0 ? process.argv[fromIndex + 1] : newestBuiltWorktree(root);
  if (from === undefined) {
    console.error('[seed-build-outputs] no built sibling worktree found; pass --from <path>');
    process.exit(1);
  }
  seedBuildOutputs({ root, from, dryRun: process.argv.includes('--dry-run') });
}
