#!/usr/bin/env node
// pre-commit guard: if either pnpm-lock.yaml or bun.lock is staged, the other
// MUST also be staged (K-5 dual-lockfile invariant). Merge commits compare the
// index with both parents because one lock can equal first-parent HEAD while
// still carrying the other parent's lockfile closure.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const runGit = (args) => spawnSync('git', args, { encoding: 'utf8' });
const r = runGit(['diff', '--cached', '--name-only']);
if (r.status !== 0) {
  process.stderr.write(`git diff --cached failed: ${r.stderr}\n`);
  process.exit(r.status ?? 1);
}
const staged = new Set(r.stdout.split(/\r?\n/).filter(Boolean));
const pnpmStaged = staged.has('pnpm-lock.yaml');
const bunStaged = staged.has('bun.lock');

const lockfiles = ['pnpm-lock.yaml', 'bun.lock'];

function changedLockfiles(...args) {
  const result = runGit(['diff', ...args, '--name-only', '--', ...lockfiles]);
  if (result.status !== 0) return undefined;
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

const lockAffectingManifestFields = [
  'name',
  'version',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundledDependencies',
  'workspaces',
  'overrides',
  'resolutions',
  'pnpm',
  'engines',
  'os',
  'cpu',
  'libc',
];

function isPnpmManagerOnlyLockUpdate() {
  if (!pnpmStaged || bunStaged) return false;

  const changedFiles = [...staged];
  if (
    changedFiles.some(
      (path) =>
        ['.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs', 'pnpm-workspace.yaml', 'bunfig.toml'].includes(
          path,
        ) || path.startsWith('patches/'),
    )
  ) {
    return false;
  }

  let packageManagerChanged = false;
  for (const path of changedFiles.filter(
    (file) => file === 'package.json' || file.endsWith('/package.json'),
  )) {
    const previous = runGit(['show', `HEAD:${path}`]);
    const next = runGit(['show', `:${path}`]);
    if (previous.status !== 0 || next.status !== 0) return false;

    let before;
    let after;
    try {
      before = JSON.parse(previous.stdout);
      after = JSON.parse(next.stdout);
    } catch {
      return false;
    }

    if (
      lockAffectingManifestFields.some(
        (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
      )
    ) {
      return false;
    }

    if (
      path === 'package.json' &&
      before.packageManager !== after.packageManager &&
      typeof after.packageManager === 'string' &&
      after.packageManager.startsWith('pnpm@')
    ) {
      packageManagerChanged = true;
    }
  }

  return packageManagerChanged;
}

function isImmediateParentClosure(missingLockfile) {
  const parent = runGit(['rev-parse', '-q', '--verify', 'HEAD^']);
  if (parent.status !== 0) {
    return false;
  }

  const parentCommit = parent.stdout.trim();
  const parentDelta = changedLockfiles(parentCommit, 'HEAD');
  if (parentDelta === undefined || parentDelta.size !== 1 || !parentDelta.has(missingLockfile)) {
    return false;
  }

  const stagedLockfile = missingLockfile === 'pnpm-lock.yaml' ? 'bun.lock' : 'pnpm-lock.yaml';
  const stagedDelta = changedLockfiles('--cached', 'HEAD');
  if (stagedDelta === undefined || stagedDelta.size !== 1 || !stagedDelta.has(stagedLockfile)) {
    return false;
  }

  const closedDelta = changedLockfiles('--cached', parentCommit);
  return (
    closedDelta !== undefined &&
    closedDelta.size === lockfiles.length &&
    lockfiles.every((lockfile) => closedDelta.has(lockfile))
  );
}

if (pnpmStaged !== bunStaged) {
  const missingLockfile = pnpmStaged ? 'bun.lock' : 'pnpm-lock.yaml';
  if (isImmediateParentClosure(missingLockfile) || isPnpmManagerOnlyLockUpdate()) {
    process.exit(0);
  }
  let pnpmCovered = pnpmStaged;
  let bunCovered = bunStaged;
  const mergeHead = runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (mergeHead.status === 0) {
    const mergeDiff = runGit([
      'diff',
      '--cached',
      '--name-only',
      'MERGE_HEAD',
      '--',
      'pnpm-lock.yaml',
      'bun.lock',
    ]);
    if (mergeDiff.status === 0) {
      const changedAgainstMergeParent = new Set(mergeDiff.stdout.split(/\r?\n/).filter(Boolean));
      pnpmCovered ||= changedAgainstMergeParent.has('pnpm-lock.yaml');
      bunCovered ||= changedAgainstMergeParent.has('bun.lock');
    }
  }
  if (pnpmCovered && bunCovered) process.exit(0);
  const which = pnpmStaged
    ? 'pnpm-lock.yaml is staged but bun.lock is NOT'
    : 'bun.lock is staged but pnpm-lock.yaml is NOT';
  process.stderr.write(`[pre-commit] dual-lockfile drift: ${which}.\n`);
  process.stderr.write('[pre-commit] run `pnpm run sync` then stage both lockfiles together.\n');
  process.exit(1);
}
process.exit(0);
