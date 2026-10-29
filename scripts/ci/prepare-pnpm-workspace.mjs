#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pnpmCommand } from '../lib/pnpm-command.mjs';
import { hasExpandedSource } from '../lib/source-repository.mjs';

const viewPath = 'tools/view';
const retiredModelingSubmodulePath = 'packages/modeling';

const git = (cwd, args) =>
  spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

function isCurrentActionsWorkspace(root, env = process.env) {
  const workspace = env.GITHUB_WORKSPACE;
  return (
    env.GITHUB_ACTIONS === 'true' &&
    workspace !== undefined &&
    existsSync(workspace) &&
    realpathSync(workspace) === realpathSync(root)
  );
}

export function cleanRetiredModelingSubmoduleCheckout(root = process.cwd(), env = process.env) {
  if (!isCurrentActionsWorkspace(root, env)) return false;

  const repository = git(root, ['rev-parse', '--show-toplevel']);
  if (repository.status !== 0 || realpathSync(repository.stdout.trim()) !== realpathSync(root))
    return false;

  const tracked = git(root, ['ls-files', '--error-unmatch', retiredModelingSubmodulePath]);
  if (tracked.status === 0) return false;

  const checkout = resolve(root, retiredModelingSubmodulePath);
  if (!existsSync(checkout)) return false;

  rmSync(checkout, { recursive: true, force: true });
  const configured = git(root, [
    'config',
    '--local',
    '--get',
    `submodule.${retiredModelingSubmodulePath}.url`,
  ]);
  if (configured.status === 0)
    git(root, [
      'config',
      '--local',
      '--remove-section',
      `submodule.${retiredModelingSubmodulePath}`,
    ]);
  return true;
}

function inside(parent, path) {
  const child = relative(parent, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function pruneRetiredWorkspaceSubmodules(root) {
  if (!isCurrentActionsWorkspace(root)) return;
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) return;
  const modules = git(root, ['rev-parse', '--git-path', 'modules']);
  if (modules.status !== 0) return;
  const directory = resolve(root, modules.stdout.trim());
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.status !== 0) return;
  const candidates = untracked.stdout
    .split('\0')
    .filter(
      (path) =>
        path.endsWith('/') &&
        existsSync(resolve(root, path, 'package.json')) &&
        existsSync(resolve(root, path, '.git')),
    );
  if (candidates.length === 0) return;
  const history = git(root, ['reflog', '--format=%H', 'HEAD']);
  if (history.status !== 0) return;
  const revisions = [...new Set(history.stdout.trim().split('\n').filter(Boolean))];
  const realRoot = realpathSync(root);
  const realModules = existsSync(directory) ? realpathSync(directory) : undefined;
  for (const candidate of candidates) {
    const checkout = resolve(root, candidate);
    if (
      !inside(root, checkout) ||
      lstatSync(checkout).isSymbolicLink() ||
      !inside(realRoot, realpathSync(checkout))
    )
      continue;
    const path = relative(root, checkout);
    const tracked = git(root, ['ls-tree', 'HEAD', '--', path]);
    if (tracked.status !== 0 || tracked.stdout.trim()) continue;
    const actual = git(checkout, ['rev-parse', '--absolute-git-dir']);
    const checkoutTop = git(checkout, ['rev-parse', '--show-toplevel']);
    const checkoutHead = git(checkout, ['rev-parse', 'HEAD']);
    if (
      actual.status !== 0 ||
      checkoutTop.status !== 0 ||
      checkoutHead.status !== 0 ||
      realpathSync(checkoutTop.stdout.trim()) !== realpathSync(checkout)
    )
      continue;
    const metadata = realpathSync(actual.stdout.trim());
    const embedded = resolve(checkout, '.git');
    const ownedMetadata =
      (realModules !== undefined && inside(realModules, metadata)) ||
      (lstatSync(embedded).isDirectory() &&
        !lstatSync(embedded).isSymbolicLink() &&
        metadata === realpathSync(embedded));
    if (!ownedMetadata) continue;
    const retiredPin = revisions.some((revision) => {
      const previous = git(root, ['ls-tree', revision, '--', path]);
      return (
        previous.status === 0 &&
        previous.stdout.startsWith(`160000 commit ${checkoutHead.stdout.trim()}\t`)
      );
    });
    if (!retiredPin) continue;
    // Checkout cleans before switching commits, leaving formerly tracked submodules behind.
    rmSync(checkout, { recursive: true, force: true });
    console.error(`[pnpm-workspace] removed retired workspace submodule path=${path}`);
  }
}

export function preparePnpmWorkspace(root = process.cwd()) {
  if (cleanRetiredModelingSubmoduleCheckout(root))
    console.error('[pnpm-workspace] removed stale retired submodule path=packages/modeling');
  if (hasExpandedSource(root, viewPath, 'package.json'))
    return { path: viewPath, status: 'expanded' };
  const pin = git(root, ['rev-parse', `HEAD:${viewPath}`]);
  if (pin.status !== 0) {
    throw new Error(
      `[pnpm-workspace] unable to resolve the pinned workspace source path=${viewPath} detail=${(pin.stderr || pin.error?.message || 'git failed').trim()}`,
    );
  }
  const expected = pin.stdout.trim();
  pruneRetiredWorkspaceSubmodules(root);
  const absoluteViewPath = resolve(root, viewPath);
  if (!existsSync(absoluteViewPath)) return { path: viewPath, status: 'absent', expected };

  const checkout = git(absoluteViewPath, ['rev-parse', 'HEAD']);
  const actual = checkout.status === 0 ? checkout.stdout.trim() : undefined;
  if (actual === expected) return { path: viewPath, status: 'pinned', expected, actual };

  rmSync(absoluteViewPath, { recursive: true, force: true });
  return {
    path: viewPath,
    status: 'removed-stale-checkout',
    expected,
    actual: actual ?? null,
  };
}

export function installPnpmWorkspace(root = process.cwd()) {
  const [command, ...prefix] = pnpmCommand();
  return spawnSync(command, [...prefix, 'install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: root,
    stdio: 'inherit',
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--install'))
      throw new Error('expected --install or no arguments');
    console.log(JSON.stringify(preparePnpmWorkspace()));
    if (process.argv.includes('--install')) {
      const result = installPnpmWorkspace();
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
