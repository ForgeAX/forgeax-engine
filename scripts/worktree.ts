#!/usr/bin/env bun
// Complete, disk-conscious bootstrap for an Engine Git worktree.

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runnerResources } from './lib/runner-resources.mjs';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREES_DIR = '.worktrees';
const DEFAULT_JOBS = Math.min(4, runnerResources().cpus);
const MAX_WORKTREES = 16;

const BOOTSTRAP_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
};

let bootstrapInterrupted = false;

export type WorktreeOptions = {
  readonly name: string;
  readonly from: string;
  readonly jobs: number;
  readonly dryRun: boolean;
  readonly noSetup: boolean;
  readonly keepOnFailure: boolean;
};

function gitOutput(args: readonly string[], cwd: string): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: BOOTSTRAP_ENV,
    }).trim();
  } catch {
    return '';
  }
}

function gitStatus(args: readonly string[], cwd: string): number {
  const result = spawnSync('git', [...args], {
    cwd,
    stdio: 'ignore',
    env: BOOTSTRAP_ENV,
  });
  return result.status ?? 1;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  label: string,
  env: NodeJS.ProcessEnv = BOOTSTRAP_ENV,
  allowInterrupted = false,
): void {
  console.log(`\n[worktree] ${label}`);
  const result = spawnSync(command, [...args], { cwd, stdio: 'inherit', env });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (bootstrapInterrupted && !allowInterrupted) throw new Error(`${label} interrupted`);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed${result.status === null ? ' (terminated by signal)' : ` (exit ${result.status ?? 1})`}`,
    );
  }
}

function installSignalGuard(): () => void {
  bootstrapInterrupted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    bootstrapInterrupted = true;
    console.error(`[worktree] ${signal} received; stopping and cleaning the new worktree`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function repositoryRoot(cwd: string): string {
  const root = gitOutput(['rev-parse', '--show-toplevel'], cwd);
  if (!root) throw new Error('bun fx worktree must run inside a Git checkout');
  return resolve(root);
}

function commonRepositoryRoot(root: string): string {
  const commonDir = gitOutput(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  if (!commonDir) throw new Error('could not resolve the Git common directory');
  return resolve(dirname(commonDir));
}

export function parseWorktreeOptions(argv: readonly string[]): WorktreeOptions {
  const name = argv[0] ?? '';
  if (!name || name.startsWith('-')) {
    throw new Error(
      'usage: bun fx worktree <name> [--from REF] [--jobs N] [--no-setup] [--keep-on-failure] [--dry-run]',
    );
  }

  let from = 'HEAD';
  let jobs = DEFAULT_JOBS;
  let dryRun = false;
  let noSetup = false;
  let keepOnFailure = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
    } else if (arg === '--no-setup' || arg === '--fast') {
      noSetup = true;
    } else if (arg === '--keep-on-failure') {
      keepOnFailure = true;
    } else if (arg === '--from' || arg === '--jobs') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--from') {
        from = value;
      } else {
        jobs = parseJobs(value);
      }
    } else if (arg.startsWith('--from=')) {
      from = arg.slice('--from='.length);
      if (!from) throw new Error('--from needs a git ref');
    } else if (arg.startsWith('--jobs=')) {
      jobs = parseJobs(arg.slice('--jobs='.length));
    } else {
      throw new Error(`unknown worktree flag: ${arg}`);
    }
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..') || name.endsWith('/')) {
    throw new Error('worktree name must be a simple git-safe name (letters, numbers, ., _, -, /)');
  }
  if (!from) throw new Error('--from needs a git ref');
  return { name, from, jobs, dryRun, noSetup, keepOnFailure };
}

function parseJobs(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 8) {
    throw new Error('--jobs must be an integer from 1 to 8');
  }
  return Number(value);
}

export function branchFor(name: string): string {
  return name.startsWith('codex/') ? name : `codex/${name}`;
}

export function directoryFor(name: string): string {
  const slug = name
    .replace(/^codex\//, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('worktree name produces an empty directory name');
  return slug;
}

export function submoduleUpdateArgs(jobs: number, reference?: string): string[] {
  return [
    'submodule',
    'update',
    '--init',
    '--recursive',
    '--depth',
    '1',
    '--jobs',
    String(jobs),
    ...(reference ? ['--reference', reference] : []),
  ];
}

export function submoduleStatusProblems(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^[-+U][0-9a-f]{7,40}\s+(.+)$/i)?.[1]?.trim() ?? '')
    .filter(Boolean);
}

function worktreeCount(root: string): number {
  return gitOutput(['worktree', 'list', '--porcelain'], root)
    .split(/^worktree /m)
    .filter((entry) => entry.trim() !== '').length;
}

function isGitCheckout(path: string): boolean {
  if (!pathExists(path)) return false;
  const topLevel = gitOutput(['rev-parse', '--show-toplevel'], path);
  const head = gitOutput(['rev-parse', '--verify', 'HEAD'], path);
  return Boolean(topLevel && head && resolve(topLevel) === resolve(path));
}

function isShallowGitCheckout(path: string): boolean {
  return gitOutput(['rev-parse', '--is-shallow-repository'], path) === 'true';
}

export function submoduleReference(commonRoot: string): string | undefined {
  const assetsRoot = join(commonRoot, 'forgeax-engine-assets');
  return isGitCheckout(assetsRoot) && !isShallowGitCheckout(assetsRoot) ? assetsRoot : undefined;
}

function initializeSubmodules(targetRoot: string, commonRoot: string, jobs: number): void {
  run(
    'git',
    ['submodule', 'sync', '--recursive'],
    targetRoot,
    'synchronizing recursive submodule URLs',
  );
  const reference = submoduleReference(commonRoot);
  const shallow = spawnSync('git', submoduleUpdateArgs(jobs, reference), {
    cwd: targetRoot,
    stdio: 'inherit',
    env: BOOTSTRAP_ENV,
  });
  if (shallow.error)
    throw new Error(`recursive submodule initialization could not start: ${shallow.error.message}`);
  if (bootstrapInterrupted) throw new Error('recursive submodule initialization interrupted');
  if (shallow.status !== 0) {
    throw new Error(
      'recursive submodule initialization failed; the shallow checkout was not retried at full depth to protect disk space',
    );
  }

  const status = spawnSync('git', ['submodule', 'status', '--recursive'], {
    cwd: targetRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: BOOTSTRAP_ENV,
  });
  if (bootstrapInterrupted) throw new Error('recursive submodule status check interrupted');
  const problems = submoduleStatusProblems(String(status.stdout ?? ''));
  if ((status.status ?? 1) !== 0 || problems.length > 0) {
    throw new Error(
      `recursive submodule initialization is incomplete${problems.length > 0 ? `: ${problems.join(', ')}` : ''}`,
    );
  }
}

function installDependencies(targetRoot: string): void {
  run(
    'pnpm',
    ['install', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline'],
    targetRoot,
    'installing dependencies from the shared pnpm store',
  );
}

function removeCreatedWorktree(root: string, targetRoot: string, branch: string): void {
  if (pathExists(targetRoot)) {
    run(
      'git',
      ['worktree', 'remove', '--force', targetRoot],
      root,
      'removing failed worktree',
      BOOTSTRAP_ENV,
      true,
    );
  }
  if (gitStatus(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root) === 0) {
    run(
      'git',
      ['branch', '-D', branch],
      root,
      'removing failed worktree branch',
      BOOTSTRAP_ENV,
      true,
    );
  }
}

function printReady(targetRoot: string, branch: string, noSetup: boolean): void {
  console.log('\n[worktree] ready');
  console.log(`  path       ${targetRoot}`);
  console.log(`  branch     ${branch}`);
  console.log('  harness    shared common clone (no disk copy)');
  console.log(`  setup      ${noSetup ? 'skipped (--no-setup)' : 'dependencies installed'}`);
  if (noSetup) {
    console.log(
      '  note       run pnpm install --frozen-lockfile --ignore-scripts before bun fx ci',
    );
  }
  console.log(`\nNext:\n  cd ${targetRoot}\n  bun fx ci`);
  console.log(`\nRemove later with:\n  git worktree remove ${targetRoot}`);
}

export function createWorktree(argv: readonly string[], sourceRoot = ENGINE_ROOT): void {
  const options = parseWorktreeOptions(argv);
  const root = repositoryRoot(sourceRoot);
  const commonRoot = commonRepositoryRoot(root);
  const branch = branchFor(options.name);
  const targetRoot = join(root, WORKTREES_DIR, directoryFor(options.name));

  if (pathExists(targetRoot)) throw new Error(`worktree directory already exists: ${targetRoot}`);
  if (gitStatus(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root) === 0) {
    throw new Error(`branch already exists: ${branch} (choose another name)`);
  }
  if (gitStatus(['rev-parse', '--verify', `${options.from}^{commit}`], root) !== 0) {
    throw new Error(`git ref does not resolve to a commit: ${options.from}`);
  }
  const count = worktreeCount(root);
  if (count >= MAX_WORKTREES) {
    throw new Error(
      `refusing to create another worktree: ${count} are already registered (limit ${MAX_WORKTREES}); remove unused worktrees first`,
    );
  }

  const reference = submoduleReference(commonRoot);
  if (options.dryRun) {
    console.log(`[dry-run] git worktree add -b ${branch} ${targetRoot} ${options.from}`);
    console.log(
      `[dry-run] git submodule sync/update --init --recursive --depth 1 --jobs ${options.jobs}${reference ? ` --reference ${reference}` : ''}`,
    );
    if (!options.noSetup)
      console.log('[dry-run] pnpm install --frozen-lockfile --ignore-scripts --prefer-offline');
    return;
  }

  mkdirSync(join(root, WORKTREES_DIR), { recursive: true });
  let created = false;
  const removeSignalGuard = installSignalGuard();
  try {
    if (gitOutput(['status', '--porcelain'], root)) {
      console.warn(
        '[worktree] source checkout has uncommitted changes; only the selected ref will be copied',
      );
    }
    run(
      'git',
      ['worktree', 'add', '-b', branch, targetRoot, options.from],
      root,
      `creating ${branch}`,
    );
    created = true;

    initializeSubmodules(targetRoot, commonRoot, options.jobs);
    if (!options.noSetup) installDependencies(targetRoot);
    printReady(targetRoot, branch, options.noSetup);
  } catch (error) {
    if (created && !options.keepOnFailure) {
      try {
        removeCreatedWorktree(root, targetRoot, branch);
      } catch (cleanupError) {
        console.error(
          `[worktree] automatic cleanup failed; inspect ${targetRoot}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    } else if (created) {
      console.error(`[worktree] bootstrap stopped; keeping ${targetRoot} for inspection`);
    }
    throw error;
  } finally {
    removeSignalGuard();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    createWorktree(process.argv.slice(2));
  } catch (error) {
    console.error(`[worktree] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
