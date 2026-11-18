#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasExpandedSource } from '../lib/source-repository.mjs';
import { submoduleGitEnvironment } from './submodule-git-environment.mjs';

const assetPath = 'forgeax-engine-assets';

function verifyExport(sourceRoot, expected, checked, environment) {
  // Fetch objects only. The shared checkout and its index never change.
  checked(['-C', assetPath, 'fetch', '--no-tags', 'origin', expected], environment);
  const actual = checked(['-C', assetPath, 'rev-parse', 'FETCH_HEAD']);
  if (actual !== expected)
    throw new Error(`[assets-checkout] export pin mismatch expected=${expected} actual=${actual}`);
  checked(['-C', assetPath, 'cat-file', '-e', `${expected}^{commit}`]);
  const rows = checked(['-C', assetPath, 'ls-tree', '-rz', expected]).split('\0').filter(Boolean);
  for (const row of rows) {
    const entry = row.match(/^100(?:644|755) blob ([a-f0-9]+)\t([\s\S]+)$/);
    if (!entry) throw new Error(`[assets-checkout] unsupported exported source: ${row}`);
    const path = resolve(sourceRoot, entry[2]);
    const digest = checked(['-C', assetPath, 'hash-object', '--no-filters', path]);
    if (digest !== entry[1])
      throw new Error(
        `[assets-checkout] exported source mismatch path=${entry[2]} pin=${expected}`,
      );
  }
  return { path: assetPath, status: 'exported', expected, actual, sourceRoot: resolve(sourceRoot) };
}

export function prepareAssetsCheckout(root = process.cwd(), { sourceRoot } = {}) {
  if (sourceRoot === undefined && hasExpandedSource(root, assetPath, 'README.md'))
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
  if (sourceRoot !== undefined) return verifyExport(sourceRoot, expected, checked, environment);
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
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--source-root' || !args[1]))
      throw new Error(
        'usage: prepare-assets-checkout.mjs [--source-root <assets-export-directory>]',
      );
    const sourceRoot = args[1] === undefined ? undefined : resolve(args[1]);
    const checkout = prepareAssetsCheckout(process.cwd(), { sourceRoot });
    console.log(JSON.stringify(checkout));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
