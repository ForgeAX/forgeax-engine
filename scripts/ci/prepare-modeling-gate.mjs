import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Submodules the gate's install and build need beside packages/modeling. */
export const GATE_SUBMODULES = ['tools/view', 'third_party/wgpu', 'third_party/blitz'];

/** Exact failure text when the gate cannot run pnpm (child builds otherwise report only "failed <pkg>"). */
export const PNPM_MISSING = 'pnpm not on PATH (use corepack shim)';

/**
 * Local object sources for one submodule, most specific first: the root checkout's own
 * working copy or module directory, any other worktree's module directory, and for View
 * the separate forgeax-view clone. `--reference --dissociate` copies their objects
 * instead of downloading them, without leaving an alternate on a removable worktree.
 */
export function submoduleReferences(path, { commonDir }) {
  // A working copy is a reference through its .git; a module directory through its HEAD.
  const workingCopy = (directory) => ({ reference: directory, marker: join(directory, '.git') });
  const gitDirectory = (directory) => ({ reference: directory, marker: join(directory, 'HEAD') });
  const candidates = [
    workingCopy(join(dirname(commonDir), path)),
    gitDirectory(join(commonDir, 'modules', path)),
  ];
  const worktrees = join(commonDir, 'worktrees');
  let names = [];
  try {
    names = readdirSync(worktrees).sort();
  } catch {}
  for (const name of names) candidates.push(gitDirectory(join(worktrees, name, 'modules', path)));
  if (path === 'tools/view')
    candidates.push(workingCopy(join(dirname(dirname(commonDir)), 'forgeax-view')));
  return candidates;
}

/**
 * Initialize every missing gate submodule: the root lockfile lists tools/view as an
 * importer, so a frozen install fails with ERR_PNPM_OUTDATED_LOCKFILE without it, and
 * the Engine build needs wgpu and blitz. Returns the failure hints (empty when ready).
 */
export function ensureGateSubmodules({
  root,
  commonDir = resolve(
    root,
    spawnSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
    }).stdout.trim(),
  ),
  exists = existsSync,
  spawn = spawnSync,
} = {}) {
  const failures = [];
  for (const path of GATE_SUBMODULES) {
    if (exists(resolve(root, path, '.git'))) continue;
    const reference = submoduleReferences(path, { commonDir }).find((candidate) =>
      exists(candidate.marker),
    )?.reference;
    const args = [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      // Dissociate: another worktree's module directory may be removed later.
      ...(reference === undefined ? [] : ['--reference', reference, '--dissociate']),
      path,
    ];
    const result = spawn('git', args, { cwd: root, stdio: 'inherit' });
    if (result.status === 0 && exists(resolve(root, path, '.git'))) continue;
    failures.push(
      `the ${path} submodule is missing and could not be initialized: run git ${args.join(' ')}`,
    );
  }
  return failures;
}

/** Undefined when pnpm runs, else PNPM_MISSING. */
export function ensurePnpm({ spawn = spawnSync } = {}) {
  const result = spawn('pnpm', ['--version'], { encoding: 'utf8' });
  return result.error === undefined && result.status === 0 ? undefined : PNPM_MISSING;
}
