#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
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

export function cleanRetiredModelingSubmoduleCheckout(root = process.cwd(), env = process.env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    !env.GITHUB_WORKSPACE ||
    resolve(env.GITHUB_WORKSPACE) !== resolve(root)
  )
    return false;

  const repository = git(root, ['rev-parse', '--show-toplevel']);
  if (repository.status !== 0 || resolve(repository.stdout.trim()) !== resolve(root)) return false;

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
