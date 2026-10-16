#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasExpandedSource } from '../lib/source-repository.mjs';
import { submoduleGitEnvironment } from './submodule-git-environment.mjs';

const assetPath = 'forgeax-engine-assets';

export function prepareAssetsCheckout(root = process.cwd()) {
  if (hasExpandedSource(root, assetPath, 'README.md'))
    return { path: assetPath, status: 'expanded' };
  const run = (args, env = process.env) =>
    spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
    });
  const checked = (args, env) => {
    const result = run(args, env);
    if (result.status !== 0) {
      throw new Error(
        `[assets-checkout] phase=${args[0]} path=${assetPath} exit=${result.status} signal=${result.signal ?? 'none'} detail=${(result.stderr || result.error?.message || result.stdout).trim()} hint=repair the pinned assets checkout and rerun this producer`,
      );
    }
    return result.stdout.trim();
  };
  const head = checked(['rev-parse', 'HEAD']);
  if (process.env.EXPECTED_PRODUCT_SHA && process.env.EXPECTED_PRODUCT_SHA !== head) {
    throw new Error(
      `[assets-checkout] product mismatch expected=${process.env.EXPECTED_PRODUCT_SHA} actual=${head}`,
    );
  }
  const pin = checked(['ls-tree', 'HEAD', '--', assetPath]).match(
    /^160000 commit ([a-f0-9]{40})\t/,
  );
  if (!pin)
    throw new Error(
      `[assets-checkout] missing gitlink path=${assetPath} hint=use a contributor checkout with its tracked asset pin`,
    );
  const expected = pin[1];
  let repaired = false;
  const environment = submoduleGitEnvironment(root, assetPath);
  const initialized = existsSync(resolve(root, assetPath, '.git'));
  const ownedDirectory = resolve(
    root,
    checked(['rev-parse', '--git-path', `modules/${assetPath}`]),
  );
  if (initialized) {
    const gitDirectory = checked(['-C', assetPath, 'rev-parse', '--absolute-git-dir']);
    if (resolve(gitDirectory) !== ownedDirectory) {
      throw new Error(
        `[assets-checkout] refusing foreign submodule Git directory path=${assetPath} hint=restore the checkout-owned submodule metadata`,
      );
    }
  }
  // Actions assigns this workspace exclusively to the current job. A fetch
  // interrupted in an earlier job can leave shallow.lock in retained submodule
  // metadata. Preserve local/current-job locks and foreign Git directories.
  if (
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.GITHUB_WORKSPACE &&
    resolve(process.env.GITHUB_WORKSPACE) === resolve(root)
  ) {
    const lock = resolve(ownedDirectory, 'shallow.lock');
    const checkoutTime = Math.max(
      ...['HEAD', 'FETCH_HEAD']
        .map((name) => resolve(root, checked(['rev-parse', '--git-path', name])))
        .filter(existsSync)
        .map((path) => statSync(path).mtimeMs),
    );
    if (existsSync(lock) && statSync(lock).mtimeMs < checkoutTime) {
      rmSync(lock);
      repaired = true;
      console.error(`[assets-checkout] removed pre-checkout shallow.lock path=${assetPath}`);
    }
  }
  checked(['submodule', 'sync', '--recursive', '--', assetPath], environment);
  if (initialized && run(['-C', assetPath, 'rev-parse', '--verify', 'HEAD']).status !== 0) {
    if (run(['-C', assetPath, 'cat-file', '-e', `${expected}^{commit}`]).status !== 0) {
      checked(
        ['-C', assetPath, 'fetch', '--no-tags', '--depth=1', 'origin', expected],
        environment,
      );
      checked(['-C', assetPath, 'cat-file', '-e', `${expected}^{commit}`]);
    }
    checked(['-C', assetPath, 'update-ref', '--no-deref', 'HEAD', expected]);
    repaired = true;
    console.error(
      `[assets-checkout] recovered broken HEAD path=${assetPath} expected=${expected}; retained the object cache and will force checkout of the pinned files`,
    );
  }
  checked(
    ['submodule', 'update', '--init', '--force', '--depth=1', '--recursive', '--', assetPath],
    environment,
  );
  const actual = checked(['-C', assetPath, 'rev-parse', 'HEAD']);
  if (actual !== expected)
    throw new Error(`[assets-checkout] pin mismatch expected=${expected} actual=${actual}`);
  return { path: assetPath, expected, actual, repaired };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(prepareAssetsCheckout()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
