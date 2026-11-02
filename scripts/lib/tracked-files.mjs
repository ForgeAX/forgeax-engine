import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Required source submodules are Engine source: repository gates driven by
 * `git ls-files` scan their tracked files too. Vendored third-party and asset
 * submodules stay outside this list.
 */
export const REQUIRED_SOURCE_SUBMODULES = ['packages/modeling'];

const MAX_BUFFER = 64 * 1024 * 1024;

function listOne(cwd, args) {
  return execFileSync('git', ['-C', cwd, 'ls-files', ...args, '-z'], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  })
    .split('\0')
    .filter(Boolean);
}

/**
 * `git ls-files <args>` of the checkout followed by the same listing of every
 * initialized required source submodule, all relative to `root`. With `--stage`
 * the path after the tab is prefixed. The gitlink entry itself stays in the root
 * listing (mode 160000), so callers that skip non-regular modes are unaffected.
 */
export function listTrackedFiles(root, args = []) {
  const entries = listOne(root, args);
  for (const submodule of REQUIRED_SOURCE_SUBMODULES) {
    // An uninitialized submodule directory would resolve to the parent repository.
    if (!existsSync(join(root, submodule, '.git'))) continue;
    for (const entry of listOne(join(root, submodule), args)) {
      const tab = entry.indexOf('\t');
      entries.push(
        tab === -1
          ? `${submodule}/${entry}`
          : `${entry.slice(0, tab + 1)}${submodule}/${entry.slice(tab + 1)}`,
      );
    }
  }
  return entries;
}

// CLI for non-Node gates: `node scripts/lib/tracked-files.mjs [--root <dir>] [ls-files args]`
// prints the NUL-separated listing.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex === -1 ? process.cwd() : resolve(args[rootIndex + 1] ?? '.');
  if (rootIndex !== -1) args.splice(rootIndex, 2);
  process.stdout.write(
    listTrackedFiles(root, args)
      .map((entry) => `${entry}\0`)
      .join(''),
  );
}
