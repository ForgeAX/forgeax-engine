#!/usr/bin/env bun
// ForgeAX Engine developer command entry.
//
// Usage:
//   bun fx <command> [args...]
//
// Commands:
//   setup                 First-time bootstrap: init submodules + install deps + build
//   update [--dry-run]    Pull root and update submodules
//   clean  [--deep|-x]    Restore a fully-clean git status (keeps .forgeax-harness)
//   help                  Show this text
//
// This is the FIRST bun + TypeScript dev script in the engine (every other
// script under scripts/ is a node .mjs). Accepted exception: fx is
// developer-facing orchestration where studio parity + typed, unit-tested
// command routing earn the bun dependency. Keep it importable under plain Node
// for unit tests: no top-level side effects (guarded main() at the bottom) and
// no runtime Bun.* calls (use node:* + process.execPath; bun types are
// type-only and erased at compile time).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isExpandedSourceRepository } from './lib/source-repository.mjs';
import { createWorktree } from './worktree.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The harness floating clone is never a submodule and must never be deleted by
// clean; it holds unpushed closed-loop state. Also whitelisted from orphan scan.
const HARNESS_DIR = '.forgeax-harness';
const PUBLIC_DISTRIBUTION_MARKER = '.forgeax-public-distribution';
const isPublicDistribution = existsSync(resolve(ROOT, PUBLIC_DISTRIBUTION_MARKER));
const hasExpandedSources = isExpandedSourceRepository(ROOT);

// ── types ────────────────────────────────────────────────────────────────────

type InternalPlan = { type: 'internal'; command: string; args: string[] };
type UnknownPlan = { type: 'unknown'; command: string; args: string[] };
export type CommandPlan = InternalPlan | UnknownPlan;

export type StepScope = 'root' | 'submodule' | 'orphan';
export type StepStatus = 'ok' | 'failed' | 'skipped' | 'planned';
export type StepResult = {
  scope: StepScope;
  name: string;
  result: StepStatus;
  detail?: string;
};

type RunGitOptions = { dryRun?: boolean; inherit?: boolean };

const BUILTIN_COMMANDS = new Set([
  'setup',
  'update',
  'clean',
  'worktree',
  'ci',
  'help',
  '--help',
  '-h',
]);

// ── pure helpers (exported, unit-tested) ─────────────────────────────────────

export function resolveCommand(argv: string[]): CommandPlan {
  const [cmd = 'help', ...args] = argv;
  if (BUILTIN_COMMANDS.has(cmd)) return { type: 'internal', command: cmd, args };
  return { type: 'unknown', command: cmd, args };
}

/** Parse `git config --file .gitmodules --get-regexp path` output. */
export function parseSubmodulePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((p): p is string => Boolean(p));
}

export function submoduleUpdateArgs(path: string): string[] {
  return [
    'submodule',
    'update',
    '--init',
    '--recursive',
    '--depth',
    '1',
    '--jobs',
    '1',
    '--',
    path,
  ];
}

export function parseSubmoduleStatusPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(
      (line) =>
        line
          .trim()
          .match(/^[ +-]?[0-9a-f]{7,40}\s+(.+)$/i)?.[1]
          ?.trim() ?? '',
    )
    .filter(Boolean);
}

export function submoduleUpdateAllArgs(): string[] {
  return ['submodule', 'update', '--init', '--recursive', '--depth', '1', '--jobs', '1'];
}

export function updateStashMessage(iso: string): string {
  return `forgeax pre-update ${iso}`;
}

export function updateShouldStash(args: string[]): boolean {
  return !args.includes('--no-stash');
}

export function didCreateStash(before: string, after: string): boolean {
  return after !== '' && after !== before;
}

export function stashPopArgsForRef(ref: string): string[] {
  return ['stash', 'pop', ref];
}

export type CleanFlags = {
  dryRun: boolean;
  deepRoot: boolean;
  rootCleanFlags: string;
  subForeachCmd: string;
};

export function cleanFlagsFor(args: string[]): CleanFlags {
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const deepRoot = args.includes('--deep') || args.includes('-x');
  return {
    dryRun,
    deepRoot,
    // Root stays conservative by default (keeps gitignored artefacts:
    // node_modules / dist / wasm). --deep/-x wipes those too.
    rootCleanFlags: deepRoot ? '-fdx' : '-fd',
    // Submodule interiors are always deep-cleaned; -ff descends into nested git
    // dirs (uninitialised nested submodules) instead of skipping them.
    subForeachCmd: dryRun
      ? 'git reset --hard -q && git clean -ffndx'
      : 'git reset --hard -q && git clean -ffdx',
  };
}

/**
 * Directories that look like leftover submodules: present on disk with their own
 * `.git`, but no longer declared in `.gitmodules`. `registeredDirs` is the set of
 * top-level entries that contain a `.git` marker; `declaredPaths` is the current
 * `.gitmodules` path set. Whitelisted names (harness, live submodules) are never
 * returned. Pure so the IO (readdir / .git probe) can be tested separately.
 */
export function findOrphanSubmoduleDirs(
  registeredDirs: string[],
  declaredPaths: string[],
  whitelist: string[],
): string[] {
  const declared = new Set(declaredPaths);
  const kept = new Set(whitelist);
  return registeredDirs.filter((dir) => !declared.has(dir) && !kept.has(dir)).sort();
}

/** Actionable hints derived from failed steps; empty when everything passed. */
export function troubleshootHints(results: StepResult[]): string[] {
  const hints: string[] = [];
  const failed = (scope: StepScope) =>
    results.some((r) => r.scope === scope && r.result === 'failed');
  if (failed('root')) {
    hints.push(
      'root update failed: your branch may have diverged from origin/main or hit a conflict. ' +
        'Inspect with `git status`; if a rebase is in progress run `git rebase --abort`, then retry `bun fx update`.',
    );
  }
  if (failed('submodule')) {
    hints.push(
      'submodule update failed: check network/access, then retry ' +
        '`bun fx update` (it recreates only clean non-shallow checkouts at depth=1).',
    );
  }
  if (results.some((r) => r.scope === 'root' && r.name === 'stash-pop' && r.result === 'failed')) {
    hints.push(
      'stash restore failed: your changes are safe in the stash. ' +
        'Run `git stash list`, then `git stash pop` and resolve conflicts manually.',
    );
  }
  return hints;
}

// ── report table (ported from studio formatUpdateReport) ─────────────────────

function cleanTableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

function colorResult(result: string): string {
  if (process.env.NO_COLOR) return result;
  if (result === 'OK') return `\x1b[32m${result}\x1b[0m`;
  if (result === 'FAILED') return `\x1b[31m${result}\x1b[0m`;
  return result;
}

export function formatStepReport(rows: StepResult[]): string {
  const tableRows = rows.map((row) => [
    row.result.toUpperCase(),
    row.scope,
    row.name,
    row.detail ?? '',
  ]);
  const header = ['RESULT', 'SCOPE', 'NAME', 'DETAIL'];
  const widths = header.map((title, i) =>
    Math.max(title.length, ...tableRows.map((row) => cleanTableCell(row[i] ?? '').length)),
  );
  const formatRow = (row: string[], color = false): string =>
    row
      .map((cell, i) => {
        const text = cleanTableCell(cell ?? '').padEnd(widths[i] ?? 0);
        return color && i === 0 ? colorResult(text) : text;
      })
      .join('  ')
      .trimEnd();
  return [
    formatRow(header),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...tableRows.map((row) => formatRow(row, true)),
  ].join('\n');
}

// ── impure helpers (spawn git / fs) ──────────────────────────────────────────

function runGit(args: string[], opts: RunGitOptions = {}): string {
  if (opts.dryRun) {
    console.log(`[dry-run] git ${args.join(' ')}`);
    return '';
  }
  return (
    execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: opts.inherit ? 'inherit' : 'pipe',
    })?.trim() ?? ''
  );
}

function gitOut(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isDirty(): boolean {
  return gitOut(['status', '--porcelain']) !== '';
}

function stashTopOid(): string {
  return gitOut(['rev-parse', '--verify', 'stash@{0}']);
}

function submodulePaths(): string[] {
  return parseSubmodulePaths(gitOut(['config', '--file', '.gitmodules', '--get-regexp', 'path']));
}

function recursiveSubmoduleCheckoutPaths(path: string): string[] {
  const nested = parseSubmoduleStatusPaths(
    gitOut(['-C', path, 'submodule', 'status', '--recursive']),
  );
  return [path, ...nested.map((child) => join(path, child))];
}

function submoduleTreeIsClean(path: string): boolean {
  return recursiveSubmoduleCheckoutPaths(path).every((checkout) => {
    if (!existsSync(resolve(ROOT, checkout))) return true;
    return (
      gitOut([
        '-C',
        checkout,
        'status',
        '--porcelain',
        '--ignore-submodules=none',
        '--untracked-files=all',
      ]) === ''
    );
  });
}

function submoduleTreeNeedsDepthRefresh(path: string): boolean {
  return recursiveSubmoduleCheckoutPaths(path).some((checkout) => {
    if (!existsSync(resolve(ROOT, checkout))) return false;
    const shallow = gitOut(['-C', checkout, 'rev-parse', '--is-shallow-repository']);
    const commits = gitOut(['-C', checkout, 'rev-list', '--count', 'HEAD']);
    return shallow !== 'true' || commits !== '1';
  });
}

function updateSubmoduleDepthOne(path: string, dryRun: boolean): StepResult {
  if (dryRun) {
    return runGitStep(
      'submodule',
      path,
      submoduleUpdateArgs(path),
      true,
      'would sync to recorded pin with depth=1',
    );
  }

  if (!submoduleTreeIsClean(path)) {
    return {
      scope: 'submodule',
      name: path,
      result: 'failed',
      detail: 'submodule has local tracked/untracked changes; refusing depth refresh',
    };
  }

  if (submoduleTreeNeedsDepthRefresh(path)) {
    const deinit = runGitStep(
      'submodule',
      `${path} (recreate shallow checkout)`,
      ['submodule', 'deinit', '--force', '--', path],
      false,
      'removed non-shallow checkout after clean-state check',
    );
    if (deinit.result === 'failed') return deinit;
  }

  const update = runGitStep(
    'submodule',
    path,
    submoduleUpdateArgs(path),
    false,
    'synced to recorded pin with depth=1',
  );
  if (update.result === 'failed') return update;

  const invalid = recursiveSubmoduleCheckoutPaths(path).filter((checkout) => {
    if (!existsSync(resolve(ROOT, checkout))) return true;
    return (
      gitOut(['-C', checkout, 'rev-parse', '--is-shallow-repository']) !== 'true' ||
      gitOut(['-C', checkout, 'rev-list', '--count', 'HEAD']) !== '1'
    );
  });
  if (invalid.length > 0) {
    return {
      scope: 'submodule',
      name: path,
      result: 'failed',
      detail: `depth=1 verification failed for ${invalid.join(', ')}`,
    };
  }
  return update;
}

/** Top-level directories that carry their own `.git` (nested repos/submodules). */
function nestedGitDirs(): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue;
    if (existsSync(resolve(ROOT, name, '.git'))) out.push(name);
  }
  return out;
}

/** Orphan submodule dirs on disk (declared-in-.gitmodules + harness are kept). */
function listOrphanSubmoduleDirs(): string[] {
  return findOrphanSubmoduleDirs(nestedGitDirs(), submodulePaths(), [HARNESS_DIR]);
}

function runGitStep(
  scope: StepScope,
  name: string,
  args: string[],
  dryRun: boolean,
  okDetail: string,
): StepResult {
  if (dryRun) {
    console.log(`[dry-run] git ${args.join(' ')}`);
    return { scope, name, result: 'planned', detail: `git ${args.join(' ')}` };
  }
  console.log(`[fx] git ${args.join(' ')}`);
  const r = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    return { scope, name, result: 'failed', detail: `cannot run git: ${r.error.message}` };
  }
  const status = r.status ?? 1;
  if (status === 0) return { scope, name, result: 'ok', detail: okDetail };
  return { scope, name, result: 'failed', detail: `git ${args.join(' ')} exited ${status}` };
}

function restoreStashResult(ref: string, dryRun: boolean): StepResult {
  const args = stashPopArgsForRef(ref);
  if (dryRun) {
    console.log(`[dry-run] git ${args.join(' ')}`);
    return { scope: 'root', name: 'stash-pop', result: 'planned', detail: `git ${args.join(' ')}` };
  }
  const r = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit' });
  const status = r.status ?? 1;
  if (status === 0)
    return { scope: 'root', name: 'stash-pop', result: 'ok', detail: 'restored pre-update stash' };
  return {
    scope: 'root',
    name: 'stash-pop',
    result: 'failed',
    detail: `stash pop exited ${status}`,
  };
}

// ── commands ─────────────────────────────────────────────────────────────────

function finish(results: StepResult[], hintScopes = false): never {
  console.log(`\n${formatStepReport(results)}`);
  if (hintScopes) {
    const hints = troubleshootHints(results);
    if (hints.length > 0) {
      console.error('\n[fx] hints:');
      for (const h of hints) console.error(`  - ${h}`);
    }
  }
  process.exit(results.some((r) => r.result === 'failed') ? 1 : 0);
}

// setup — first-time bootstrap. Idempotent; safe to re-run.
function setup(args: string[]): never {
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const results: StepResult[] = [];
  const buildCommand = isPublicDistribution ? 'build:engine' : 'build';
  console.log(
    `[fx] setup: ${hasExpandedSources ? 'expanded source - no submodules' : 'initialising submodules'} + installing dependencies + ${buildCommand}`,
  );

  results.push(
    hasExpandedSources
      ? {
          scope: 'submodule',
          name: '(all)',
          result: 'skipped',
          detail: 'expanded source requires no submodule initialization',
        }
      : runGitStep(
          'submodule',
          '(all)',
          submoduleUpdateAllArgs(),
          dryRun,
          'submodules initialised with depth=1',
        ),
  );

  if (dryRun) {
    console.log('[dry-run] pnpm install');
    results.push({ scope: 'root', name: '.', result: 'planned', detail: 'pnpm install' });
  } else {
    console.log('[fx] pnpm install');
    const r = spawnSync('pnpm', ['install'], { cwd: ROOT, stdio: 'inherit' });
    if (r.error) {
      results.push({
        scope: 'root',
        name: '.',
        result: 'failed',
        detail: `cannot run pnpm: ${r.error.message}`,
      });
    } else {
      const status = r.status ?? 1;
      results.push({
        scope: 'root',
        name: '.',
        result: status === 0 ? 'ok' : 'failed',
        detail: status === 0 ? 'dependencies installed' : `pnpm install exited ${status}`,
      });
    }
  }
  const installSucceeded = results.at(-1)?.result === 'ok' || results.at(-1)?.result === 'planned';
  if (installSucceeded) {
    if (dryRun) {
      console.log('[dry-run] node scripts/forgeax/link-template-agents.mjs');
      results.push({
        scope: 'root',
        name: 'templates/AGENTS.md',
        result: 'planned',
        detail: 'link shared game instructions',
      });
    } else {
      console.log('[fx] linking shared template AGENTS.md');
      const linked = spawnSync('node', ['scripts/forgeax/link-template-agents.mjs'], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      results.push({
        scope: 'root',
        name: 'templates/AGENTS.md',
        result: linked.status === 0 ? 'ok' : 'failed',
        detail:
          linked.status === 0 ? 'game template links ready' : `linker exited ${linked.status ?? 1}`,
      });
    }
  }
  const linksSucceeded = results.at(-1)?.result === 'ok' || results.at(-1)?.result === 'planned';
  if (installSucceeded && linksSucceeded) {
    if (dryRun) {
      console.log(`[dry-run] pnpm ${buildCommand}`);
      results.push({ scope: 'root', name: '.', result: 'planned', detail: `pnpm ${buildCommand}` });
    } else {
      console.log(`[fx] pnpm ${buildCommand}`);
      const r = spawnSync('pnpm', [buildCommand], { cwd: ROOT, stdio: 'inherit' });
      if (r.error) {
        results.push({
          scope: 'root',
          name: '.',
          result: 'failed',
          detail: `cannot run pnpm ${buildCommand}: ${r.error.message}`,
        });
      } else {
        const status = r.status ?? 1;
        results.push({
          scope: 'root',
          name: '.',
          result: status === 0 ? 'ok' : 'failed',
          detail: status === 0 ? 'build completed' : `pnpm ${buildCommand} exited ${status}`,
        });
      }
    }
  }
  finish(results, true);
}

// update — pull root and update clean submodules at depth=1.
function update(args: string[]): never {
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const stash = updateShouldStash(args);
  const results: StepResult[] = [];
  let stashedRef = '';

  console.log('[fx] update: checking working tree');
  if (isDirty()) {
    if (!stash) {
      console.error(
        '[fx] local changes detected. Commit/stash them, or drop --no-stash to auto-stash.',
      );
      process.exit(2);
    }
    const before = dryRun ? '' : stashTopOid();
    const iso = dryRun ? '<now>' : new Date().toISOString();
    runGit(['stash', 'push', '-u', '-m', updateStashMessage(iso)], { dryRun, inherit: true });
    const after = dryRun ? 'planned' : stashTopOid();
    if (didCreateStash(before, after)) {
      stashedRef = dryRun ? 'planned' : 'stash@{0}';
    } else {
      console.log('[fx] no stash created (submodule-only changes); leaving them in place');
    }
  } else {
    console.log('[fx] working tree clean');
  }

  console.log('[fx] update: root repository');
  const up = gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up) {
    results.push(
      runGitStep(
        'root',
        '.',
        ['pull', '--ff-only', '--no-recurse-submodules'],
        dryRun,
        'pulled latest root',
      ),
    );
  } else {
    console.log('[fx] no upstream; fetching origin/main and rebasing');
    const fetched = runGitStep(
      'root',
      '.',
      ['fetch', '--no-recurse-submodules', 'origin', 'main'],
      dryRun,
      'fetched origin/main',
    );
    results.push(fetched);
    if (fetched.result !== 'failed') {
      results.push(
        runGitStep('root', '.', ['rebase', 'origin/main'], dryRun, 'rebased onto origin/main'),
      );
    }
  }

  const rootOk = !results.some((r) => r.scope === 'root' && r.result === 'failed');

  if (rootOk) {
    if (hasExpandedSources) {
      results.push({
        scope: 'submodule',
        name: '(all)',
        result: 'skipped',
        detail: 'expanded source requires no submodule initialization',
      });
    } else {
      console.log('[fx] update: submodules (depth=1, jobs=1)');
      const paths = submodulePaths();
      if (paths.length === 0) {
        results.push({
          scope: 'submodule',
          name: '(none)',
          result: 'skipped',
          detail: 'no submodules configured',
        });
      } else {
        for (const p of paths) {
          results.push(updateSubmoduleDepthOne(p, dryRun));
        }
      }
    }
  } else {
    results.push({
      scope: 'submodule',
      name: '(all)',
      result: 'skipped',
      detail: 'root update failed',
    });
  }

  if (stashedRef) {
    console.log('[fx] restoring pre-update stash');
    results.push(restoreStashResult(stashedRef, dryRun));
  }

  finish(results, true);
}

// clean — restore a fully-clean git status; keep .forgeax-harness always.
function clean(args: string[]): never {
  const { dryRun, deepRoot, rootCleanFlags, subForeachCmd } = cleanFlagsFor(args);
  const results: StepResult[] = [];

  const step = (scope: StepScope, name: string, gitArgs: string[], okDetail: string): void => {
    results.push(runGitStep(scope, name, gitArgs, dryRun, okDetail));
  };

  console.log(
    `[fx] clean · root: ${deepRoot ? 'deep (wipes gitignored artefacts — re-run bun fx setup after)' : 'standard (keeps node_modules/dist)'}` +
      ` · submodules: always deep${dryRun ? ' · DRY RUN' : ''}`,
  );

  // 1. discard tracked edits + reset submodule pointers to recorded pins.
  step('root', '.', ['reset', '--hard'], 'reset tracked changes');
  // 2. sync submodule checkouts to pins (init any missing / nested).
  if (isPublicDistribution) {
    results.push({
      scope: 'submodule',
      name: '(all)',
      result: 'skipped',
      detail: 'expanded source requires no submodule initialization',
    });
  } else {
    step(
      'submodule',
      '(all)',
      [...submoduleUpdateAllArgs(), '--force'],
      'checkouts synced to pins with depth=1',
    );
    // 3. scrub every submodule tree to bare pin state so none reports "modified" upward.
    step(
      'submodule',
      '(all)',
      ['submodule', 'foreach', '--recursive', subForeachCmd],
      'submodule trees scrubbed',
    );
  }

  // 4. remove orphan submodule dirs (registered in git but dropped from
  //    .gitmodules). Whitelisted names (harness / live submodules) never match.
  for (const orphan of listOrphanSubmoduleDirs()) {
    if (dryRun) {
      console.log(`[dry-run] rm -rf ${orphan} && rm -rf .git/modules/${orphan}`);
      results.push({
        scope: 'orphan',
        name: orphan,
        result: 'planned',
        detail: `remove orphan submodule dir + .git/modules/${orphan}`,
      });
      continue;
    }
    console.log(`[fx] removing orphan submodule dir: ${orphan}`);
    try {
      rmSync(resolve(ROOT, orphan), { recursive: true, force: true });
      rmSync(resolve(ROOT, '.git', 'modules', orphan), { recursive: true, force: true });
      results.push({
        scope: 'orphan',
        name: orphan,
        result: 'ok',
        detail: 'orphan submodule dir removed',
      });
    } catch (err) {
      results.push({
        scope: 'orphan',
        name: orphan,
        result: 'failed',
        detail: `remove failed: ${(err as Error).message}`,
      });
    }
  }

  // 5. remove root untracked files, always preserving the harness floating clone.
  step(
    'root',
    '.',
    ['clean', rootCleanFlags, '-e', HARNESS_DIR, ...(dryRun ? ['-n'] : [])],
    'root untracked removed',
  );

  console.log(`\n${formatStepReport(results)}`);

  if (!dryRun) {
    const stillDirty = gitOut(['status', '--porcelain']);
    if (stillDirty === '') {
      console.log('\n[fx] working tree is now completely clean');
    } else {
      console.log('\n[fx] remaining after clean (inspect manually):');
      console.log(stillDirty);
    }
  }

  const hints = troubleshootHints(results);
  if (hints.length > 0) {
    console.error('\n[fx] hints:');
    for (const h of hints) console.error(`  - ${h}`);
  }
  process.exit(results.some((r) => r.result === 'failed') ? 1 : 0);
}

// CI uses the same focused source runner as pnpm ci:focus.
function ci(args: string[]): never {
  const result = spawnSync('node', ['scripts/ci/run-ci-focus.mjs', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

function usage(): void {
  console.log(`ForgeAX Engine developer CLI

Usage:
  bun fx <command> [args...]

Commands:
  setup                 First-time bootstrap: contributor checkouts initialise
                        git submodules; public SDK source skips them. Both run
                        pnpm install (public source also runs pnpm build:engine).
                        (postinstall materialises ${HARNESS_DIR}). Idempotent —
                        safe to re-run.
  update [flags]        Pull root (ff-only), keep clean submodules at Git depth=1,
                        and fast-forward the ${HARNESS_DIR} floating clone.
                        --dry-run/-n   preview without changing anything
                        --no-stash     fail instead of auto-stashing a dirty tree
  clean  [flags]        Restore a fully-clean git status. Discards uncommitted
                        edits, scrubs submodule interiors to pin state, removes
                        orphan submodule dirs, and cleans root untracked files.
                        Always keeps ${HARNESS_DIR}.
                        --deep/-x      also wipe root gitignored artefacts
                                       (node_modules/dist) — re-run setup after
                        --dry-run/-n   preview without deleting anything
  ci [flags]             Reproduce browser, Dawn, unit or Smoke gates from source.
                        --dry-run       print the selected commands
                        Example: bun fx ci --kind dawn --select transmission
  worktree <name>        Create one complete, disk-conscious worktree:
                        recursive submodules and
                        frozen dependencies ready for bun fx ci.
                        --from REF      create from a different commit/ref
                        --jobs N        bound recursive submodule parallelism (1..8)
                        --no-setup/--fast skip dependency installation
                        --keep-on-failure retain a failed bootstrap for inspection
                        --dry-run/-n     print the plan without changing anything
  help                  Show this text

Examples:
  bun fx setup
  bun fx update --dry-run
  bun fx clean --dry-run
  bun fx clean --deep
  bun fx worktree feature-name
  bun fx ci --kind dawn --select transmission --dry-run
`);
}

function main(): void {
  const plan = resolveCommand(process.argv.slice(2));
  if (plan.type === 'unknown') {
    console.error(`[fx] unknown command: ${plan.command}`);
    usage();
    process.exit(2);
  }
  try {
    switch (plan.command) {
      case 'help':
      case '--help':
      case '-h':
        usage();
        break;
      case 'setup':
        setup(plan.args);
        break;
      case 'update':
        update(plan.args);
        break;
      case 'clean':
        clean(plan.args);
        break;
      case 'worktree':
        createWorktree(plan.args);
        break;
      case 'ci':
        ci(plan.args);
        break;
      default:
        console.error(`[fx] unhandled command: ${plan.command}`);
        process.exit(2);
    }
  } catch (err) {
    console.error(`[fx] unexpected error: ${(err as Error).message}`);
    console.error("  run 'bun fx help', or report this if it persists.");
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
