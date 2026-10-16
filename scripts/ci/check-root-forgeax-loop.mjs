#!/usr/bin/env node
// check-root-forgeax-loop.mjs — the engine repository must not retain a root forgeax-loop tree.
// Deletions are allowed while the retired surface is drained; additions, edits, and renames fail.

import { execFileSync } from 'node:child_process';
import process from 'node:process';

export function isRootForgeaxLoopPath(value) {
  return (
    typeof value === 'string' && (value === 'forgeax-loop' || value.startsWith('forgeax-loop/'))
  );
}

export function rootForgeaxLoopPolicyViolations(files) {
  return (Array.isArray(files) ? files : [])
    .filter((file) => {
      const currentPath = typeof file === 'string' ? file : file?.filename;
      const previousPath =
        typeof file === 'object' && file !== null ? file.previous_filename : null;
      const touchesRootForgeaxLoop =
        isRootForgeaxLoopPath(currentPath) || isRootForgeaxLoopPath(previousPath);
      if (!touchesRootForgeaxLoop) return false;
      return typeof file === 'string' || file?.status !== 'removed';
    })
    .map((file) => {
      if (typeof file === 'string') return { filename: file, status: 'present' };
      return {
        filename: file?.filename ?? '<unknown>',
        previousFilename: file?.previous_filename,
        status: file?.status ?? '<unknown>',
      };
    });
}

export function trackedRootForgeaxLoop(root = process.cwd()) {
  const indexTree = execFileSync('git', ['-C', root, 'write-tree'], { encoding: 'utf8' }).trim();
  const output = execFileSync(
    'git',
    ['-C', root, 'ls-tree', '-r', '--name-only', indexTree, '--', 'forgeax-loop'],
    { encoding: 'utf8' },
  );
  return output
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
}

export function assertNoTrackedRootForgeaxLoop(root = process.cwd()) {
  const violations = rootForgeaxLoopPolicyViolations(trackedRootForgeaxLoop(root));
  if (violations.length > 0) {
    const files = violations.map((file) => file.filename).join(', ');
    throw new Error(
      `root forgeax-loop is forbidden; remove tracked forgeax-loop/** files: ${files}`,
    );
  }
  return violations;
}

function main() {
  try {
    assertNoTrackedRootForgeaxLoop();
    console.log('[ok] root-forgeax-loop-policy: no tracked root forgeax-loop files');
  } catch (error) {
    console.error(`[reason] root-forgeax-loop-forbidden: ${error.message ?? error}`);
    console.error('[hint] keep harness-managed state outside the engine repository root');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
